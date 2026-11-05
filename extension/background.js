/* global browser, Kotoba */
const K = Kotoba;
const queue = new K.Queue(1); // Shared by every tab and by /tokenize requests.
const jobs = new Map();
function documentURL(value) { const url = new URL(value); url.hash = ""; return url.href; }

// Session-only, bounded paragraph cache. Never store credentials or page text on disk.
const translationCache = new Map();
const CACHE_BYTES = 8 * 1024 * 1024, CACHE_ENTRIES = 2000;
let cacheBytes = 0, cacheRevision = 0;
function clearCache() { translationCache.clear(); cacheBytes = 0; cacheRevision++; }
function removeCached(key) {
  cacheBytes -= translationCache.get(key).size; translationCache.delete(key);
}
function pruneCache() {
  const now = Date.now();
  for (const [key, entry] of translationCache) if (entry.expiresAt <= now) removeCached(key);
}
setInterval(pruneCache, 60000);
function cacheSignature(s) {
  return JSON.stringify([K.endpoint(s), s.apiKey, s.model, s.apiFormat, s.form, s.inputTokens, s.tokenizer, s.tokenizePath, s.batchTranslation]);
}
function cacheKey(url, source, target, input) { return JSON.stringify([url, source, target, input]); }
function cachedParagraph(s, url, source, target, document) {
  pruneCache();
  const input = JSON.stringify(document), key = cacheKey(url, source, target, input);
  const entry = translationCache.get(key);
  if (!entry || entry.signature !== cacheSignature(s)) return null;
  // Validate cached output against the current paragraph as well as the original response.
  const result = K.parseDocument(K.serializeDocument(entry.document), document);
  translationCache.delete(key); translationCache.set(key, entry);
  return result;
}
function cacheParagraph(s, url, source, target, original, document) {
  const input = JSON.stringify(original), key = cacheKey(url, source, target, input);
  const signature = cacheSignature(s);
  const size = 2 * (key.length + input.length + JSON.stringify(document).length + signature.length + url.length + source.length + target.length);
  if (size > CACHE_BYTES) return;
  pruneCache();
  if (translationCache.has(key)) removeCached(key);
  while (cacheBytes + size > CACHE_BYTES || translationCache.size >= CACHE_ENTRIES) removeCached(translationCache.keys().next().value);
  translationCache.set(key, { url, source, target, input, document, signature, expiresAt: Date.now() + s.cacheMinutes * 60000, size });
  cacheBytes += size;
}
async function restoreCachedPage(sender) {
  if (!sender.tab || sender.frameId !== 0 || sender.tab.incognito) return {};
  const revision = cacheRevision;
  const s = await getSettings();
  if (!s.cacheMinutes) return {};
  const url = documentURL(sender.url), signature = cacheSignature(s);
  pruneCache();
  const entries = [...translationCache.values()].filter(entry => entry.url === url && entry.signature === signature);
  const last = entries.at(-1);
  if (!last) return {};
  await ensureContent(sender.tab.id);
  if (revision !== cacheRevision) return {};
  return browser.tabs.sendMessage(sender.tab.id, {
    type: "restoreCache", url, source: last.source, target: last.target,
    entries: entries.filter(entry => entry.source === last.source && entry.target === last.target).map(({ input, document }) => ({ input, document }))
  }, { frameId: 0 });
}

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
// Each marker scopes inline IDs to its own paragraph, so IDs can repeat across items.
function serializeBatch(documents) {
  return documents.map((document, i) => `<kotoba-item id="b${i}">${K.serializeDocument(document)}</kotoba-item>`).join("\n");
}
function parseBatch(text, documents) {
  const parsed = new DOMParser().parseFromString(`<batch>${text}</batch>`, "application/xml");
  if (parsed.querySelector("parsererror")) throw new Error("Invalid batch XML");
  const result = new Array(documents.length);
  for (const node of parsed.documentElement.childNodes) {
    if (node.nodeType === 3 && !node.data.trim()) continue;
    const id = node.nodeType === 1 && node.getAttribute("id");
    if (node.nodeName !== "kotoba-item" || !/^b\d+$/.test(id) || node.attributes.length !== 1) throw new Error("Invalid batch marker");
    const index = Number(id.slice(1));
    if (id !== `b${index}` || index >= documents.length || result[index]) throw new Error("Duplicate or unknown batch marker");
    result[index] = { document: K.parseDocument(node.innerHTML, documents[index]) };
  }
  if (result.filter(Boolean).length !== documents.length) throw new Error("Missing batch marker");
  return result;
}
async function translateDocuments(s, documents, page, signal, advance) {
  const count = counter(s, signal), results = [];
  async function flush(batch) {
    if (signal.aborted) throw new DOMException("キャンセルしました。", "AbortError");
    if (batch.length > 1) {
      const output = await generate(s, serializeBatch(batch), { ...page, html: true, batch: true }, signal);
      if (!output.truncated) {
        let accepted;
        try { accepted = parseBatch(output.text, batch); } catch { /* Retry whole paragraphs below. */ }
        if (accepted) {
          results.push(...accepted);
          advance(batch.reduce((sum, document) => sum + K.documentLength(document), 0));
          return;
        }
      }
    }
    for (const document of batch) {
      try { results.push({ document: await translateDocument(s, document, page, signal, advance) }); }
      catch (error) {
        if (error.code !== "structure") throw error;
        results.push({ error: error.message, errorCode: error.code });
      }
    }
  }
  let batch = [];
  for (const document of documents) {
    if (batch.length && (!s.batchTranslation || await count(serializeBatch([...batch, document])) > s.inputTokens)) {
      await flush(batch); batch = [];
    }
    batch.push(document);
  }
  if (batch.length) await flush(batch);
  return results;
}
async function translate(message, sender) {
  if (!sender.tab) throw new Error("翻訳対象が不正です。");
  if (message.protocol !== K.CONTENT_PROTOCOL) throw staleContent();
  const document = message.document;
  const documents = message.documents;
  if (documents !== undefined && (!Array.isArray(documents) || !documents.length || documents.length > 16)) throw new Error("翻訳の段落数が不正です。");
  const inputs = documents || (document !== undefined ? [document] : null);
  if (inputs) {
    for (const document of inputs) {
      if (!Array.isArray(document) || !document.length) throw new Error("ページ翻訳の本文データが不正です。");
      if (K.serializeDocument(document).length > 2000000) throw new Error("翻訳対象の段落が200万文字を超えています。");
      K.parseDocument(K.serializeDocument(document), document);
    }
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
  const total = inputs ? inputs.reduce((sum, document) => sum + K.documentLength(document), 0) : message.parts[0].length;
  const advance = amount => {
    completed += amount;
    if (typeof message.requestId === "string" && message.requestId.length < 100 && !job.controller.signal.aborted) {
      browser.tabs.sendMessage(job.tabId, { type: "translationProgress", requestId: message.requestId, completed, total }, { frameId: job.frameId }).catch(() => {});
    }
  };
  try {
    const revision = cacheRevision;
    const s = await getSettings();
    const page = { source: message.source, target: message.target, domain: pageURL.origin };
    if (inputs) {
      const useCache = s.cacheMinutes > 0 && !sender.tab.incognito;
      const url = documentURL(sender.url);
      const results = inputs.map(input => {
        const hit = useCache && cachedParagraph(s, url, page.source, page.target, input);
        if (hit) advance(K.documentLength(input));
        return hit ? { document: hit } : null;
      });
      const missing = inputs.filter((_, index) => !results[index]);
      if (missing.length) {
        const fresh = documents ? await translateDocuments(s, missing, page, job.controller.signal, advance) : [{ document: await translateDocument(s, document, page, job.controller.signal, advance) }];
        if (job.controller.signal.aborted) throw new DOMException("キャンセルしました。", "AbortError");
        let cursor = 0;
        for (let i = 0; i < inputs.length; i++) if (!results[i]) {
          results[i] = fresh[cursor++];
          if (useCache && revision === cacheRevision && results[i].document) cacheParagraph(s, url, page.source, page.target, inputs[i], results[i].document);
        }
      }
      return documents ? { documents: results } : results[0];
    }
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
  if (message.type === "restoreCachedPage") return restoreCachedPage(sender);
  if (message.type === "cancel") {
    if (sender.tab) abortTab(sender.tab.id, sender.frameId);
    return {};
  }
  if (message.type === "contentPreferences" && sender.tab) {
    const s = await getSettings();
    return { concurrency: s.concurrency, batchTranslation: s.batchTranslation };
  }
  if (sender.tab) throw new Error("許可されていない操作です。");
  if (message.type === "clearCache") { clearCache(); return {}; }
  if (message.type === "preferences") {
    const s = await getSettings();
    return { source: s.source, target: s.target, concurrency: s.concurrency, batchTranslation: s.batchTranslation };
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
    clearCache();
    try { queue.setLimit(K.settings(changes.settings.newValue).concurrency); } catch { /* Options validate on save. */ }
  }
});
browser.tabs.onRemoved.addListener(tabId => abortTab(tabId));
browser.tabs.onUpdated.addListener((tabId, change, tab) => {
  // Firefox also emits updates for history.replaceState and fragment navigation.
  // Full document unloads cancel through content.js's pagehide handler.
  if (!change.url) return;
  const next = documentURL(change.url);
  for (const job of jobs.values()) if (job.tabId === tabId && job.pageURL !== next) job.controller.abort();
  // Also handles same-document back/forward navigation on sites using History API.
  if (tab && /^https?:/.test(change.url)) restoreCachedPage({ tab, url: change.url, frameId: 0 }).catch(() => {});
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
