const { test } = require("node:test");
const assert = require("node:assert/strict");
require("../extension/core.js");
const K = globalThis.Kotoba;

test("request formats, Bearer-independent body and endpoint composition", () => {
  const s = K.settings();
  assert.equal(K.endpoint(s), "http://127.0.0.1:8000/v1/chat/completions");
  const page = { source: "en", target: "ja", domain: "https://example.com" };
  const body = K.body(s, "Hello", page);
  assert.equal(body.context, page.domain);
  assert.equal(body.max_tokens, 8096);
  assert.deepEqual(body.messages, [{ role: "user", content: "Hello" }]);
  assert.equal(body.source_lang, "en");
  assert.equal(body.use_glossary, false);
  const official = K.body({ ...s, apiFormat: "template" }, "Hello", { ...page, source: "auto" });
  assert.equal(official.chat_template_kwargs.target_lang, "ja");
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

test("markers reject lost, reordered, injected and empty segments", () => {
  assert.deepEqual(K.parse(K.serialize(["A < B & C", "link"]), 2), ["A < B & C", "link"]);
  for (const input of ["<t1>x</t1><t0>y</t0>", "<t0>x</t0>", "<t0><img src=x></t0><t1>y</t1>", "<t0></t0><t1>y</t1>", "<t0>x</t0><t1>y</t1>extra"]) assert.throws(() => K.parse(input, 2));
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
