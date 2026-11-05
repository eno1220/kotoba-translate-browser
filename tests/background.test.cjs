const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { readFileSync } = require("node:fs");
function background(responder, settings = {}) {
  let listener, active = 0, maximum = 0;
  const calls = [];
  const progress = [];
  const event = { addListener() {} };
  const context = vm.createContext({
    URL, TextEncoder, AbortController, DOMException, setTimeout, clearTimeout, DOMParser: new (require("jsdom").JSDOM)("").window.DOMParser,
    browser: {
      runtime: { id: "test", onMessage: { addListener: fn => listener = fn } },
      storage: { local: { get: async () => ({ settings }) }, onChanged: event },
      tabs: { onRemoved: event, onUpdated: event, sendMessage: async (_tab, message) => { progress.push(message); } }, contextMenus: { create() {}, onClicked: event }
    },
    fetch: async (url, options) => {
      active++; maximum = Math.max(maximum, active);
      const call = { url, options, body: JSON.parse(options.body) }; calls.push(call);
      try { return { ok: true, json: async () => await responder(call) }; }
      finally { active--; }
    }
  });
  for (const file of ["core.js", "background.js"]) vm.runInContext(readFileSync(require.resolve(`../extension/${file}`), "utf8"), context);
  return {
    calls, progress, max: () => maximum,
    send: (parts, overrides = {}, tabId = 1) => listener({ type: "translate", protocol: 3, parts, source: "en", target: "ja", ...overrides }, { id: "test", tab: { id: tabId }, frameId: 0, url: "https://example.org/private?q=secret" })
  };
}
const completion = text => ({ choices: [{ message: { content: text }, finish_reason: "stop" }] });

test("stale page scripts are rejected as a protocol mismatch without issuing any API request", async () => {
  const b = background(() => assert.fail("stale page must not dispatch a translation"));
  const result = await b.send(["Read ", "the documentation", " carefully."], { protocol: undefined });
  assert.equal(result.errorCode, "stale_content");
  assert.ok(result.error.includes("ページを再読み込み"));
  assert.equal(b.calls.length, 0);
});

test("background sends correct body, domain-only context and Bearer authentication", async () => {
  const b = background(() => completion("こんにちは"), { apiKey: "my-key" });
  const response = await b.send(["Hello"]);
  assert.equal(response.parts[0], "こんにちは");
  assert.ok(b.calls[0].body.context.includes("web page on https://example.org"));
  assert.ok(!b.calls[0].body.context.includes("private?q=secret"));
  assert.equal(b.calls[0].body.max_tokens, 8096);
  assert.equal(b.calls[0].options.headers.Authorization, "Bearer my-key");
  assert.equal(b.calls[0].options.redirect, "error");
});

test("truncated plain text is split again with accurate progress", async () => {
  let truncated = false;
  const b = background(({ body }) => {
    const input = body.messages[0].content;
    if (input.length > 40 && !truncated) { truncated = true; return { choices: [{ finish_reason: "length", message: { content: "partial" } }] }; }
    return completion(`訳:${input}`);
  });
  const input = ["A short sentence. A slightly longer sentence with more than forty letters to force splitting."];
  const result = await b.send(input, { requestId: "test-progress" });
  assert.equal(result.parts.length, 1);
  assert.ok(result.parts.every(x => x.includes("訳:")));
  assert.ok(!result.parts.join("").includes("partial"));
  assert.ok(truncated);
  assert.equal(b.progress.at(-1).completed, input.join("").length);
  assert.equal(b.progress.at(-1).total, input.join("").length);
  assert.ok(b.progress.every((event, i) => !i || event.completed >= b.progress[i - 1].completed));
});

