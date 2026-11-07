const { test } = require("node:test");
const assert = require("node:assert/strict");
require("../extension/core.js");
globalThis.DOMParser = new (require("jsdom").JSDOM)("").window.DOMParser;
const K = globalThis.Kotoba;

test("easy Japanese is accepted and sent unchanged in both API formats", () => {
  for (const apiFormat of ["top-level", "template"]) {
    const s = K.settings({ apiFormat });
    const body = K.body(s, "日本語の文章です。", { source: "ja", target: "ja(easy)", domain: "https://example.com" });
    const options = apiFormat === "template" ? body.chat_template_kwargs : body;
    assert.equal(options.source_lang, "ja");
    assert.equal(options.target_lang, "ja(easy)");
  }
});

test("feature switches are booleans and content preferences never expose connection settings", () => {
  for (const key of K.FEATURES) {
    assert.equal(K.settings({ [key]: false })[key], false);
    assert.throws(() => K.settings({ [key]: "false" }));
  }
  const prefs = K.contentPreferences(K.settings({ apiKey: "secret", endpoint: "http://private.example" }));
  assert.equal(prefs.apiKey, undefined); assert.equal(prefs.endpoint, undefined);
  assert.equal(prefs.mainContentOnly, false); assert.equal(prefs.responsiveScan, true);
  assert.equal(prefs.readingOrder, true); assert.equal(prefs.maxBatchItems, 32);
});

test('batch tuning validates limits and context describes the situation without instructions', () => {
  for (const [key, min, max] of [['maxBatchItems', 1, 256], ['batchStartItems', 1, 256], ['batchStartTokens', 128, 24000], ['batchGrowthFactor', 2, 4], ['batchTargetSeconds', 1, 60]]) {
    assert.equal(K.settings({ [key]: String(min) })[key], min);
    for (const value of [min - 1, max + 1, min + 0.5]) assert.throws(() => K.settings({ [key]: value }));
  }
  for (const apiFormat of ['top-level', 'template']) {
    const body = K.body(K.settings({ apiFormat }), '<p id="b0">Read.</p>', { source: 'en', target: 'ja', domain: 'https://example.com', html: true, batch: true, retry: true });
    const context = apiFormat === 'template' ? body.chat_template_kwargs.context : body.context;
    assert.match(context, /web page on https:\/\/example.com/); assert.match(context, /HTML fragment/);
    assert.doesNotMatch(context, /preserve|never|return only|previous response|check every|without Markdown/i);
    assert.deepEqual(body.messages, [{ role: 'user', content: '<p id="b0">Read.</p>' }]);
  }
});

test("request formats, Bearer-independent body and endpoint composition", () => {
  const s = K.settings();
  assert.equal(K.endpoint(s), "http://127.0.0.1:8000/v1/chat/completions");
  const page = { source: "en", target: "ja", domain: "https://example.com" };
  const body = K.body(s, "Hello", page);
  assert.ok(body.context.includes(page.domain));
  assert.ok(body.context.includes("web page"));
  assert.equal(body.max_tokens, 8096);
  assert.deepEqual(body.messages, [{ role: "user", content: "Hello" }]);
  assert.equal(body.source_lang, "en");
  assert.equal(body.use_glossary, false);
  const official = K.body({ ...s, apiFormat: "template" }, "Hello", { ...page, source: "auto" });
  assert.equal(official.chat_template_kwargs.target_lang, "ja");
  assert.ok(official.chat_template_kwargs.context.includes("web page"));
  assert.equal(official.chat_template_kwargs.source_lang, undefined);
  assert.equal(official.target_lang, undefined);
  assert.throws(() => K.settings({ endpoint: "https://name:secret@example.com" }));
  assert.throws(() => K.settings({ port: "70000" }));
});

test("long Unicode text is split losslessly under the token budget", async () => {
  const source = "This is a complete sentence. More words here!\n\n日本語の文章です。絵文字🧑‍💻も保持します。\n".repeat(100);
  const parts = await K.split(source, 128);
  assert.equal(parts.join(""), source);
  assert.ok(parts.length > 2);
  assert.ok(parts.every(x => K.byteTokens(x) <= 128));
  assert.ok(parts.every(x => !/[\uD800-\uDBFF]$/.test(x)));
});

