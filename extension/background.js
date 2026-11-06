/* global browser, Kotoba */
const K = Kotoba;
const queue = new K.Queue(1); // Shared by every tab and by /tokenize requests.
const jobs = new Map();
const inFlightCompletions = new Map();
const METRIC_TOTALS = ["requests", "sharedRequests", "responseMilliseconds", "outputTokens", "serverTokens", "serverMilliseconds", "serverRequests", "firstTokenMilliseconds", "streamRequests", "batchFallbacks", "structureRetries", "truncations"];
function measurements() { return { ...Object.fromEntries(METRIC_TOTALS.map(key => [key, 0])), tokensKnown: true }; }
function documentURL(value) { const url = new URL(value); url.hash = ""; return url.href; }

// Persistent diagnostics are independent of the translation cache and settings.
const ERROR_BYTES = 4 * 1024 * 1024, ERROR_ENTRIES = 100;
let errorWrites = Promise.resolve();
function errorOperation(action) {
  const operation = errorWrites.then(action);
  errorWrites = operation.catch(() => {});
  return operation;
}
function errorHistory() {
  return errorOperation(async () => {
    const { translationErrors = [] } = await browser.storage.local.get("translationErrors");
    return { entries: translationErrors, maxEntries: ERROR_ENTRIES, maxBytes: ERROR_BYTES };
  });
}
function diagnosticRecorder(s, page, signal) {
  const recorded = new WeakSet();
  const secrets = [s.apiKey, s.apiKey.replace(/^Bearer\s+/i, "").trim()].filter(Boolean);
  function clean(value) {
    if (typeof value === "string") {
      for (const secret of secrets) value = value.split(secret).join("[REDACTED]");
      return value.length > 32000 ? value.slice(0, 32000) + "\n[省略: 32000文字を超過]" : value;
    }
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item)]));
    return value;
  }
  return async (error, stage, original, response, details = {}) => {
    if (page.private || signal.aborted || recorded.has(error)) return;
    recorded.add(error);
    const entry = clean({ timestamp: Date.now(), version: browser.runtime.getManifest().version,
      stage, origin: page.domain, source: page.source, target: page.target,
      error: { name: error.name, message: error.message, code: error.code, stack: error.stack },
      original, response: response === undefined || typeof response === "string" ? response : JSON.stringify(response), ...details,
      endpoint: K.endpoint(s), maxTokens: K.MAX_TOKENS,
      settings: Object.fromEntries(["model", "apiFormat", "inputTokens", "contextTokens", "timeoutSeconds", "tokenizer", "batchTranslation", "streamTranslation", "retryTransient", "form"].map(key => [key, s[key]])) });
    try {
      await errorOperation(async () => {
        const { translationErrors = [] } = await browser.storage.local.get("translationErrors");
        const entries = [entry, ...translationErrors].slice(0, ERROR_ENTRIES);
        while (new TextEncoder().encode(JSON.stringify(entries)).length > ERROR_BYTES) entries.pop();
        await browser.storage.local.set({ translationErrors: entries });
      });
    } catch (failure) { console.error("Kotoba: エラー記録を保存できませんでした。", failure); }
  };
}

