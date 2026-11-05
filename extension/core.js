/* Shared pure logic; also loaded directly by the small Node test suite. */
globalThis.Kotoba = (() => {
  const MAX_TOKENS = 8096;
  const CONTENT_PROTOCOL = 3;
  const DEFAULTS = Object.freeze({
    endpoint: "http://127.0.0.1", port: "8000", path: "/v1/chat/completions",
    apiKey: "", model: "plamo-translate", apiFormat: "top-level",
    batchTranslation: true, concurrency: 1, inputTokens: 3000, timeoutSeconds: 180,
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
    if (typeof s.batchTranslation !== "boolean") throw new Error("まとめて翻訳の設定が不正です。");
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
  function body(s, text, { source, target, domain, html = false, retry = false, batch = false }) {
    languages(source, target);
    let context = `This text is from a web page on ${domain}. Translate it as part of the website, preserving the meaning and natural flow of complete sentences.`;
    if (html) context += (batch ? " The input is an HTML fragment containing independent paragraphs. Translate each whole paragraph together." : " The input is an HTML fragment of one paragraph. Translate the whole paragraph together.") + " Preserve every HTML tag and id exactly once, keep link labels with their links, and do not translate code or elements marked translate=\"no\". You may reorder sibling inline elements and place translated prose outside tags to produce natural grammar. Return only the translated HTML fragment.";
    if (batch) context += " The input contains multiple independent paragraphs in kotoba-item elements. Preserve each kotoba-item tag and its id exactly once. Translate each paragraph separately within its own element; never move text or inline elements between paragraphs. Return only these HTML fragments with no text outside them.";
    if (retry) context += " The previous response did not preserve the HTML structure. Keep all tags and id attributes, including links, in the translated fragment. Do not return Markdown fences or explanations.";
    const options = { context, form: s.form, target_lang: target };
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
  const INLINE_TAGS = new Set(["a", "span", "strong", "em", "b", "i", "u", "s", "del", "sub", "sup", "mark", "small", "abbr", "q", "cite", "code", "kbd", "samp", "var"]);
  function documentText(nodes) { return nodes.map(node => node.text !== undefined ? node.text : documentText(node.children)).join(""); }
  function documentLength(nodes) { return nodes.reduce((sum, node) => sum + (node.protected ? 0 : node.text !== undefined ? node.text.length : documentLength(node.children)), 0); }
  function serializeDocument(nodes) {
    return nodes.map(node => {
      if (node.text !== undefined) return escape(node.text);
      if (!INLINE_TAGS.has(node.tag) || !/^k\d+$/.test(node.id)) throw new Error("翻訳対象のHTML構造が不正です。");
      return `<${node.tag} id="${node.id}"${node.protected ? ' translate="no"' : ""}>${serializeDocument(node.children)}</${node.tag}>`;
    }).join("");
  }
  function parseDocument(text, source) {
    const expected = new Map();
    function index(nodes, parent = null) {
      for (const node of nodes) if (node.text === undefined) {
        if (expected.has(node.id)) throw new Error("翻訳対象のIDが重複しています。");
        expected.set(node.id, { node, parent }); index(node.children, node.id);
      }
    }
    index(source);
    const cleaned = text.trim().replace(/^```(?:html|xml)?\s*\n([\s\S]*?)\n```$/i, "$1");
    const parsed = new DOMParser().parseFromString(`<kotoba-root>${cleaned.replace(/&nbsp;/g, "&#160;")}</kotoba-root>`, "application/xml");
    if (parsed.querySelector("parsererror")) throw new Error("翻訳結果のHTMLを解釈できません。");
    const seen = new Set();
    function read(parentNode, parentId = null) {
      return [...parentNode.childNodes].map(element => {
        if (element.nodeType === 3) return { text: element.data };
        if (element.nodeType !== 1) throw new Error("翻訳結果に不明な内容があります。");
        const id = element.getAttribute("id"), entry = expected.get(id);
        if (!entry || seen.has(id) || element.tagName !== entry.node.tag || entry.parent !== parentId || [...element.attributes].some(attr => attr.name !== "id" && !(attr.name === "translate" && attr.value === "no" && entry.node.protected))) throw new Error("翻訳結果のリンク・書式が一致しません。");
        seen.add(id);
        const children = read(element, id);
        if (entry.node.protected && documentText(children) !== documentText(entry.node.children)) throw new Error("保護した内容が変更されました。");
        if (documentText(entry.node.children).trim() && !documentText(children).trim()) throw new Error("翻訳結果のリンク・書式が空です。");
        return { tag: entry.node.tag, id, children, ...(entry.node.protected ? { protected: true } : {}) };
      });
    }
    const result = read(parsed.documentElement);
    if (seen.size !== expected.size || !documentText(result).trim()) throw new Error("翻訳結果のリンク・書式が不足しています。");
    return result;
  }
  // Split by readable text, never by the number or position of DOM text nodes.
  // Tags surrounding a long leaf are repeated in chunks, then merged afterwards.
  async function splitDocument(nodes, limit, count = byteTokens) {
    const chunks = [];
    let current = [];
    const fits = async value => await count(serializeDocument(value)) <= limit;
    async function pieces(node, wrappers = []) {
      const wrap = children => wrappers.reduceRight((value, wrapper) => [{ ...wrapper, children: value }], children);
      if (await fits(wrap([node]))) return [wrap([node])];
      if (node.text !== undefined) {
        const overhead = await count(serializeDocument(wrap([{ text: "" }])));
        const pieces = await split(node.text, Math.max(1, limit - overhead - 16), async text => (await count(serializeDocument(wrap([{ text }])))) - overhead);
        return pieces.map(text => wrap([{ text }]));
      }
      if (node.protected) throw new Error("保護対象が入力上限を超えています。入力上限を増やしてください。");
      const result = [];
      for (const child of node.children) result.push(...await pieces(child, [...wrappers, node]));
      return result;
    }
    for (const node of nodes) for (const piece of await pieces(node)) {
      if (current.length && !await fits(mergeDocuments([current, piece]))) { chunks.push(current); current = []; }
      if (!await fits(piece)) throw new Error("HTML構造が入力上限を超えています。");
      current = mergeDocuments([current, piece]);
    }
    if (current.length) chunks.push(current);
    return chunks;
  }
  function mergeDocuments(chunks) {
    const result = [];
    for (const node of chunks.flat()) {
      const previous = result.at(-1);
      if (node.text !== undefined && previous?.text !== undefined) previous.text += node.text;
      else if (node.id && previous?.id === node.id) previous.children = mergeDocuments([previous.children, node.children]);
      else result.push(node.text !== undefined ? { ...node } : { ...node, children: mergeDocuments([node.children]) });
    }
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
  return { MAX_TOKENS, CONTENT_PROTOCOL, DEFAULTS, LANGUAGES, settings, languages, endpoint, body, byteTokens, split, Queue, documentText, documentLength, serializeDocument, parseDocument, splitDocument, mergeDocuments };
})();