test("paragraph HTML accepts free prose and sibling reordering, rejects missing/duplicate links and injected markup", () => {
  const document = [{ text: "Read " }, { tag: "a", id: "k0", children: [{ text: "earlier posts" }] }, { text: " about " }, { tag: "a", id: "k1", children: [{ text: "assembly" }] }, { text: "." }];
  const result = K.parseDocument('以前の<a id="k1">アセンブリ言語</a>についての<a id="k0">投稿</a>を読んだ方は。', document);
  assert.equal(result[1].id, "k1");
  assert.equal(K.documentText(result), "以前のアセンブリ言語についての投稿を読んだ方は。");
  for (const input of ['<a id="k0">x</a>', '<a id="k0">x</a><a id="k0">x</a><a id="k1">y</a>', '<a id="k0"><img src="x"/></a><a id="k1">y</a>', '<a id="k0"></a><a id="k1">y</a>', '<a id="k0" href="evil">x</a><a id="k1">y</a>']) assert.throws(() => K.parseDocument(input, document));
});

test("long paragraph HTML chunks remain bounded and merge without losing link identity", async () => {
  const document = [{ text: "A complete sentence. ".repeat(20) }, { tag: "a", id: "k0", children: [{ text: "A linked sentence. ".repeat(20) }] }, { text: " A final sentence." }];
  const chunks = await K.splitDocument(document, 128);
  assert.ok(chunks.length > 2);
  assert.ok(chunks.every(chunk => K.byteTokens(K.serializeDocument(chunk)) <= 128));
  const merged = K.mergeDocuments(chunks);
  assert.deepEqual(merged, document);
  assert.deepEqual(K.parseDocument(K.serializeDocument(merged), document), document);
});

test("global queue is serial by default and removes cancelled waiters", async () => {
  const q = new K.Queue();
  let active = 0, maximum = 0, release;
  const first = q.run(async () => { active++; maximum = Math.max(maximum, active); await new Promise(r => release = r); active--; });
  await new Promise(r => setImmediate(r));
  const abort = new AbortController();
  const cancelled = q.run(() => assert.fail("cancelled request was dispatched"), abort.signal);
  abort.abort(); await assert.rejects(cancelled, { name: "AbortError" });
  const last = q.run(async () => { active++; maximum = Math.max(maximum, active); active--; });
  release(); await Promise.all([first, last]);
  assert.equal(maximum, 1);
});


test("HTML entities decode as text while unknown entities and markup stay invalid", () => {
  const source = [{ text: " Read " }, { tag: "a", id: "k0", children: [{ text: "docs" }] }, { text: " carefully. " }];
  const result = K.parseDocument('読む &copy; &mdash; <a id="k0">資料&nbsp;&eacute;</a> &lt;img&gt;', source);
  assert.equal(K.documentText(result), " 読む © — 資料\u00a0é <img> ");
  assert.throws(() => K.parseDocument('<a id="k0">&unknown;</a>', source));
  assert.throws(() => K.parseDocument('<a id="k0" onclick="bad()">資料</a>', source));
  assert.deepEqual(K.parseDocument(K.serializeDocument(result), source), result);
});

test("bare ampersands in translated prose preserve text without weakening structure checks", () => {
  const source = [{ text: "\n\t" }, { tag: "span", id: "k0", children: [{ text: "スタッフ・キャスト" }] }, { text: "\n" }];
  const result = K.parseDocument('<span id="k0">Staff & Cast &amp; R&D &#38; &#x26;</span>', source);
  assert.equal(K.documentText(result), "\n\tStaff & Cast & R&D & &\n");
  assert.deepEqual(K.parseDocument(K.serializeDocument(result), source), result);
  for (const invalid of [
    '<span id="k0"><Tsukuyomi> & Cast</span>',
    '<span id="k0">Staff & Cast',
    '<span id="k0" onclick="bad & worse">Staff & Cast</span>'
  ]) assert.throws(() => K.parseDocument(invalid, source));
});

test("fitting HTML skips per-node tokenization and split handles UTF-8 byte edges", async () => {
  const tree = Array.from({ length: 100 }, (_, i) => ({ tag: "span", id: `k${i}`, children: [{ text: "word" }] }));
  let calls = 0;
  assert.deepEqual(await K.splitDocument(tree, 10000, text => { calls++; return K.byteTokens(text); }), [tree]);
  assert.equal(calls, 1);
  const text = "Aé字🧑‍💻 & < > ".repeat(100);
  for (const limit of [4, 17, 128]) {
    const parts = await K.split(text, limit);
    assert.equal(parts.join(""), text);
    assert.ok(parts.every(part => K.byteTokens(part) <= limit));
  }
  const linked = [{ tag: "a", id: "k0", children: [{ text }] }];
  const parts = await K.splitDocument(linked, 128);
  assert.deepEqual(K.mergeDocuments(parts), linked);
  assert.ok(parts.every(part => K.byteTokens(K.serializeDocument(part)) <= 128));
});

