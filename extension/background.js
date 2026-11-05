/* global browser, Kotoba */
const K = Kotoba;
const queue = new K.Queue(1); // Shared by every tab and by /tokenize requests.
const jobs = new Map();

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
async function translateParts(s, parts, page, signal, protectedParts = [], advance = () => {}) {
  if (parts.every((_, i) => protectedParts[i])) return parts;
  const count = counter(s, signal);
  if (parts.length === 1) return [await translatePlain(s, parts[0], page, signal, count, s.inputTokens, 0, advance)];
  const source = K.serialize(parts, protectedParts);
  if (await count(source) <= s.inputTokens) {
    const translated = await generate(s, source, page, signal);
    if (!translated.truncated) {
      try {
        const parsed = K.parse(translated.text, parts.length, protectedParts);
        if (parsed.some((text, i) => protectedParts[i] && text !== parts[i])) throw new Error("保護したコードが変化しました。");
        advance(parts.reduce((sum, text, i) => sum + (protectedParts[i] ? 0 : text.length), 0));
        return parsed.map((text, i) => protectedParts[i] ? parts[i] : parts[i].match(/^\s*/u)[0] + text.trim() + parts[i].match(/\s*$/u)[0]);
      } catch { /* The model did not preserve markers: translate leaves safely. */ }
    }
  }
  // Split at DOM boundaries, keeping adjacent inline text together when it fits.
  // A single oversized leaf is split at sentence/word/code-point boundaries.
  if (parts.length > 1) {
    const middle = Math.ceil(parts.length / 2);
    return [
      ...await translateParts(s, parts.slice(0, middle), page, signal, protectedParts.slice(0, middle), advance),
      ...await translateParts(s, parts.slice(middle), page, signal, protectedParts.slice(middle), advance)
    ];
  }
}
async function translate(message, sender) {
  if (!sender.tab || !Array.isArray(message.parts) || !message.parts.length || message.parts.length > 1000 || message.parts.some(x => typeof x !== "string") || message.parts.join("").length > 2000000) throw new Error("翻訳対象が不正または大きすぎます。");
  if (message.protectedParts && (!Array.isArray(message.protectedParts) || message.protectedParts.length !== message.parts.length || message.protectedParts.some(x => typeof x !== "boolean"))) throw new Error("保護対象が不正です。");
  const pageURL = new URL(sender.url);
  if (!/^https?:$/.test(pageURL.protocol)) throw new Error("このページでは翻訳できません。");
  K.languages(message.source, message.target);
  const job = { tabId: sender.tab.id, frameId: sender.frameId, controller: new AbortController() };
  const id = Symbol(); jobs.set(id, job);
  let completed = 0;
  const total = message.parts.reduce((sum, text, i) => sum + (message.protectedParts?.[i] ? 0 : text.length), 0);
  const advance = amount => {
    completed += amount;
    if (typeof message.requestId === "string" && message.requestId.length < 100 && !job.controller.signal.aborted) {
      browser.tabs.sendMessage(job.tabId, { type: "translationProgress", requestId: message.requestId, completed, total }, { frameId: job.frameId }).catch(() => {});
    }
  };
  try {
    const s = await getSettings();
    const parts = await translateParts(s, message.parts, { source: message.source, target: message.target, domain: pageURL.origin }, job.controller.signal, message.protectedParts, advance);
    return { parts };
  } finally { jobs.delete(id); }
}
async function ensureContent(tabId, frameId = 0) {
  try { await browser.tabs.sendMessage(tabId, { type: "ping" }, { frameId }); }
  catch {
    await browser.tabs.executeScript(tabId, { file: "content.js", frameId, runAt: "document_idle" });
  }
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
browser.runtime.onMessage.addListener((message, sender) => handle(message, sender).catch(error => ({ error: error.message })));
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) {
    try { queue.setLimit(K.settings(changes.settings.newValue).concurrency); } catch { /* Options validate on save. */ }
  }
});
browser.tabs.onRemoved.addListener(tabId => abortTab(tabId));
browser.tabs.onUpdated.addListener((tabId, change) => { if (change.status === "loading" || change.url) abortTab(tabId); });
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
