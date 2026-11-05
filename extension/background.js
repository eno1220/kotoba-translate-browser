/* global browser, Kotoba */
const K = Kotoba;
const queue = new K.Queue(1); // Shared by every tab and by /tokenize requests.
const jobs = new Map();
function documentURL(value) { const url = new URL(value); url.hash = ""; return url.href; }

async function getSettings() {
  const { settings } = await browser.storage.local.get("settings");
  const value = K.settings(settings);
  queue.setLimit(value.concurrency);
  return value;
}
function abortTab(tabId, frameId) {
  for (const job of jobs.values()) {
    if (job.tabId === tabId && (frameId === undefined || job.frameId === frameId)) job.controller.abort();
  }
}
async function post(s, url, data, signal) {
  return queue.run(async () => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, s.timeoutSeconds * 1000);
    try {
      if (signal.aborted) throw new DOMException("キャンセルしました。", "AbortError");
      const response = await fetch(url, {
        method: "POST", redirect: "error", credentials: "omit", cache: "no-store",
        headers: { "Content-Type": "application/json", ...(s.apiKey ? { Authorization: `Bearer ${s.apiKey.replace(/^Bearer\s+/i, "").trim()}` } : {}) },
        body: JSON.stringify(data), signal: controller.signal
      });
      if (!response.ok) throw new Error(`翻訳サーバ: HTTP ${response.status}。接続設定・モデル名・API形式を確認してください。`);
      return await response.json();
    } catch (error) {
      if (signal.aborted) throw new Error("キャンセルしました。");
      if (controller.signal.aborted) throw new Error(`応答が${s.timeoutSeconds}秒以内に完了しませんでした。`);
      if (error instanceof TypeError) throw new Error("翻訳サーバに接続できません。URL・ポート・サーバの起動状態を確認してください。");
      throw error;
    } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
  }, signal);
}
function counter(s, signal) {
  if (s.tokenizer === "bytes") return K.byteTokens;
  return async text => {
    const data = s.tokenizer === "llama" ? { content: text, add_special: false } : { model: s.model, prompt: text, add_special_tokens: false };
    const result = await post(s, K.endpoint(s, s.tokenizePath), data, signal);
    const count = Array.isArray(result.tokens) ? result.tokens.length : result.count;
    if (!Number.isInteger(count) || count < 0) throw new Error("/tokenizeの応答が不正です。tokenizer設定を確認してください。");
    return count;
  };
}
async function generate(s, text, page, signal) {
  const result = await post(s, K.endpoint(s), K.body(s, text, page), signal);
  const choice = result.choices?.[0];
  if (choice?.finish_reason === "length") return { truncated: true };
  if (choice?.finish_reason && !["stop", "eos"].includes(choice.finish_reason)) throw new Error(`翻訳が完了しませんでした (${choice.finish_reason})。`);
  const output = choice?.message?.content;
  if (typeof output !== "string" || !output.trim()) throw new Error("翻訳サーバが空または不正な応答を返しました。");
  return { text: output.trim() };
}
async function translatePlain(s, text, page, signal, count, limit = s.inputTokens, depth = 0, advance = () => {}) {
  if (!text.trim()) { advance(text.length); return text; }
  const chunks = await K.split(text, limit, count);
  const result = [];
  for (const chunk of chunks) {
    if (!chunk.trim()) { result.push(chunk); advance(chunk.length); continue; }
    const leading = chunk.match(/^\s*/u)[0], trailing = chunk.match(/\s*$/u)[0];
    const translated = await generate(s, chunk.trim(), page, signal);
    if (translated.truncated) {
      if (depth >= 5 || Array.from(chunk.trim()).length < 2) throw new Error("短い文章でも生成上限に達しました。モデル・サーバの設定を確認してください。");
      const smaller = Math.max(1, Math.min(Math.floor(limit / 2), Math.floor(await count(chunk) / 2)));
      result.push(await translatePlain(s, chunk, page, signal, count, smaller, depth + 1, advance));
    } else { result.push(leading + translated.text + trailing); advance(chunk.length); }
  }
  // Keep explicit original whitespace. If a forced boundary had no whitespace,
  // insert a separator for languages whose words are separated by spaces.
  return result.map((part, i) => i && !["ja", "zh-hans", "zh-hant", "th", "km", "my"].includes(page.target) && !/\s$/.test(result[i - 1]) && !/^\s|^[,.;:!?、。]/.test(part) ? " " + part : part).join("");
}
async function translateDocument(s, document, page, signal, advance, limit = s.inputTokens, depth = 0) {
  const count = counter(s, signal);
  const chunks = await K.splitDocument(document, limit, count);
  const translated = [];
  for (const chunk of chunks) {
    if (!K.documentLength(chunk) || !/\p{L}/u.test(K.documentText(chunk))) {
      translated.push(chunk); advance(K.documentLength(chunk)); continue;
    }
    if (chunk.every(node => node.text !== undefined)) {
      const text = await translatePlain(s, K.documentText(chunk), page, signal, count, limit, depth, advance);
      translated.push([{ text }]);
      continue;
    }
    let accepted = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const output = await generate(s, K.serializeDocument(chunk), { ...page, html: true, retry: attempt > 0 }, signal);
      if (output.truncated) {
        if (depth >= 5) break;
        accepted = await translateDocument(s, chunk, page, signal, advance, Math.max(64, Math.floor(limit / 2)), depth + 1);
        break;
      }
      try { accepted = K.parseDocument(output.text, chunk); }
      catch { continue; }
      advance(K.documentLength(chunk));
      break;
    }
    if (!accepted) {
      const error = new Error("リンク・書式を保持できなかった段落は原文のままにしています。再試行してください。");
      error.code = "structure";
      throw error;
    }
    translated.push(accepted);
  }
  const merged = K.mergeDocuments(translated);
  // Repeated wrappers from long-text chunks must form one coherent DOM tree.
  try { return K.parseDocument(K.serializeDocument(merged), document); }
  catch {
    const error = new Error("翻訳結果のリンク構造が一致しないため、原文を保持しました。");
    error.code = "structure"; throw error;
  }
}
async function translate(message, sender) {
  if (!sender.tab) throw new Error("翻訳対象が不正です。");
  if (message.protocol !== K.CONTENT_PROTOCOL) throw staleContent();
  const document = message.document;
  if (document !== undefined) {
    if (!Array.isArray(document) || !document.length) throw new Error("ページ翻訳の本文データが不正です。");
    if (K.serializeDocument(document).length > 2000000) throw new Error("翻訳対象の段落が200万文字を超えています。");
    K.parseDocument(K.serializeDocument(document), document);
  } else {
    if (!Array.isArray(message.parts) || message.parts.length !== 1 || typeof message.parts[0] !== "string") throw new Error("選択翻訳の本文データが不正です。");
    if (message.parts[0].length > 2000000) throw new Error("選択範囲が200万文字を超えています。");
  }
  const pageURL = new URL(sender.url);
  if (!/^https?:$/.test(pageURL.protocol)) throw new Error("このページでは翻訳できません。");
  K.languages(message.source, message.target);
  const job = { tabId: sender.tab.id, frameId: sender.frameId, pageURL: documentURL(sender.tab.url || sender.url), controller: new AbortController() };
  const id = Symbol(); jobs.set(id, job);
  let completed = 0;
  const total = document ? K.documentLength(document) : message.parts[0].length;
  const advance = amount => {
    completed += amount;
    if (typeof message.requestId === "string" && message.requestId.length < 100 && !job.controller.signal.aborted) {
      browser.tabs.sendMessage(job.tabId, { type: "translationProgress", requestId: message.requestId, completed, total }, { frameId: job.frameId }).catch(() => {});
    }
  };
  try {
    const s = await getSettings();
    const page = { source: message.source, target: message.target, domain: pageURL.origin };
    if (document) return { document: await translateDocument(s, document, page, job.controller.signal, advance) };
    return { parts: [await translatePlain(s, message.parts[0], page, job.controller.signal, counter(s, job.controller.signal), s.inputTokens, 0, advance)] };
  } finally { jobs.delete(id); }
}
function staleContent() {
  const error = new Error("ページに古い翻訳スクリプトが残っています。ページを再読み込みしてください。");
  error.code = "stale_content";
  return error;
}
async function ensureContent(tabId, frameId = 0) {
  let response;
  try { response = await browser.tabs.sendMessage(tabId, { type: "ping" }, { frameId }); }
  catch {
    await browser.tabs.executeScript(tabId, { file: "content.js", frameId, runAt: "document_idle" });
    response = await browser.tabs.sendMessage(tabId, { type: "ping" }, { frameId });
  }
  if (response?.protocol !== K.CONTENT_PROTOCOL) throw staleContent();
}
async function handle(message, sender) {
  if (sender.id !== browser.runtime.id) throw new Error("不正な送信元です。");
  if (message.type === "translate") return translate(message, sender);
  if (message.type === "cancel") {
    if (sender.tab) abortTab(sender.tab.id, sender.frameId);
    return {};
  }
  if (message.type === "contentPreferences" && sender.tab) {
    const s = await getSettings();
    return { concurrency: s.concurrency };
  }
  if (sender.tab) throw new Error("許可されていない操作です。");
  if (message.type === "preferences") {
    const s = await getSettings();
    return { source: s.source, target: s.target, concurrency: s.concurrency };
  }
  if (message.type === "page") {
    await ensureContent(message.tabId);
    return browser.tabs.sendMessage(message.tabId, { type: message.action, source: message.source, target: message.target, hoverEnabled: message.hoverEnabled }, { frameId: 0 });
  }
  throw new Error("不明な操作です。");
}
browser.runtime.onMessage.addListener((message, sender) => handle(message, sender).catch(error => ({ error: error.message, errorCode: error.code })));
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) {
    try { queue.setLimit(K.settings(changes.settings.newValue).concurrency); } catch { /* Options validate on save. */ }
  }
});
browser.tabs.onRemoved.addListener(tabId => abortTab(tabId));
browser.tabs.onUpdated.addListener((tabId, change) => {
  // Firefox also emits updates for history.replaceState and fragment navigation.
  // Full document unloads cancel through content.js's pagehide handler.
  if (!change.url) return;
  const next = documentURL(change.url);
  for (const job of jobs.values()) if (job.tabId === tabId && job.pageURL !== next) job.controller.abort();
});
browser.contextMenus.create({ id: "kotoba-selection", title: "選択したテキストを翻訳", contexts: ["selection"], documentUrlPatterns: ["http://*/*", "https://*/*"] });
browser.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "kotoba-selection") return;
  try {
    await ensureContent(tab.id, info.frameId || 0);
    const s = await getSettings();
    await browser.tabs.sendMessage(tab.id, { type: "selection", text: info.selectionText, defaults: { source: s.source, target: s.target }, concurrency: s.concurrency }, { frameId: info.frameId || 0 });
  } catch (error) {
    // Firefox's restricted pages reject injection. Keep a visible indication.
    await browser.browserAction.setBadgeText({ tabId: tab.id, text: "!" });
    await browser.browserAction.setTitle({ tabId: tab.id, title: `Kotoba: ${error.message}` });
  }
});
