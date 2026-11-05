/* Shared pure logic; also loaded directly by the small Node test suite. */
globalThis.Kotoba = (() => {
  const MAX_TOKENS = 8096;
  const DEFAULTS = Object.freeze({
    endpoint: "http://127.0.0.1", port: "8000", path: "/v1/chat/completions",
    apiKey: "", model: "plamo-translate", apiFormat: "top-level",
    concurrency: 1, inputTokens: 3000, timeoutSeconds: 180,
    tokenizer: "bytes", tokenizePath: "/tokenize", source: "en", target: "ja", form: ""
  });
  const LANGUAGES = "ja en zh-hans zh-hant ko ar az be bg bn ca ceb de es et eu fa fr gu he hi hr hu hy id it jv ka kk km lt lv ml mr ms my ne nl pa pl ru si sk sl sr sw ta te th tl ur uz vi".split(" ");
  function settings(raw = {}) {
    const s = { ...DEFAULTS, ...raw };
    const url = new URL(s.endpoint);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("接続先は認証情報・クエリを含まない http(s) URL を指定してください。");
    if (s.port !== "" && (!/^\d+$/.test(String(s.port)) || +s.port < 1 || +s.port > 65535)) throw new Error("ポートは1〜65535で指定してください。");
    for (const name of ["path", "tokenizePath"]) {
      if (!s[name].startsWith("/") || s[name].startsWith("//") || /[?#]/.test(s[name])) throw new Error("APIパスは / から始まるパスを指定してください。");
    }
    for (const [key, min, max] of [["concurrency", 1, 8], ["inputTokens", 128, 3900], ["timeoutSeconds", 10, 1800]]) {
      s[key] = Number(s[key]);
      if (!Number.isInteger(s[key]) || s[key] < min || s[key] > max) throw new Error(`${key} は ${min}〜${max} の整数で指定してください。`);
    }
    if (!["top-level", "template"].includes(s.apiFormat) || !["bytes", "llama", "vllm"].includes(s.tokenizer)) throw new Error("API形式またはtokenizer設定が不正です。");
    if (!s.model.trim() || /[\r\n]/.test(s.apiKey)) throw new Error("モデル名またはAPIキーを確認してください。");
    languages(s.source, s.target);
    if (!["", "plain", "polite"].includes(s.form)) throw new Error("文体が不正です。");
    return s;
  }
  function languages(source, target) {
    if (source !== "auto" && !LANGUAGES.includes(source) || !LANGUAGES.includes(target)) throw new Error("対応する言語コードを指定してください。");
  }
  function endpoint(s, path = s.path) {
    const u = new URL(s.endpoint);
    if (s.port !== "") u.port = s.port;
    u.pathname = u.pathname.replace(/\/$/, "") + path;
    return u.href;
  }
  function body(s, text, { source, target, domain }) {
    languages(source, target);
    const options = { context: domain, form: s.form, target_lang: target };
    if (source !== "auto") options.source_lang = source;
    const result = { model: s.model, messages: [{ role: "user", content: text }], max_tokens: MAX_TOKENS, stream: false, temperature: 0 };
    if (s.apiFormat === "template") {
      result.chat_template_kwargs = options;
      result.stop = ["<|plamo:tag|>", "<|plamo:bos|>"];
    } else Object.assign(result, options, { use_glossary: false });
    return result;
  }
  // PLaMo's byte fallback makes UTF-8 byte length a conservative token estimate.
  const byteTokens = text => new TextEncoder().encode(text).length;
  const escape = text => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const unescape = text => text.replace(/&(?:amp|lt|gt);/g, x => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">" })[x]);
  function serialize(parts, protectedParts = []) { return parts.map((p, i) => { const tag = protectedParts[i] ? "x" : "t"; return `<${tag}${i}>${escape(p)}</${tag}${i}>`; }).join(""); }
  function parse(text, count, protectedParts = []) {
    let rest = text.trim();
    const result = [];
    for (let i = 0; i < count; i++) {
      const tag = protectedParts[i] ? "x" : "t";
      const match = rest.match(new RegExp(`^<${tag}${i}>([\\s\\S]*?)</${tag}${i}>`));
      if (!match || /[<>]/.test(match[1])) throw new Error("翻訳結果の構造が一致しません。");
      if (!match[1].trim()) throw new Error("空の翻訳結果です。");
      result.push(unescape(match[1]));
      rest = rest.slice(match[0].length);
    }
    if (rest.trim()) throw new Error("翻訳結果に余分な内容があります。");
    return result;
  }
  // Keep every code point and whitespace; prefer paragraphs, sentences, then words.
  async function split(text, limit, count = byteTokens) {
    const output = [];
    let rest = text;
    while (rest) {
      if (await count(rest) <= limit) { output.push(rest); break; }
      const points = Array.from(rest);
      let lo = 1, hi = points.length, best = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (await count(points.slice(0, mid).join("")) <= limit) { best = mid; lo = mid + 1; }
        else hi = mid - 1;
      }
      if (!best) throw new Error("1文字が入力トークン上限を超えています。");
      const prefix = points.slice(0, best).join("");
      let cut = prefix.length;
      for (const re of [/\n\s*\n/g, /[.!?。！？][\s\u3000]+|[。！？]/g, /\s+/g]) {
        const boundaries = [...prefix.matchAll(re)].map(m => m.index + m[0].length).filter(n => n >= prefix.length / 2);
        if (boundaries.length) { cut = boundaries.at(-1); break; }
      }
      // Token counts need not be monotonic when a subword is cut in half.
      if (await count(rest.slice(0, cut)) > limit) cut = prefix.length;
      output.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    return output;
  }
  class Queue {
    constructor(limit = 1) { this.limit = limit; this.active = 0; this.pending = []; }
    setLimit(limit) { this.limit = limit; this.drain(); }
    run(fn, signal) {
      return new Promise((resolve, reject) => {
        const job = { fn, signal, resolve, reject };
        job.abort = () => {
          const index = this.pending.indexOf(job);
          if (index >= 0) { this.pending.splice(index, 1); reject(new DOMException("キャンセルしました。", "AbortError")); }
        };
        if (signal?.aborted) return reject(new DOMException("キャンセルしました。", "AbortError"));
        signal?.addEventListener("abort", job.abort, { once: true });
        this.pending.push(job); this.drain();
      });
    }
    drain() {
      while (this.active < this.limit && this.pending.length) {
        const job = this.pending.shift();
        job.signal?.removeEventListener("abort", job.abort);
        this.active++;
        Promise.resolve().then(() => { if (job.signal?.aborted) throw new DOMException("キャンセルしました。", "AbortError"); return job.fn(); })
          .then(job.resolve, job.reject).finally(() => { this.active--; this.drain(); });
      }
    }
  }
  return { MAX_TOKENS, DEFAULTS, LANGUAGES, settings, languages, endpoint, body, byteTokens, serialize, parse, split, Queue };
})();
