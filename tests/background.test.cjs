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
    send: (parts, overrides = {}, tabId = 1) => listener({ type: "translate", parts, source: "en", target: "ja", ...overrides }, { id: "test", tab: { id: tabId }, frameId: 0, url: "https://example.org/private?q=secret" })
  };
}
const completion = text => ({ choices: [{ message: { content: text }, finish_reason: "stop" }] });

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