// Session-only, bounded paragraph cache; persistent error records are separate.
const translationCache = new Map();
const histories = new Map();
const CACHE_BYTES = 8 * 1024 * 1024, CACHE_ENTRIES = 2000;
let cacheBytes = 0, cacheRevision = 0;
const signatures = new WeakMap();
function clearCache() { translationCache.clear(); histories.clear(); cacheBytes = 0; cacheRevision++; }
function removeCached(key) {
  const entry = translationCache.get(key);
  cacheBytes -= entry.size; translationCache.delete(key);
  if (entry.history && --entry.history.cached === 0) histories.delete(entry.history.key);
}
function pruneCache() {
  const now = Date.now();
  for (const [key, entry] of translationCache) if (entry.expiresAt <= now) removeCached(key);
}
setInterval(pruneCache, 60000);
function cacheSignature(s) {
  if (!signatures.has(s)) signatures.set(s, JSON.stringify([K.endpoint(s), s.apiKey, s.model, s.apiFormat, s.form, s.inputTokens, s.contextTokens, s.tokenizer, s.tokenizePath, s.batchTranslation, s.relevantGlossary, s.dictionary]));
  return signatures.get(s);
}
function cacheKey(url, source, target, input) { return JSON.stringify([url, source, target, input]); }
function cachedParagraph(s, url, source, target, document) {
  const input = JSON.stringify(document), key = cacheKey(url, source, target, input);
  const entry = translationCache.get(key);
  if (entry?.expiresAt <= Date.now()) { removeCached(key); return null; }
  if (!entry || entry.signature !== cacheSignature(s)) return null;
  // Validate cached output against the current paragraph as well as the original response.
  const result = K.parseDocument(K.serializeDocument(entry.document), document);
  translationCache.delete(key); translationCache.set(key, entry);
  return result;
}
function cacheParagraph(s, url, source, target, original, document, history) {
  const input = JSON.stringify(original), key = cacheKey(url, source, target, input);
  const signature = cacheSignature(s);
  const size = 2 * (key.length + input.length + JSON.stringify(document).length + signature.length + url.length + source.length + target.length);
  if (size > CACHE_BYTES) return;
  if (translationCache.has(key)) removeCached(key);
  if (cacheBytes + size > CACHE_BYTES || translationCache.size >= CACHE_ENTRIES) pruneCache();
  while (cacheBytes + size > CACHE_BYTES || translationCache.size >= CACHE_ENTRIES) removeCached(translationCache.keys().next().value);
  translationCache.set(key, { url, source, target, input, document, signature, expiresAt: Date.now() + s.cacheMinutes * 60000, size,
    characters: K.documentLength(original), history });
  if (history) { history.cached++; histories.set(history.key, history); }
  cacheBytes += size;
}
function historyMetrics(h, milliseconds) {
  const server = h.requests > 0 && h.serverRequests === h.requests && h.serverMilliseconds > 0;
  return { requests: h.requests, sharedRequests: h.sharedRequests,
    batchFallbacks: h.batchFallbacks, structureRetries: h.structureRetries, truncations: h.truncations,
    outputTokens: h.tokensKnown ? h.outputTokens : null,
    firstTokenMilliseconds: h.streamRequests ? h.firstTokenMilliseconds / h.streamRequests : null,
    generationTokensPerSecond: server ? h.serverTokens / (h.serverMilliseconds / 1000) : null,
    generationSpeedSource: server ? "server" : null,
    tokensPerSecond: h.requests > 0 && h.tokensKnown && milliseconds > 0 ? h.outputTokens / (milliseconds / 1000) : null };
}
function cacheHistory() {
  pruneCache();
  const rows = new Map(), totals = { ...measurements(), pages: 0, paragraphs: 0, characters: 0, milliseconds: 0 };
  for (const entry of translationCache.values()) {
    const h = entry.history;
    if (!h) continue;
    if (!rows.has(h)) {
      rows.set(h, { url: h.url, source: h.source, target: h.target, startedAt: h.startedAt, finishedAt: h.finishedAt,
        milliseconds: h.finishedAt - h.startedAt, paragraphs: 0, characters: 0, ...historyMetrics(h, h.finishedAt - h.startedAt) });
      totals.pages++; totals.milliseconds += h.finishedAt - h.startedAt;
      for (const name of METRIC_TOTALS) totals[name] += h[name];
      totals.tokensKnown &&= h.tokensKnown;
    }
    const row = rows.get(h); row.paragraphs++; row.characters += entry.characters;
    totals.paragraphs++; totals.characters += entry.characters;
  }
  return { rows: [...rows.values()].sort((a, b) => b.finishedAt - a.finishedAt),
    totals: { pages: totals.pages, paragraphs: totals.paragraphs, characters: totals.characters, milliseconds: totals.milliseconds, ...historyMetrics(totals, totals.milliseconds) },
    bytes: cacheBytes, maxBytes: CACHE_BYTES };
}
async function restoreCachedPage(sender) {
  if (!sender.tab || sender.frameId !== 0) return {};
  const revision = cacheRevision;
  const s = await getSettings();
  // The optional selection launcher needs listeners even before a manual translation.
  if (s.selectionButton) await ensureContent(sender.tab.id);
  if (sender.tab.incognito || !s.cacheMinutes) return {};
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

let settingsPromise;
async function getSettings() {
  if (!settingsPromise) {
    const pending = browser.storage.local.get("settings").then(({ settings }) => K.settings(settings));
    settingsPromise = pending;
    pending.catch(() => { if (settingsPromise === pending) settingsPromise = null; });
  }
  const pending = settingsPromise, value = await pending;
  // Ignore a storage read that completed after an options change.
  if (pending !== settingsPromise) return getSettings();
  if (queue.limit !== value.concurrency) queue.setLimit(value.concurrency);
  return value;
}
function waitToRetry(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new DOMException("キャンセルしました。", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
function abortTab(tabId, frameId) {
  for (const job of jobs.values()) {
    if (job.tabId === tabId && (frameId === undefined || job.frameId === frameId)) job.controller.abort();
  }
}
async function post(s, url, data, signal, notify = () => {}, phase = "translating", onResponse = () => {}, onDelta, onFailure = async () => {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await postOnce(s, url, data, signal, notify, phase, onResponse, onDelta); }
    catch (error) {
      await onFailure(error, attempt + 1);
      if (!s.retryTransient || attempt >= 2 || !error.retryable || signal.aborted) throw error;
      notify("retrying");
      // Release the shared queue while waiting, and let Stop interrupt the delay.
      await waitToRetry(error.retryAfter ?? 500 * 2 ** attempt, signal);
    }
  }
}
async function postOnce(s, url, data, signal, notify, phase, onResponse, onDelta) {
  notify("queued");
  return queue.run(async () => {
    notify(phase);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, s.timeoutSeconds * 1000);
    const startedAt = Date.now();
    try {
      if (signal.aborted) throw new DOMException("キャンセルしました。", "AbortError");
      const response = await fetch(url, {
        method: "POST", redirect: "error", credentials: "omit", cache: "no-store",
        headers: { "Content-Type": "application/json", ...(s.apiKey ? { Authorization: `Bearer ${s.apiKey.replace(/^Bearer\s+/i, "").trim()}` } : {}) },
        body: JSON.stringify(data), signal: controller.signal
      });
      if (!response.ok) {
        const error = new Error(`翻訳サーバ: HTTP ${response.status}。接続設定・モデル名・API形式を確認してください。`);
        error.httpStatus = response.status;
        if (response.text) {
          try { error.response = await response.text(); }
          catch { error.response = "[応答本文を読み取れませんでした]"; }
        }
        error.retryable = [429, 502, 503, 504].includes(response.status);
        const header = response.headers?.get("Retry-After");
        if (header) {
          const delay = /^\d+(?:\.\d+)?$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now();
          if (Number.isFinite(delay)) error.retryAfter = Math.max(0, Math.min(10000, delay));
        }
        throw error;
      }
      let result;
      if (data.stream && response.headers.get("Content-Type")?.includes("text/event-stream")) {
        result = await readCompletionStream(response, signal, onDelta, startedAt);
      } else if (response.text) {
        const raw = await response.text();
        try { result = JSON.parse(raw); }
        catch (error) { error.response = raw; throw error; }
      } else result = await response.json();
      onResponse(Date.now() - startedAt);
      return result;
    } catch (error) {
      if (signal.aborted) throw new Error("キャンセルしました。");
      if (controller.signal.aborted) throw new Error(`応答が${s.timeoutSeconds}秒以内に完了しませんでした。`);
      if (error instanceof TypeError) throw new Error("翻訳サーバに接続できません。URL・ポート・サーバの起動状態を確認してください。");
      throw error;
    } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
  }, signal);
}
async function readCompletionStream(response, signal, onDelta = () => {}, startedAt = Date.now()) {
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = "", data = [], output = "", finishReason, usage, timings, done = false;
  let firstContentAt;
  function event() {
    if (!data.length) return;
    const raw = data.join("\n"); data = [];
    if (raw === "[DONE]") { done = true; return; }
    let value;
    try { value = JSON.parse(raw); } catch { throw Object.assign(new Error("ストリーミング応答のJSONを解釈できません。"), { response: { invalidEvent: raw } }); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ストリーミング応答の形式が不正です。");
    if (value.error) throw new Error("翻訳サーバがストリーミングエラーを返しました。");
    if (value.usage) usage = value.usage;
    if (value.timings) timings = value.timings;
    const choice = Array.isArray(value.choices) ? value.choices.find(item => item && (item.index === undefined || item.index === 0)) : null;
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const text = choice.delta?.content;
    if (typeof text === "string" && text.length) {
      firstContentAt ??= Date.now();
      output += text;
      if (output.length > 2000000) throw new Error("ストリーミング応答が200万文字を超えました。");
      onDelta(output);
    }
  }
  function lines(final = false) {
    let match;
    while ((match = /\r\n|\r|\n/.exec(buffer))) {
      if (!final && match[0] === "\r" && match.index === buffer.length - 1) break;
      const line = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
      if (!line) event();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      if (done) return;
    }
    if (final) {
      if (buffer.startsWith("data:")) data.push(buffer.slice(5).replace(/^ /, ""));
      buffer = ""; event();
    }
  }
  try {
    while (!done) {
      if (signal.aborted) throw new DOMException("キャンセルしました。", "AbortError");
      const next = await reader.read();
      buffer += decoder.decode(next.value, { stream: !next.done });
      if (buffer.length > 2000000) throw new Error("ストリーミング応答のイベントが大きすぎます。");
      lines(next.done);
      if (next.done) break;
    }
    if (!finishReason) throw new Error("ストリーミング応答が完了前に途切れました。原文を保持します。");
    return { choices: [{ message: { content: output }, finish_reason: finishReason }], usage, timings,
      streamMetrics: { firstTokenMilliseconds: firstContentAt === undefined ? null : firstContentAt - startedAt } };
  } catch (error) {
    error.response = { partialOutput: output, pendingEvent: [...data, buffer].join("\n"), ...error.response };
    throw error;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function counter(s, signal, notify) {
  if (s.tokenizer === "bytes") return K.byteTokens;
  const counts = new Map();
  let bytes = 0;
  return async text => {
    if (signal.aborted) throw new DOMException("キャンセルしました。", "AbortError");
    if (counts.has(text)) return counts.get(text);
    const data = s.tokenizer === "llama" ? { content: text, add_special: false } : { model: s.model, prompt: text, add_special_tokens: false };
    const result = await post(s, K.endpoint(s, s.tokenizePath), data, signal, notify, "tokenizing");
    const count = Array.isArray(result.tokens) ? result.tokens.length : result.count;
    if (!Number.isInteger(count) || count < 0) throw new Error("/tokenizeの応答が不正です。tokenizer設定を確認してください。");
    // Counts belong to this job only. Bound retained text, including huge selections.
    if (text.length <= 524288) {
      while (counts.size && (counts.size >= 128 || bytes + text.length * 2 > 1048576)) {
        const first = counts.keys().next().value; bytes -= first.length * 2; counts.delete(first);
      }
      counts.set(text, count); bytes += text.length * 2;
    }
    return count;
  };
}
function completionRequest(s, payload, signal, notify = () => {}, onDelta = () => {}, privateContext = false, onFailure = async () => {}) {
  if (signal.aborted) return Promise.reject(new Error("キャンセルしました。"));
  const url = K.endpoint(s);
  const key = s.shareInFlight ? JSON.stringify([cacheRevision, url, s.apiKey.replace(/^Bearer\s+/i, "").trim(), s.timeoutSeconds, s.retryTransient, privateContext, payload]) : null;
  let flight = key && inFlightCompletions.get(key);
  const shared = !!flight;
  if (!flight) {
    flight = { controller: new AbortController(), listeners: new Set(), phase: "queued", output: "", milliseconds: 0 };
    if (key) inFlightCompletions.set(key, flight);
  }
  const remove = () => { if (key && inFlightCompletions.get(key) === flight) inFlightCompletions.delete(key); };
  return new Promise((resolve, reject) => {
    const listener = { notify, onDelta, onFailure };
    const detach = () => { flight.listeners.delete(listener); signal.removeEventListener("abort", abort); };
    const abort = () => {
      detach();
      // A stopped tab must not kill a worker still serving another tab.
      if (!flight.listeners.size) { remove(); flight.controller.abort(); }
      reject(new Error("キャンセルしました。"));
    };
    flight.listeners.add(listener); signal.addEventListener("abort", abort, { once: true });
    notify(flight.phase); if (flight.output) onDelta(flight.output);
    if (signal.aborted) { abort(); return; }
    if (!flight.promise) {
      flight.promise = post(s, url, payload, flight.controller.signal, phase => {
        flight.phase = phase;
        for (const item of flight.listeners) item.notify(phase);
      }, "translating", milliseconds => { flight.milliseconds = milliseconds; }, output => {
        flight.output = output;
        for (const item of flight.listeners) item.onDelta(output);
      }, (error, attempt) => Promise.all([...flight.listeners].map(item => item.onFailure(error, attempt))));
      flight.promise.then(remove, remove);
    }
    flight.promise.then(result => { detach(); if (!signal.aborted) resolve({ result, milliseconds: flight.milliseconds, shared }); }, error => { detach(); reject(error); });
  });
}
async function generate(s, text, page, signal) {
  try {
    const result = await generateOnce(s, text, page, signal);
    if (result.truncated) await page.record?.(new Error("生成上限に達しました。"), "generation-limit", text, result.text);
    return result;
  } catch (error) {
    await page.record?.(error, "generation", text, error.response, { httpStatus: error.httpStatus });
    throw error;
  }
}
async function generateOnce(s, text, page, signal) {
  let lastUpdate = 0;
  const response = await completionRequest(s, K.body(s, text, page), signal, page.notify, output => {
    const now = Date.now();
    if (!lastUpdate || now - lastUpdate >= 120) {
      lastUpdate = now;
      if (page.preview) page.preview(output);
      else page.notify?.("receiving", undefined, { receivedCharacters: output.length });
    }
  }, page.private, (error, attempt) => page.record?.(error, "request", text, error.response, { attempt, httpStatus: error.httpStatus }));
  const result = response.result ?? {};
  if (page.metrics) {
    page.metrics.requests++;
    page.metrics.sharedRequests += response.shared ? 1 : 0;
    page.metrics.responseMilliseconds += response.milliseconds;
    const tokens = result.usage?.completion_tokens;
    if (Number.isSafeInteger(tokens) && tokens >= 0) page.metrics.outputTokens += tokens;
    else page.metrics.tokensKnown = false;
    const t = result.timings;
    if (Number.isSafeInteger(t?.predicted_n) && t.predicted_n >= 0 && Number.isFinite(t.predicted_ms) && t.predicted_ms > 0) {
      page.metrics.serverTokens += t.predicted_n; page.metrics.serverMilliseconds += t.predicted_ms; page.metrics.serverRequests++;
    }
    const stream = result.streamMetrics;
    if (Number.isFinite(stream?.firstTokenMilliseconds)) {
      page.metrics.firstTokenMilliseconds += stream.firstTokenMilliseconds; page.metrics.streamRequests++;
    }
  }
  const choice = result.choices?.[0];
  if (choice?.finish_reason === "length") { if (page.metrics) page.metrics.truncations++; return { truncated: true, text: choice.message?.content }; }
  if (choice?.finish_reason && !["stop", "eos"].includes(choice.finish_reason)) throw Object.assign(new Error(`翻訳が完了しませんでした (${choice.finish_reason})。`), { response: result });
  const output = choice?.message?.content;
  if (typeof output !== "string" || !output.trim()) throw Object.assign(new Error("翻訳サーバが空または不正な応答を返しました。"), { response: result });
  return { text: output.trim() };
}
async function translatePlain(s, text, page, signal, count, limit = s.inputTokens, depth = 0, advance = () => {}) {
  if (!text.trim()) { advance(text.length); return text; }
  const chunks = await K.split(text, limit, count);
  const result = [];
  for (const chunk of chunks) {
    if (!chunk.trim()) { result.push(chunk); advance(chunk.length); continue; }
    const leading = chunk.match(/^\s*/u)[0], trailing = chunk.match(/\s*$/u)[0];
    const translated = await generate(s, chunk.trim(), { ...page, preview: page.preview && (output => page.preview(result.join("") + leading + output)) }, signal);
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
async function translateDocument(s, document, page, signal, advance, limit = s.inputTokens, depth = 0, count = counter(s, signal, page.notify)) {
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
      if (attempt && page.metrics) page.metrics.structureRetries++;
      const output = await generate(s, K.serializeDocument(chunk), { ...page, html: true, retry: attempt > 0, glossaryText: glossarySource(chunk) }, signal);
      if (output.truncated) {
        if (depth >= 5) break;
        accepted = await translateDocument(s, chunk, page, signal, advance, Math.max(64, Math.floor(limit / 2)), depth + 1, count);
        break;
      }
      try { accepted = K.parseDocument(output.text, chunk); }
      catch (error) {
        await page.record?.(error, "paragraph-structure", K.serializeDocument(chunk), output.text, { attempt: attempt + 1 });
        continue;
      }
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
  catch (failure) {
    await page.record?.(failure, "merged-structure", K.serializeDocument(document), K.serializeDocument(merged));
    const error = new Error("翻訳結果のリンク構造が一致しないため、原文を保持しました。");
    error.code = "structure"; throw error;
  }
}
// Each marker scopes inline IDs to its own paragraph, so IDs can repeat across items.
function glossarySource(nodes) {
  return nodes.map(node => node.protected ? "" : node.text !== undefined ? node.text : glossarySource(node.children)).join("");
}
function serializeBatch(documents) {
  return documents.map((document, i) => `<p id="b${i}">${K.serializeDocument(document)}</p>`).join("\n");
}
function parseBatch(text, documents) {
  const parsed = new DOMParser().parseFromString(`<batch>${K.normalizeEntities(text)}</batch>`, "application/xml");
  if (parsed.querySelector("parsererror")) throw new Error("Invalid batch XML");
  const result = new Array(documents.length);
  for (const node of parsed.documentElement.childNodes) {
    if (node.nodeType === 3 && !node.data.trim()) continue;
    const id = node.nodeType === 1 && node.getAttribute("id");
    if (node.nodeName !== "p" || !/^b\d+$/.test(id) || node.attributes.length !== 1) throw new Error("Invalid batch marker");
    const index = Number(id.slice(1));
    if (id !== `b${index}` || index >= documents.length || result[index]) throw new Error("Duplicate or unknown batch marker");
    result[index] = { document: K.parseDocument(node.innerHTML, documents[index]) };
  }
  if (result.filter(Boolean).length !== documents.length) throw new Error("Missing batch marker");
  return result;
}
async function translateDocuments(s, documents, page, signal, advance, deliver = () => {}) {
  const count = counter(s, signal, page.notify), results = [];
  let batchAllowed = s.batchTranslation;
  function accept(result) { const index = results.length; results.push(result); deliver(index, result); }
  async function flush(batch) {
    if (signal.aborted) throw new DOMException("キャンセルしました。", "AbortError");
    if (batch.length > 1 && batchAllowed) {
      // A remote tokenizer measures a whole candidate once, rather than every
      // growing prefix. Oversized candidates split at paragraph boundaries.
      if (await count(serializeBatch(batch)) > s.inputTokens) {
        const middle = Math.ceil(batch.length / 2);
        await flush(batch.slice(0, middle)); await flush(batch.slice(middle)); return;
      }
      const output = await generate(s, serializeBatch(batch), { ...page, html: true, batch: true, glossaryText: batch.map(glossarySource).join("\n") }, signal);
      if (!output.truncated) {
        let accepted;
        try { accepted = parseBatch(output.text, batch); }
        catch (error) { await page.record?.(error, "batch-structure", serializeBatch(batch), output.text); }
        if (accepted) {
          accepted.forEach(accept);
          advance(batch.reduce((sum, document) => sum + K.documentLength(document), 0));
          return;
        }
      }
      if (page.metrics) page.metrics.batchFallbacks++;
      batchAllowed = false;
    }
    for (const document of batch) {
      try { accept({ document: await translateDocument(s, document, page, signal, advance, s.inputTokens, 0, count) }); }
      catch (error) {
        if (error.code !== "structure") throw error;
        accept({ error: error.message, errorCode: error.code });
      }
    }
  }
  let batch = [], bytes = 0;
  for (const document of documents) {
    const textBytes = K.byteTokens(K.serializeDocument(document));
    const size = textBytes + `<p id="b${batch.length}"></p>`.length + (batch.length ? 1 : 0);
    if (batch.length && (!s.batchTranslation || count === K.byteTokens && bytes + size > s.inputTokens)) {
      await flush(batch); batch = []; bytes = 0;
    }
    bytes += textBytes + `<p id="b${batch.length}"></p>`.length + (batch.length ? 1 : 0);
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
  if (documents !== undefined && (!Array.isArray(documents) || !documents.length || documents.length > 64)) throw new Error("翻訳の段落数が不正です。");
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
  const job = { tabId: sender.tab.id, frameId: sender.frameId, pageURL: documentURL(sender.tab.url || sender.url), controller: new AbortController(), startedAt: Date.now() };
  const id = Symbol(); jobs.set(id, job);
  let completed = 0;
  const total = inputs ? inputs.reduce((sum, document) => sum + K.documentLength(document), 0) : message.parts[0].length;
  let phase = "preparing";
  const notify = (next = phase, result, activity) => {
    phase = next;
    if (typeof message.requestId === "string" && message.requestId.length < 100 && !job.controller.signal.aborted) {
      browser.tabs.sendMessage(job.tabId, { type: "translationProgress", requestId: message.requestId, completed, total, phase,
        ...(result ? { results: [result] } : {}), ...activity }, { frameId: job.frameId }).catch(() => {});
    }
  };
  const advance = amount => { completed += amount; notify(); };
  let record;
  try {
    const revision = cacheRevision;
    const saved = await getSettings();
    const s = { ...saved, inputTokens: K.inputBudget(saved, { source: message.source, target: message.target, domain: pageURL.origin }) };
    const page = { source: message.source, target: message.target, domain: pageURL.origin, private: sender.tab.incognito === true, notify,
      metrics: measurements() };
    record = page.record = diagnosticRecorder(s, page, job.controller.signal);
    if (!inputs) page.preview = preview => notify("receiving", undefined, { preview, receivedCharacters: preview.length });
    if (inputs) {
      const useCache = s.cacheMinutes > 0 && !sender.tab.incognito;
      const url = documentURL(sender.url);
      const results = inputs.map(input => {
        const hit = useCache && cachedParagraph(saved, url, page.source, page.target, input);
        if (hit) advance(K.documentLength(input));
        return hit ? { document: hit } : null;
      });
      results.forEach((result, index) => { if (result) notify("preparing", { index, ...result }); });
      const missingIndices = inputs.flatMap((_, index) => results[index] ? [] : [index]);
      const missing = missingIndices.map(index => inputs[index]);
      if (missing.length) {
        const fresh = documents ? await translateDocuments(s, missing, page, job.controller.signal, advance,
          (index, result) => notify("preparing", { index: missingIndices[index], ...result })) : [{ document: await translateDocument(s, document, page, job.controller.signal, advance) }];
        if (job.controller.signal.aborted) throw new DOMException("キャンセルしました。", "AbortError");
        let history;
        if (useCache && revision === cacheRevision) {
          const startedAt = Number.isSafeInteger(message.sessionStartedAt) && message.sessionStartedAt > 0 && message.sessionStartedAt <= job.startedAt
            ? message.sessionStartedAt : job.startedAt;
          const key = typeof message.sessionId === "string" && message.sessionId.length < 100
            ? JSON.stringify([job.tabId, job.frameId, url, page.source, page.target, message.sessionId]) : Symbol();
          history = histories.get(key) || { ...measurements(), key, url, source: page.source, target: page.target, startedAt, cached: 0 };
          history.startedAt = Math.min(history.startedAt, startedAt); history.finishedAt = Date.now();
          for (const name of METRIC_TOTALS) history[name] += page.metrics[name];
          history.tokensKnown &&= page.metrics.tokensKnown;
        }
        let cursor = 0;
        for (let i = 0; i < inputs.length; i++) if (!results[i]) {
          results[i] = fresh[cursor++];
          if (useCache && revision === cacheRevision && results[i].document) cacheParagraph(saved, url, page.source, page.target, inputs[i], results[i].document, history);
        }
      }
      return documents ? { documents: results, batchFallback: page.metrics.batchFallbacks > 0 } : results[0];
    }
    return { parts: [await translatePlain(s, message.parts[0], page, job.controller.signal, counter(s, job.controller.signal, notify), s.inputTokens, 0, advance)] };
  } catch (error) {
    await record?.(error, "translation", inputs ? inputs.map(K.serializeDocument).join("\n") : message.parts[0], error.response, { httpStatus: error.httpStatus });
    throw error;
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
    return K.contentPreferences(s);
  }
  if (message.type === "copyText" && sender.tab) {
    if (!(await getSettings()).copyButton) throw new Error("コピーボタンは設定で無効になっています。");
    if (typeof message.text !== "string" || message.text.length > 2000000) throw new Error("コピーする文章が不正です。");
    await navigator.clipboard.writeText(message.text);
    return {};
  }
  // Firefox also sets sender.tab for our own settings/history tabs.
  if (sender.tab && !sender.url?.startsWith(browser.runtime.getURL(""))) throw new Error("許可されていない操作です。");
  if (message.type === "errorHistory") return errorHistory();
  if (message.type === "clearErrors") {
    await errorOperation(() => browser.storage.local.set({ translationErrors: [] })); return {};
  }
  if (message.type === "cacheHistory") return cacheHistory();
  if (message.type === "testConnection") {
    const s = K.settings(message.settings);
    const signal = new AbortController().signal, startedAt = Date.now();
    const probe = { ...s, retryTransient: false, timeoutSeconds: Math.min(s.timeoutSeconds, 15) };
    await counter(probe, signal)("Hello.");
    const result = await generate(probe, "Hello.", { source: s.source, target: s.target, domain: new URL(K.endpoint(s)).origin }, signal);
    if (result.truncated) throw new Error("接続できましたが、テスト翻訳が生成上限に達しました。");
    return { milliseconds: Date.now() - startedAt };
  }
  if (message.type === "clearCache") { clearCache(); return {}; }
  if (message.type === "preferences") {
    const s = await getSettings();
    return { source: s.source, target: s.target, ...K.contentPreferences(s) };
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
    settingsPromise = null;
    clearCache();
    refreshContentPreferences().catch(() => {});
  }
});
async function refreshContentPreferences() {
  const s = await getSettings();
  const tabs = await browser.tabs.query({ url: ["http://*/*", "https://*/*"] });
  await Promise.all(tabs.map(async tab => {
    try {
      if (s.selectionButton) await ensureContent(tab.id);
      await browser.tabs.sendMessage(tab.id, { type: "preferencesChanged", preferences: K.contentPreferences(s) });
    } catch { /* Most tabs have no content script until requested. */ }
  }));
}
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
browser.contextMenus.create({ id: "kotoba-page", title: "ページ翻訳／停止", contexts: ["page"], documentUrlPatterns: ["http://*/*", "https://*/*"] });
browser.contextMenus.create({ id: "kotoba-restore", title: "原文に戻す", contexts: ["page"], documentUrlPatterns: ["http://*/*", "https://*/*"] });
async function pageAction(command, tab, s) {
  await ensureContent(tab.id);
  const state = await browser.tabs.sendMessage(tab.id, { type: "status" }, { frameId: 0 });
  const type = command === "translate-page" ? state.running ? "stop" : "start"
    : command === "translate-selection" ? "selection" : "restore";
  const result = await browser.tabs.sendMessage(tab.id, { type, source: state.source || s.source, target: state.target || s.target }, { frameId: 0 });
  if (result?.error) throw new Error(result.error);
  await browser.browserAction.setBadgeText({ tabId: tab.id, text: "" });
  await browser.browserAction.setTitle({ tabId: tab.id, title: "Kotoba 翻訳" });
}
browser.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!["kotoba-selection", "kotoba-page", "kotoba-restore"].includes(info.menuItemId) || !tab?.id || !/^https?:/.test(tab.url || "")) return;
  try {
    const s = await getSettings();
    if (info.menuItemId !== "kotoba-selection") {
      await pageAction(info.menuItemId === "kotoba-page" ? "translate-page" : "restore-page", tab, s);
      return;
    }
    await ensureContent(tab.id, info.frameId || 0);
    const result = await browser.tabs.sendMessage(tab.id, { type: "selection", text: info.selectionText, defaults: { source: s.source, target: s.target }, concurrency: s.concurrency }, { frameId: info.frameId || 0 });
    if (result?.error) throw new Error(result.error);
    await browser.browserAction.setBadgeText({ tabId: tab.id, text: "" });
    await browser.browserAction.setTitle({ tabId: tab.id, title: "Kotoba 翻訳" });
  } catch (error) {
    // Firefox's restricted pages reject injection. Keep a visible indication.
    await browser.browserAction.setBadgeText({ tabId: tab.id, text: "!" });
    await browser.browserAction.setTitle({ tabId: tab.id, title: `Kotoba: ${error.message}` });
  }
});
browser.commands.onCommand.addListener(async (command, tab) => {
  try {
    if (!["translate-page", "translate-selection", "restore-page"].includes(command)) return;
    const s = await getSettings();
    if (!s.keyboardShortcuts || !tab?.id || !/^https?:/.test(tab.url || "")) return;
    await pageAction(command, tab, s);
  } catch (error) {
    if (tab?.id) {
      await browser.browserAction.setBadgeText({ tabId: tab.id, text: "!" });
      await browser.browserAction.setTitle({ tabId: tab.id, title: `Kotoba: ${error.message}` });
    }
  }
});