test("two tabs share a single network queue and tokenize supports actual server counts", async () => {
  const b = background(async ({ url, body }) => {
    await new Promise(r => setTimeout(r, 2));
    return url.endsWith("/tokenize") ? { tokens: Array.from(body.content) } : completion("訳文");
  }, { tokenizer: "llama" });
  const responses = await Promise.all([b.send(["First"], {}, 1), b.send(["Second"], {}, 2)]);
  assert.equal(b.max(), 1);
  assert.ok(responses.every(x => x.parts[0] === "訳文"));
  assert.ok(b.calls.some(x => x.url.endsWith("/tokenize")));
});

test("broken inline structure retries the complete paragraph and never translates fragments", async () => {
  const b = background(({ body }) => {
    const input = body.messages[0].content;
    assert.ok(input.includes('Call <code id="k0" translate="no">request()</code> to continue.'));
    return completion('呼び出す<code id="k0" translate="no">changed()</code>続ける');
  });
  const document = [{ text: "Call " }, { tag: "code", id: "k0", protected: true, children: [{ text: "request()" }] }, { text: " to continue." }];
  const response = await b.send([], { document });
  assert.equal(response.errorCode, "structure");
  assert.equal(b.calls.length, 2);
  assert.equal(b.calls[0].body.messages[0].content, b.calls[1].body.messages[0].content);
  assert.ok(b.calls[1].body.context.includes("previous response"));
});


const batchDocuments = [
  [{ text: "First " }, { tag: "a", id: "k0", children: [{ text: "link" }] }],
  [{ text: "Second " }, { tag: "a", id: "k0", children: [{ text: "link" }] }]
];
test("batch markers map reordered results back with paragraph-local link IDs and accurate progress", async () => {
  const b = background(({ body }) => {
    assert.ok(body.context.includes("multiple independent paragraphs"));
    return completion('<kotoba-item id="b1">二番目<a id="k0">リンク</a></kotoba-item>\n<kotoba-item id="b0">最初<a id="k0">リンク</a></kotoba-item>');
  });
  const response = await b.send([], { documents: batchDocuments, requestId: "batch" });
  assert.equal(b.calls.length, 1);
  assert.equal(response.documents[0].document[0].text, "最初");
  assert.equal(response.documents[1].document[0].text, "二番目");
  assert.equal(b.progress.at(-1).completed, b.progress.at(-1).total);
  assert.equal(b.progress.at(-1).total, 21);
});

test("invalid or truncated batches fall back to whole paragraphs and retain structure errors", async () => {
  for (const bad of [
    '<kotoba-item id="b0">missing second</kotoba-item>',
    '<kotoba-item id="b0">duplicate</kotoba-item><kotoba-item id="b0">duplicate</kotoba-item>',
    '<kotoba-item id="b0">lost link</kotoba-item><kotoba-item id="b1">lost link</kotoba-item>',
    'unmarked output', null
  ]) {
    const b = background(({ body }) => {
      const input = body.messages[0].content;
      if (input.includes("kotoba-item")) return bad === null ? { choices: [{ finish_reason: "length" }] } : completion(bad);
      assert.ok(input.includes('<a id="k0">link</a>'));
      return completion(input.includes("First") ? input.replace("First", "最初") : "broken structure");
    });
    const result = await b.send([], { documents: batchDocuments });
    assert.equal(b.calls.length, 4);
    assert.equal(result.documents[0].document[0].text, "最初 ");
    assert.equal(result.documents[1].errorCode, "structure");
  }
});

test("batch packing includes marker overhead in the token budget and disabling sends separate requests", async () => {
  const documents = Array.from({ length: 5 }, () => [{ text: "Short sentence." }]);
  for (const batchTranslation of [true, false]) {
    const b = background(({ body }) => {
      const input = body.messages[0].content;
      assert.ok(Buffer.byteLength(input) <= 128);
      return completion(input);
    }, { inputTokens: 128, batchTranslation });
    const result = await b.send([], { documents });
    assert.equal(result.documents.length, 5);
    assert.equal(b.calls.length, batchTranslation ? 3 : 5);
  }
});