test("dictionary validates limits, duplicate terms and normalized exact domains", () => {
  const entry = { domain: "", sourceLang: "en", targetLang: "ja", source: "File", target: "ファイル" };
  assert.deepEqual(K.settings().dictionary, []);
  assert.equal(K.dictionary([{ ...entry, domain: "EXAMPLE.COM." }])[0].domain, "example.com");
  assert.throws(() => K.dictionary([entry, entry]), /重複/);
  for (const invalid of [{ source: " " }, { target: "x".repeat(101) }, { source: "<|plamo:tag|>" }, { domain: "example.com/path" }, { domain: "example.com:8000" }, { targetLang: "unknown" }]) assert.throws(() => K.dictionary([{ ...entry, ...invalid }]));
  assert.throws(() => K.dictionary(Array.from({ length: 101 }, (_, i) => ({ ...entry, source: `word${i}` }))), /100件/);
  assert.throws(() => K.dictionary(Array.from({ length: 21 }, (_, i) => ({ ...entry, domain: `d${i}.example` }))), /20件/);
  assert.throws(() => K.dictionary(Array.from({ length: 501 }, () => entry)), /500件/);
  assert.throws(() => K.dictionary(Array.from({ length: 30 }, (_, i) => ({ ...entry, source: `${i}${"語".repeat(40)}`, target: "訳".repeat(40) }))), /6000/);
});

test("dictionary merges language and domain overrides into both API formats", () => {
  const entry = { domain: "", sourceLang: "auto", targetLang: "ja", source: "File", target: "共通" };
  const dictionary = [entry, { ...entry, sourceLang: "en", target: "英語共通" }, { ...entry, domain: "example.com", target: "専用" }, { ...entry, targetLang: "ko", target: "다른" }];
  for (const apiFormat of ["top-level", "template"]) {
    const s = K.settings({ dictionary, apiFormat });
    for (const [domain, source, expected] of [["https://example.com", "en", "専用"], ["http://example.com:8080", "auto", "専用"], ["https://sub.example.com", "en", "英語共通"], ["https://other.com", "auto", "共通"]]) {
      const body = K.body(s, "File", { domain, source, target: "ja" });
      assert.deepEqual((body.chat_template_kwargs || body).glossary, [{ source: "File", target: expected }]);
      if (apiFormat === "top-level") assert.equal(body.use_glossary, true);
      assert.equal(body.messages[0].content, "File");
    }
    assert.equal(K.contentPreferences(s).dictionary, undefined);
  }
});

test('extended context budgets reserve output, instructions and glossary instead of blindly filling 32768', () => {
  const page = { source: 'en', target: 'ja', domain: 'https://example.com' };
  const s = K.settings({ inputTokens: 24000, contextTokens: 32768 });
  const budget = K.inputBudget(s, page);
  assert.ok(budget > 20000 && budget < 24000);
  assert.ok(budget + K.MAX_TOKENS + 512 < s.contextTokens);
  const dictionary = [{ domain: '', sourceLang: 'en', targetLang: 'ja', source: 'Term'.repeat(20), target: '訳'.repeat(80) }];
  assert.ok(K.inputBudget(K.settings({ ...s, dictionary }), page) < budget);
  assert.throws(() => K.inputBudget(K.settings({ contextTokens: 8192 }), page), /コンテキスト長/);
  assert.throws(() => K.settings({ inputTokens: 24001 }));
});

test('only source-present glossary terms are sent, without reducing the reserved context budget', () => {
  const dictionary = ['File', 'Absent', 'file'].map(source => ({ domain: '', sourceLang: 'en', targetLang: 'ja', source, target: '訳語' }));
  const s = K.settings({ dictionary, inputTokens: 24000 });
  const page = { source: 'en', target: 'ja', domain: 'https://example.org' };
  assert.deepEqual(K.body(s, 'Open File.', page).glossary.map(term => term.source), ['File']);
  assert.deepEqual(K.body({ ...s, relevantGlossary: false }, 'Open File.', page).glossary.map(term => term.source), ['File', 'Absent', 'file']);
  assert.equal(K.inputBudget(s, page), K.inputBudget({ ...s, relevantGlossary: false }, page));
});

test('server check defaults off and validates its switch and same-server path', () => {
  assert.equal(K.settings().serverCheck, false);
  assert.equal(K.settings().healthPath, '/health');
  assert.throws(() => K.settings({ serverCheck: 'true' }));
  for (const healthPath of ['https://other.example/health', '//other.example/health', '/health?model=x', '/health#x']) {
    assert.throws(() => K.settings({ healthPath }));
  }
  const s = K.settings({ endpoint: 'http://localhost/service', port: '8765', healthPath: '/healthz' });
  assert.equal(K.endpoint(s, s.healthPath), 'http://localhost:8765/service/healthz');
});
