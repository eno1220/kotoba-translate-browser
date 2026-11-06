const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { readFileSync } = require("node:fs");
function background(responder, settings = {}, storage = {}) {
  let listener, commandListener, menuListener, settingsChanged, active = 0, maximum = 0, reads = 0, pageState = {};
  let now = Date.now();
  const calls = [];
  const progress = [];
  const clipboard = [];
  const menus = [], pageMessages = [], badges = [];
  const event = { addListener() {} };
  const context = vm.createContext({
    console, URL, TextEncoder, TextDecoder, AbortController, DOMException, setTimeout, clearTimeout, setInterval() {}, Date: class extends Date { static now() { return now; } }, DOMParser: new (require("jsdom").JSDOM)("").window.DOMParser,
    navigator: { clipboard: { writeText: async text => clipboard.push(text) } },
    browser: {
      runtime: { getManifest: () => ({ version: "0.1.3" }), id: "test", getURL: path => `moz-extension://test/${path}`, onMessage: { addListener: fn => listener = fn } },
      storage: { local: { get: async key => { reads++; return key === "settings" ? { settings } : structuredClone(storage); }, set: async values => Object.assign(storage, structuredClone(values)) }, onChanged: { addListener: fn => settingsChanged = fn } },
      tabs: { onRemoved: event, onUpdated: event, query: async () => [], sendMessage: async (tabId, message, options) => { progress.push(message); pageMessages.push({ tabId, message, options }); return message.type === "status" ? pageState : { protocol: 6 }; } },
      browserAction: { setBadgeText: async value => badges.push(value), setTitle: async () => {} },
      commands: { onCommand: { addListener: fn => commandListener = fn } }, contextMenus: { create: value => menus.push(value), onClicked: { addListener: fn => menuListener = fn } }
    },
    fetch: async (url, options) => {
      active++; maximum = Math.max(maximum, active);
      const call = { url, options, body: JSON.parse(options.body) }; calls.push(call);
      try {
        const result = await responder(call);
        if (result instanceof Response) return result;
        return { ok: !result.httpStatus, status: result.httpStatus, headers: { get: () => result.retryAfter }, json: async () => result };
      }
      finally { active--; }
    }
  });
  for (const file of ["core.js", "background.js"]) vm.runInContext(readFileSync(require.resolve(`../extension/${file}`), "utf8"), context);
  return {
    calls, progress, clipboard, menus, pageMessages, badges, max: () => maximum, reads: () => reads,
    pageState: value => pageState = value,
    menu: (info, tab = { id: 1, url: "https://example.org" }) => menuListener(info, tab),
    command: (name, tab = { id: 1, url: "https://example.org" }) => commandListener(name, tab),
    content: message => listener(message, { id: "test", tab: { id: 1 }, frameId: 0, url: "http://example.org" }),
    tick: milliseconds => now += milliseconds,
    configure: values => { settings = { ...settings, ...values }; settingsChanged({ settings: { newValue: settings } }, "local"); },
    control: message => listener(message, { id: "test" }),
    extension: message => listener(message, { id: "test", tab: { id: 20 }, url: "moz-extension://test/options.html" }),
    send: (parts, overrides = {}, tabId = 1, sender = {}) => listener({ type: "translate", protocol: 6, parts, source: "en", target: "ja", ...overrides }, { id: "test", tab: { id: tabId }, frameId: 0, url: "https://example.org/private?q=secret", ...sender })
  };
}
const completion = text => ({ choices: [{ message: { content: text }, finish_reason: "stop" }] });

test("background accepts easy Japanese settings and translation requests", async () => {
  for (const apiFormat of ["top-level", "template"]) {
    const b = background(() => completion("やさしい日本語です。"), { target: "ja(easy)", apiFormat });
    const preferences = await b.control({ type: "preferences" });
    assert.equal(preferences.target, "ja(easy)");
    const result = await b.send(["日本語の文章です。"], { source: "ja", target: "ja(easy)" });
    assert.equal(result.error, undefined);
    assert.equal(result.parts[0], "やさしい日本語です。");
    const options = apiFormat === "template" ? b.calls[0].body.chat_template_kwargs : b.calls[0].body;
    assert.equal(options.target_lang, "ja(easy)");
  }
});

test("context menu starts and stops the top page with its languages, restores it and keeps selection frames", async () => {
  const b = background(() => assert.fail("menu control must not call the model"), { keyboardShortcuts: false });
  assert.equal(b.menus.length, 3);
  b.pageState({ source: "de", target: "en", running: false });
  await b.menu({ menuItemId: "kotoba-page", frameId: 7 });
  assert.equal(b.pageMessages.at(-1).message.type, "start");
  assert.equal(b.pageMessages.at(-1).message.source, "de");
  assert.equal(b.pageMessages.at(-1).message.target, "en");
  assert.equal(b.pageMessages.at(-1).options.frameId, 0);
  b.pageState({ source: "de", target: "en", running: true });
  await b.menu({ menuItemId: "kotoba-page" });
  assert.equal(b.progress.at(-1).type, "stop");
  await b.menu({ menuItemId: "kotoba-restore" });
  assert.equal(b.progress.at(-1).type, "restore");
  await b.menu({ menuItemId: "kotoba-selection", selectionText: "Selected frame text", frameId: 7 });
  assert.equal(b.pageMessages.at(-1).message.text, "Selected frame text");
  assert.equal(b.pageMessages.at(-1).options.frameId, 7);
  assert.equal(b.badges.at(-1).text, "");
  const count = b.pageMessages.length;
  await b.menu({ menuItemId: "kotoba-page" }, { id: 1, url: "about:config" });
  assert.equal(b.pageMessages.length, count);
});

test("copy is allowed only when enabled and shortcuts respect their switch and restricted pages", async () => {
  const b = background(() => assert.fail("control actions must not call the model"), { copyButton: false, keyboardShortcuts: false, apiKey: "secret" });
  assert.ok((await b.content({ type: "copyText", text: "訳文" })).error);
  assert.equal(b.clipboard.length, 0);
  await b.command("translate-page"); assert.equal(b.progress.length, 0);
  b.configure({ copyButton: true, keyboardShortcuts: true });
  await b.content({ type: "copyText", text: "訳文" }); assert.deepEqual(b.clipboard, ["訳文"]);
  await b.command("translate-page", { id: 1, url: "about:config" }); assert.equal(b.progress.length, 0);
  await b.command("translate-page");
  assert.equal(b.progress.at(-1).type, "start"); assert.equal(b.progress.at(-1).target, "ja");
  await b.command("restore-page"); assert.equal(b.progress.at(-1).type, "restore");
  const prefs = await b.content({ type: "contentPreferences" });
  assert.equal(prefs.apiKey, undefined); assert.equal(prefs.keyboardShortcuts, true);
});

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
  assert.equal(b.calls[1].body.context, b.calls[0].body.context);
  assert.doesNotMatch(b.calls[1].body.context, /preserve|return only|never|check every/i);
});


const batchDocuments = [
  [{ text: "First " }, { tag: "a", id: "k0", children: [{ text: "link" }] }],
  [{ text: "Second " }, { tag: "a", id: "k0", children: [{ text: "link" }] }]
];
test("batch markers map reordered results back with paragraph-local link IDs and accurate progress", async () => {
  const b = background(({ body }) => {
    assert.ok(body.context.includes("multiple independent paragraphs"));
    return completion('<p id="b1">二番目&copy;<a id="k0">リンク</a></p>\n<p id="b0">最初<a id="k0">リンク</a></p>');
  });
  const response = await b.send([], { documents: batchDocuments, requestId: "batch" });
  assert.equal(b.calls.length, 1);
  assert.equal(response.documents[0].document[0].text, "最初");
  assert.equal(response.documents[1].document[0].text, "二番目©");
  assert.equal(b.progress.at(-1).completed, b.progress.at(-1).total);
  assert.equal(b.progress.at(-1).total, 21);
});

test("bare ampersands in batch output do not trigger paragraph retries", async () => {
  const b = background(() => completion('<p id="b0"><span id="k0">Staff & Cast</span></p>\n<p id="b1"><span id="k0">Music &amp; Songs</span></p>'));
  const documents = ["スタッフ・キャスト", "音楽"].map(text => [{ tag: "span", id: "k0", children: [{ text }] }]);
  const response = await b.send([], { documents, source: "ja", target: "en" });
  assert.equal(b.calls.length, 1);
  assert.equal(response.documents[0].document[0].children[0].text, "Staff & Cast");
  assert.equal(response.documents[1].document[0].children[0].text, "Music & Songs");
});

test("invalid or truncated batches fall back to whole paragraphs and retain structure errors", async () => {
  for (const bad of [
    '<p id="b0">missing second</p>',
    '<p id="b0">duplicate</p><p id="b0">duplicate</p>',
    '<p id="b0">lost link</p><p id="b1">lost link</p>',
    'unmarked output', null
  ]) {
    const b = background(({ body }) => {
      const input = body.messages[0].content;
      if (input.includes('<p id="b')) return bad === null ? { choices: [{ finish_reason: "length" }] } : completion(bad);
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
    assert.equal(b.calls.length, batchTranslation ? 2 : 5);
  }
});

test('repetitive batches translate exact structures once and deliver every original index without a cache', async () => {
  const variants = [
    [{ text: 'City.' }],
    [{ tag: 'a', id: 'k0', children: [{ text: 'Store.' }] }],
    [{ tag: 'a', id: 'k1', children: [{ text: 'Store.' }] }],
    [{ tag: 'span', id: 'k0', protected: true, children: [{ text: 'Brand' }] }, { text: ' store.' }]
  ];
  const documents = Array.from({ length: 256 }, (_, i) => variants[i % variants.length]);
  const b = background(({ body }) => {
    const input = body.messages[0].content;
    assert.equal((input.match(/<p id="b/g) || []).length, 4);
    assert.ok(Buffer.byteLength(input) <= 512);
    return completion(input.replaceAll('City.', '都市。').replaceAll('Store.', '店舗。').replaceAll(' store.', ' 店舗。'));
  }, { inputTokens: 512, cacheMinutes: 0 });
  const result = await b.send([], { documents, repetitive: true, requestId: 'repeated-table' });
  assert.equal(b.calls.length, 1); assert.equal(result.documents.length, 256);
  for (let index = 0; index < 256; index++) {
    const tree = result.documents[index].document;
    if (index % 4 === 0) assert.equal(tree[0].text, '都市。');
    else if (index % 4 === 3) { assert.equal(tree[0].children[0].text, 'Brand'); assert.equal(tree[1].text, ' 店舗。'); }
    else { assert.equal(tree[0].id, variants[index % 4][0].id); assert.equal(tree[0].children[0].text, '店舗。'); }
  }
  const deliveries = b.progress.flatMap(value => value.results || []);
  assert.equal(deliveries.length, 256); assert.equal(new Set(deliveries.map(value => value.index)).size, 256);
  assert.deepEqual(deliveries.map(value => value.index), Array.from({ length: 256 }, (_, i) => i));
  const last = b.progress.at(-1);
  assert.equal(last.completed, last.total);
  assert.ok(b.progress.every(value => value.completed <= value.total));
  await b.send([], { documents, repetitive: true }); assert.equal(b.calls.length, 2);
});

test('ordinary paragraph batches keep repeated text in its own paragraph contexts', async () => {
  const b = background(({ body }) => {
    assert.equal((body.messages[0].content.match(/<p id="b/g) || []).length, 3);
    return completion('<p id="b0">First context.</p><p id="b1">Second context.</p><p id="b2">Third context.</p>');
  }, { cacheMinutes: 0 });
  const result = await b.send([], { documents: Array.from({ length: 3 }, () => [{ text: 'Repeated prose.' }]) });
  assert.deepEqual(Array.from(result.documents, item => item.document[0].text), ['First context.', 'Second context.', 'Third context.']);
});

test('output-limited batches split into smaller batches without disabling further batching', async () => {
  const documents = Array.from({ length: 8 }, (_, i) => [{ text: `Paragraph ${i}.` }]);
  const b = background(({ body }) => {
    const input = body.messages[0].content;
    const paragraphs = (input.match(/<p id="b/g) || []).length;
    if (paragraphs > 4) return { choices: [{ message: { content: 'unfinished' }, finish_reason: 'length' }] };
    assert.equal(paragraphs, 4);
    return completion(input.replaceAll('Paragraph', '段落'));
  });
  const result = await b.send([], { documents, requestId: 'split-batch' });
  assert.equal(b.calls.length, 3); assert.equal(result.batchFallback, false);
  assert.deepEqual(Array.from(result.documents, item => item.document[0].text), Array.from({ length: 8 }, (_, i) => `段落 ${i}.`));
  assert.equal(b.progress.at(-1).completed, b.progress.at(-1).total);
  const history = await b.control({ type: 'cacheHistory' });
  assert.equal(history.rows[0].truncations, 1); assert.equal(history.rows[0].batchFallbacks, 0);
});

test('broken link markup reduces batches and completes their paragraphs in order', async () => {
  const sizes = [];
  const b = background(({ body }) => {
    const input = body.messages[0].content, count = (input.match(/<p id="b/g) || []).length; sizes.push(count);
    // Like the supplied log: an anchor's closing tag disappears in a batch.
    return completion(count > 2 ? input.replace('</a>', '') : input.replaceAll('Read', '読む'));
  }, { cacheMinutes: 0 });
  const documents = Array.from({ length: 8 }, (_, i) => [{ text: `Read ${i} ` }, { tag: 'a', id: 'k0', children: [{ text: 'the docs' }] }]);
  const result = await b.send([], { documents, requestId: 'broken-batch' });
  assert.deepEqual(sizes, [8, 4, 2, 2, 2, 2]);
  assert.equal(result.batchLimit, 2); assert.equal(result.batchFallback, true);
  assert.deepEqual(Array.from(result.documents, item => item.document[0].text), Array.from({ length: 8 }, (_, i) => `読む ${i} `));
  assert.deepEqual(b.progress.flatMap(value => value.results || []).map(value => value.index), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(b.progress.at(-1).completed, b.progress.at(-1).total);
});

test('size-related API errors split batches while authentication errors stop without extra calls', async () => {
  const documents = Array.from({ length: 4 }, (_, i) => [{ text: `Paragraph ${i}.` }]);
  for (const status of [413, 400, 401]) {
    const b = background(({ body }) => {
      const input = body.messages[0].content;
      if ((input.match(/<p id="b/g) || []).length > 2) return new Response('input exceeds the context length', { status });
      return completion(input);
    });
    const result = await b.send([], { documents });
    if (status === 401) { assert.match(result.error, /401/); assert.equal(b.calls.length, 1); }
    else { assert.equal(result.documents.length, 4); assert.equal(result.batchLimit, 2); assert.equal(b.calls.length, 3); }
  }
});

test('reading order buffers later cache hits until earlier fresh paragraphs are ready', async () => {
  let release;
  const b = background(({ body }) => body.messages[0].content === 'Earlier.'
    ? new Promise(resolve => release = () => resolve(completion('先。'))) : completion('後。'));
  const later = [{ text: 'Later.' }];
  await b.send([], { document: later });
  const pending = b.send([], { documents: [[{ text: 'Earlier.' }], later], requestId: 'ordered-cache' });
  for (let i = 0; i < 20 && !release; i++) await new Promise(setImmediate);
  assert.ok(release);
  assert.ok(b.progress.filter(value => value.requestId === 'ordered-cache').every(value => !value.results));
  release(); const result = await pending;
  assert.deepEqual(b.progress.filter(value => value.requestId === 'ordered-cache').flatMap(value => value.results || []).map(value => value.index), [0, 1]);
  assert.equal(result.documents[0].document[0].text, '先。'); assert.equal(result.documents[1].document[0].text, '後。');
});

test("page cache reuses validated paragraphs across tabs and mixed batches without renewing expiry", async () => {
  const b = background(({ body }) => completion(body.messages[0].content.replaceAll("First", "最初").replaceAll("Second", "二番目")));
  const document = [{ text: "First sentence." }];
  await b.send([], { document });
  b.tick(20 * 60000);
  const hit = await b.send([], { documents: [document, [{ text: "Second sentence." }]], requestId: "cached" }, 2);
  assert.equal(hit.documents[0].document[0].text, "最初 sentence.");
  assert.equal(b.calls.length, 2);
  assert.equal(b.progress.at(-1).completed, b.progress.at(-1).total);
  b.tick(11 * 60000);
  await b.send([], { document });
  assert.equal(b.calls.length, 3);
});

test("cache isolates URLs, languages, structure and settings; private and selection translations are uncached", async () => {
  const b = background(({ body }) => completion(body.messages[0].content));
  const document = [{ text: "First sentence." }];
  await b.send([], { document });
  await b.send([], { document }, 2, { url: "https://example.org/other" });
  await b.send([], { document, target: "ko" });
  await b.send([], { document: [{ tag: "a", id: "k0", children: document }] });
  await b.send([], { document }, 2, { tab: { id: 2, incognito: true } });
  await b.send(["First sentence."]);
  await b.send(["First sentence."]);
  assert.equal(b.calls.length, 7);
  b.configure({ model: "other-model" });
  await b.send([], { document });
  assert.equal(b.calls.length, 8);
  b.configure({ cacheMinutes: 0 });
  await b.send([], { document }); await b.send([], { document });
  assert.equal(b.calls.length, 10);
});

test("restore lookup returns only matching page data with no API or credentials, and clear prevents in-flight refill", async () => {
  let release;
  const b = background(async ({ body }) => {
    if (body.messages[0].content === "Pending sentence.") await new Promise(resolve => release = resolve);
    return completion("訳文");
  }, { apiKey: "secret-key" });
  const document = [{ text: "First sentence." }];
  await b.send([], { document });
  await b.send([], { type: "restoreCachedPage" });
  const restored = b.progress.find(message => message.type === "restoreCache");
  assert.equal(restored.source, "en"); assert.equal(restored.target, "ja");
  assert.equal(restored.entries[0].input, JSON.stringify(document));
  assert.ok(!JSON.stringify(restored).includes("secret-key"));
  assert.equal(b.calls.length, 1);
  const pending = b.send([], { document: [{ text: "Pending sentence." }] });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await b.control({ type: "clearCache" });
  release(); await pending;
  b.progress.length = 0;
  await b.send([], { type: "restoreCachedPage" });
  assert.equal(b.progress.length, 0);
});

test("packed responses deliver validated paragraphs before later API calls finish", async () => {
  let release, settled = false;
  const b = background(({ body }) => {
    const input = body.messages[0].content;
    if (b.calls.length === 2) return new Promise(resolve => { release = () => resolve(completion(input)); });
    return completion(input);
  }, { inputTokens: 128, cacheMinutes: 0 });
  const documents = Array.from({ length: 5 }, (_, i) => [{ text: `Paragraph ${i}.` }]);
  const pending = b.send([], { documents, requestId: "incremental" }).then(result => { settled = true; return result; });
  for (let i = 0; i < 100 && !release; i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(release); assert.equal(settled, false);
  const early = b.progress.flatMap(message => message.results || []);
  assert.deepEqual(early.map(result => result.index), [0, 1, 2, 3]);
  assert.equal(early[0].document[0].text, "Paragraph 0.");
  release(); const result = await pending;
  assert.equal(result.documents.length, 5);
  assert.deepEqual(b.progress.flatMap(message => message.results || []).map(result => result.index), [0, 1, 2, 3, 4]);
  assert.equal(b.progress.at(-1).completed, b.progress.at(-1).total);
});

test("progress distinguishes waiting in the shared queue from awaiting a server response", async () => {
  let release;
  const b = background(({ body }) => body.messages[0].content === "First" ? new Promise(resolve => { release = () => resolve(completion("最初")); }) : completion("次"));
  const first = b.send(["First"], { requestId: "first" }, 1);
  for (let i = 0; i < 100 && !release; i++) await new Promise(resolve => setImmediate(resolve));
  const second = b.send(["Second"], { requestId: "second" }, 2);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(b.progress.some(message => message.requestId === "first" && message.phase === "translating"));
  assert.ok(b.progress.some(message => message.requestId === "second" && message.phase === "queued"));
  assert.ok(!b.progress.some(message => message.requestId === "second" && message.phase === "translating"));
  release(); await Promise.all([first, second]);
  assert.ok(b.progress.some(message => message.requestId === "second" && message.phase === "translating"));
  assert.equal(b.max(), 1);
});

test("page and selection requests use the sender domain dictionary and edits invalidate cache", async () => {
  const entry = { domain: "", sourceLang: "en", targetLang: "ja", source: "File", target: "共通" };
  const dictionary = [entry, { ...entry, domain: "example.org", target: "専用" }];
  const b = background(() => completion("ファイル"), { dictionary });
  await b.send(["File"], { domain: "https://attacker.example" });
  assert.equal(b.calls[0].body.glossary[0].target, "専用");
  const document = [{ text: "File" }];
  await b.send([], { document });
  await b.send([], { document });
  assert.equal(b.calls.length, 2);
  b.configure({ dictionary: [entry] });
  await b.send([], { document });
  assert.equal(b.calls.length, 3);
  assert.equal(b.calls[2].body.glossary[0].target, "共通");
  b.configure({ dictionary: [] });
  await b.send(["File"]);
  assert.equal(b.calls[3].body.glossary, undefined);
  assert.equal(b.calls[3].body.use_glossary, false);
});

test("settings reads are shared across requests and invalidated by edits; token counts stay job-local", async () => {
  const b = background(({ url, body }) => url.endsWith('/tokenize') ? { count: body.content.length } : completion('訳文'), { tokenizer: 'llama', cacheMinutes: 0 });
  const document = [{ text: 'Repeated sentence.' }];
  await Promise.all([b.control({ type: 'preferences' }), b.control({ type: 'preferences' })]);
  await b.send([], { document });
  assert.equal(b.reads(), 1);
  assert.equal(b.calls.filter(call => call.url.endsWith('/tokenize')).length, 1);
  await b.send([], { document });
  assert.equal(b.calls.filter(call => call.url.endsWith('/tokenize')).length, 2);
  b.configure({ model: 'updated-model' });
  await b.send(['New sentence.']);
  assert.equal(b.reads(), 2);
  assert.equal(b.calls.at(-1).body.model, 'updated-model');
});

test("optional retry is bounded, respects HTTP status and keeps the queue free during backoff", async () => {
  for (const [retryTransient, httpStatus, expected] of [[false, 503, 1], [true, 401, 1], [true, 503, 3]]) {
    const b = background(() => ({ httpStatus, retryAfter: '0' }), { retryTransient });
    assert.ok((await b.send(['Hello.'])).error);
    assert.equal(b.calls.length, expected);
  }
  let first = true;
  const b = background(({ body }) => {
    if (body.messages[0].content === 'First' && first) { first = false; return { httpStatus: 429, retryAfter: '0.05' }; }
    return completion('訳文');
  }, { retryTransient: true });
  const pending = b.send(['First'], { requestId: 'retry' });
  for (let i = 0; i < 20 && !b.progress.some(p => p.phase === 'retrying'); i++) await new Promise(setImmediate);
  assert.ok(b.progress.some(p => p.phase === 'retrying'));
  const second = await b.send(['Second'], {}, 2);
  assert.equal(second.parts[0], '訳文');
  assert.equal((await pending).parts[0], '訳文');
  assert.deepEqual(b.calls.map(call => call.body.messages[0].content), ['First', 'Second', 'First']);
  assert.equal(b.max(), 1);
});

test("Stop interrupts retry backoff without another request and connection probes never save settings", async () => {
  const b = background(() => ({ httpStatus: 503, retryAfter: '10' }), { retryTransient: true });
  const pending = b.send(['Hello.'], { requestId: 'cancel-retry' });
  for (let i = 0; i < 20 && !b.progress.some(p => p.phase === 'retrying'); i++) await new Promise(setImmediate);
  assert.ok(b.progress.some(p => p.phase === 'retrying'));
  await b.content({ type: 'cancel' });
  assert.ok((await pending).error);
  assert.equal(b.calls.length, 1);
  const probe = background(() => completion('訳文'), { model: 'saved-model' });
  assert.ok((await probe.content({ type: 'testConnection', settings: {} })).error);
  const result = await probe.extension({ type: 'testConnection', settings: { model: 'unsaved-model', apiKey: 'probe-key' } });
  assert.equal(result.milliseconds, 0);
  assert.equal(probe.calls[0].body.model, 'unsaved-model');
  assert.equal(probe.calls[0].options.headers.Authorization, 'Bearer probe-key');
  await probe.send(['Hello.']);
  assert.equal(probe.calls.at(-1).body.model, 'saved-model');
});

test('cache history groups a page run, measures API speed, and shrinks with live cache entries', async () => {
  const b = background(() => {
    b.tick(200);
    return { ...completion('訳文'), usage: { completion_tokens: 10 } };
  }, { cacheMinutes: 1, apiKey: 'never-expose-me' });
  const first = [{ text: 'First paragraph.' }], second = [{ text: 'Second paragraph.' }];
  await b.send([], { document: first, sessionId: 'one-page' });
  await b.send([], { document: second, sessionId: 'one-page' });
  let data = await b.extension({ type: 'cacheHistory' });
  assert.equal(data.rows.length, 1);
  assert.equal(data.rows[0].paragraphs, 2);
  assert.equal(data.rows[0].characters, 33);
  assert.equal(data.rows[0].milliseconds, 400);
  assert.equal(data.rows[0].outputTokens, 20);
  assert.equal(data.rows[0].tokensPerSecond, 50);
  assert.equal(data.rows[0].requests, 2);
  assert.equal(data.totals.pages, 1);
  assert.equal(data.totals.outputTokens, 20);
  assert.equal(data.totals.tokensPerSecond, 50);
  assert.ok(!JSON.stringify(data).includes('never-expose-me'));
  assert.ok(!JSON.stringify(data).includes('First paragraph.'));
  assert.ok((await b.content({ type: 'cacheHistory' })).error);
  await b.send([], { document: first, sessionId: 'cache-hit' });
  assert.equal((await b.control({ type: 'cacheHistory' })).rows.length, 1);
  assert.equal(b.calls.length, 2);
  b.tick(59801);
  data = await b.control({ type: 'cacheHistory' });
  assert.equal(data.rows[0].paragraphs, 1);
  assert.equal(data.rows[0].characters, 17);
  assert.equal(data.totals.paragraphs, 1);
  assert.equal(data.totals.characters, 17);
  b.tick(200);
  data = await b.control({ type: 'cacheHistory' });
  assert.equal(data.rows.length, 0);
  assert.equal(data.totals.pages, 0);
  assert.equal(data.totals.tokensPerSecond, null);
});

test('history excludes private, selection, disabled and failed translations and clears with the cache', async () => {
  const b = background(() => completion('訳文'));
  await b.send(['Selection']);
  await b.send([], { document: [{ text: 'Private paragraph.' }] }, 1, { tab: { id: 1, incognito: true } });
  assert.equal((await b.control({ type: 'cacheHistory' })).rows.length, 0);
  await b.send([], { document: [{ text: 'Public paragraph.' }] });
  let data = await b.control({ type: 'cacheHistory' });
  assert.equal(data.rows.length, 1);
  assert.equal(data.rows[0].tokensPerSecond, null);
  assert.equal(data.rows[0].outputTokens, null);
  b.configure({ cacheMinutes: 0 });
  await b.send([], { document: [{ text: 'Uncached paragraph.' }] });
  assert.equal((await b.control({ type: 'cacheHistory' })).rows.length, 0);
  const failed = background(() => completion('broken links'));
  await failed.send([], { document: batchDocuments[0] });
  assert.equal((await failed.control({ type: 'cacheHistory' })).rows.length, 0);
  await b.control({ type: 'clearCache' });
  assert.equal((await b.control({ type: 'cacheHistory' })).bytes, 0);
});

function sseResponse(text, onRead = () => {}) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (offset >= bytes.length) { controller.close(); return; }
    onRead(); controller.enqueue(bytes.slice(offset, offset += 7));
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
}
const sse = value => `data: ${JSON.stringify(value)}\r\n\r\n`;

test('streaming handles split UTF-8 and SSE lines, obtains trailing usage, and verifies complete inline structure', async () => {
  const document = [{ text: 'Read ' }, { tag: 'a', id: 'k0', children: [{ text: 'docs' }] }];
  const b = background(() => sseResponse(': ping\r\n\r\n' +
    sse({ choices: [{ index: 0, delta: { content: '資料を<a id="' } }] }) +
    sse({ choices: [{ index: 0, delta: { content: 'k0">読む</a>' }, finish_reason: 'stop' }] }) +
    sse({ choices: [], usage: { completion_tokens: 42 } }) + 'data: [DONE]\r\n\r\n', () => b.tick(20)), { streamTranslation: true });
  const result = await b.send([], { document, requestId: 'stream' });
  assert.equal(result.document[0].text, '資料を');
  assert.equal(result.document[1].children[0].text, '読む');
  assert.equal(b.calls[0].body.stream, true);
  assert.equal(b.calls[0].body.stream_options.include_usage, true);
  assert.ok(b.progress.some(p => p.phase === 'receiving'));
  const h = (await b.extension({ type: 'cacheHistory' })).rows[0];
  assert.equal(h.outputTokens, 42); assert.ok(h.firstTokenMilliseconds >= 0);
});

test('server generation speed is distinct from whole API speed and broken streams never enter the cache', async () => {
  const b = background(() => { b.tick(2000); return { ...completion('訳文'), usage: { completion_tokens: 120 }, timings: { predicted_n: 120, predicted_ms: 1000 } }; });
  await b.send([], { document: [{ text: 'A sentence.' }] });
  const row = (await b.extension({ type: 'cacheHistory' })).rows[0];
  assert.equal(row.tokensPerSecond, 60); assert.equal(row.generationTokensPerSecond, 120); assert.equal(row.generationSpeedSource, 'server');
  for (const stream of [sse({ choices: [{ delta: { content: 'unfinished' } }] }), 'data: invalid\n\ndata: [DONE]\n\n']) {
    const bad = background(() => sseResponse(stream), { streamTranslation: true });
    const result = await bad.send([], { document: [{ text: 'Original sentence.' }] });
    assert.ok(result.error); assert.equal((await bad.extension({ type: 'cacheHistory' })).rows.length, 0);
  }
});

test('selection streams preview as text and Stop aborts a live stream without caching it', async () => {
  let streamingController;
  const b = background(({ options }) => new Response(new ReadableStream({ start(controller) {
    streamingController = controller;
    controller.enqueue(new TextEncoder().encode(sse({ choices: [{ delta: { content: 'Partial <img src=x>' } }] })));
    options.signal.addEventListener('abort', () => controller.error(new DOMException('cancelled', 'AbortError')), { once: true });
  } }), { headers: { 'Content-Type': 'text/event-stream' } }), { streamTranslation: true });
  const pending = b.send(['Original selection.'], { requestId: 'preview' });
  for (let i = 0; i < 20 && !b.progress.some(p => p.preview); i++) await new Promise(setImmediate);
  assert.ok(streamingController);
  assert.equal(b.progress.find(p => p.preview).preview, 'Partial <img src=x>');
  await b.content({ type: 'cancel' });
  assert.match((await pending).error, /キャンセル/);
  assert.equal((await b.extension({ type: 'cacheHistory' })).rows.length, 0);
});

test('remote tokenizer measures one fitting semantic batch instead of every growing prefix', async () => {
  const b = background(({ url, body }) => url.endsWith('/tokenize') ? { count: 100 } : completion(body.messages[0].content), { tokenizer: 'llama', maxBatchItems: 64 });
  const documents = Array.from({ length: 64 }, (_, i) => [{ text: `Short paragraph ${i}.` }]);
  const result = await b.send([], { documents });
  assert.equal(result.documents.length, 64);
  assert.equal(b.calls.filter(call => call.url.endsWith('/tokenize')).length, 1);
  assert.equal(b.calls.filter(call => !call.url.endsWith('/tokenize')).length, 1);
});

test('batched stream content cannot provide generation speed without server timings', async () => {
  const b = background(() => sseResponse(sse({ choices: [{ delta: { content: 'First fragment. '.repeat(8) } }] }) +
    sse({ choices: [{ delta: { content: 'Last fragment. '.repeat(8) }, finish_reason: 'stop' }] }) +
    sse({ choices: [], usage: { completion_tokens: 120 } }) + 'data: [DONE]\n\n', () => b.tick(100)), { streamTranslation: true });
  await b.send([], { document: [{ text: 'Original paragraph.' }] });
  const row = (await b.extension({ type: 'cacheHistory' })).rows[0];
  assert.equal(row.generationSpeedSource, null);
  assert.equal(row.generationTokensPerSecond, null);
  assert.ok(row.tokensPerSecond > 0);
  assert.ok(row.firstTokenMilliseconds > 0);
});

test('identical in-flight completions share one call and stopping one tab keeps the other request alive', async () => {
  let release;
  const b = background(() => new Promise(resolve => release = () => resolve(completion('Shared translation.'))), { cacheMinutes: 0 });
  const first = b.send(['Same paragraph.'], { requestId: 'share-1' }, 1);
  for (let i = 0; i < 20 && !release; i++) await new Promise(setImmediate);
  const second = b.send(['Same paragraph.'], { requestId: 'share-2' }, 2);
  for (let i = 0; i < 5; i++) await new Promise(setImmediate);
  assert.equal(b.calls.length, 1);
  await b.content({ type: 'cancel' });
  assert.match((await first).error, /キャンセル/);
  assert.equal(b.calls[0].options.signal.aborted, false);
  release(); assert.equal((await second).parts[0], 'Shared translation.');
  const third = b.send(['Same paragraph.'], {}, 3);
  for (let i = 0; i < 20 && b.calls.length < 2; i++) await new Promise(setImmediate);
  release(); await third;
  assert.equal(b.calls.length, 2);
});

test('sharing respects origin, private windows, and its setting; cache records shared usage', async () => {
  for (const scenario of ['origin', 'private', 'disabled']) {
    const releases = [];
    const b = background(() => new Promise(resolve => releases.push(() => resolve(completion('Translated.')))), { shareInFlight: scenario !== 'disabled', concurrency: 2, cacheMinutes: 0 });
    const first = b.send(['Equal text.'], {}, 1);
    const second = b.send(['Equal text.'], {}, 2, scenario === 'origin' ? { url: 'https://other.example/page' } : scenario === 'private' ? { tab: { id: 2, incognito: true } } : {});
    for (let i = 0; i < 20 && releases.length < 2; i++) await new Promise(setImmediate);
    assert.equal(b.calls.length, 2, scenario);
    releases.forEach(release => release()); await Promise.all([first, second]);
  }
  let release;
  const b = background(() => new Promise(resolve => release = () => resolve(completion('訳文'))));
  const document = [{ text: 'Same paragraph.' }];
  const first = b.send([], { document }, 1);
  const second = b.send([], { document }, 2, { url: 'https://example.org/another-page' });
  for (let i = 0; i < 10; i++) await new Promise(setImmediate);
  assert.equal(b.calls.length, 1); release(); await Promise.all([first, second]);
  const rows = (await b.extension({ type: 'cacheHistory' })).rows;
  assert.equal(rows.length, 2); assert.equal(rows.reduce((sum, row) => sum + row.sharedRequests, 0), 1);
});

test('cancelling every shared subscriber aborts the underlying model call', async () => {
  const b = background(({ options }) => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true })));
  const first = b.send(['Equal text.'], {}, 1), second = b.send(['Equal text.'], {}, 1);
  for (let i = 0; i < 10; i++) await new Promise(setImmediate);
  assert.equal(b.calls.length, 1);
  await b.content({ type: 'cancel' });
  assert.ok((await first).error); assert.ok((await second).error);
  assert.equal(b.calls[0].options.signal.aborted, true);
});

test('glossary filtering uses original HTML text rather than marker attributes', async () => {
  const dictionary = ['A&B', 'Absent', 'span'].map(source => ({ domain: '', sourceLang: 'en', targetLang: 'ja', source, target: '訳語' }));
  const b = background(({ body }) => completion(body.messages[0].content), { dictionary });
  await b.send([], { document: [{ tag: 'span', id: 'k0', children: [{ text: 'A&B' }] }] });
  assert.deepEqual(b.calls[0].body.glossary.map(term => term.source), ['A&B']);
});

test('late stream subscriber receives the existing prefix and survives the first subscriber stopping', async () => {
  let controller;
  const b = background(({ options }) => new Response(new ReadableStream({ start(value) {
    controller = value;
    controller.enqueue(new TextEncoder().encode(sse({ choices: [{ delta: { content: 'First ' } }] })));
    options.signal.addEventListener('abort', () => controller.error(new DOMException('cancelled', 'AbortError')), { once: true });
  } }), { headers: { 'Content-Type': 'text/event-stream' } }), { streamTranslation: true });
  const first = b.send(['Same selection.'], { requestId: 'first-stream' }, 1);
  for (let i = 0; i < 20 && !b.progress.some(p => p.preview); i++) await new Promise(setImmediate);
  const second = b.send(['Same selection.'], { requestId: 'second-stream' }, 2);
  for (let i = 0; i < 20 && !b.progress.some(p => p.requestId === 'second-stream' && p.preview); i++) await new Promise(setImmediate);
  assert.equal(b.progress.find(p => p.requestId === 'second-stream' && p.preview).preview, 'First ');
  assert.equal(b.calls.length, 1);
  await b.content({ type: 'cancel' }); assert.ok((await first).error);
  assert.equal(b.calls[0].options.signal.aborted, false);
  b.tick(200);
  controller.enqueue(new TextEncoder().encode(sse({ choices: [{ delta: { content: 'last.' }, finish_reason: 'stop' }] }) + sse({ choices: [], usage: { completion_tokens: 10 } }) + 'data: [DONE]\n\n'));
  controller.close();
  assert.equal((await second).parts[0], 'First last.');
});

test("persistent diagnostics retain failed inputs, responses and settings independently of cache and redact credentials", async () => {
  const storage = {};
  const b = background(() => new Response('server detail credential-123', { status: 500 }), { apiKey: 'credential-123', cacheMinutes: 0 }, storage);
  assert.ok((await b.send(['Failed original credential-123'])).error);
  const data = await b.extension({ type: 'errorHistory' });
  assert.equal(data.entries.length, 1);
  const entry = data.entries[0];
  assert.equal(entry.stage, 'request');
  assert.equal(entry.original, 'Failed original [REDACTED]');
  assert.equal(entry.response, 'server detail [REDACTED]');
  assert.equal(entry.httpStatus, 500);
  assert.equal(entry.origin, 'https://example.org');
  assert.equal(entry.settings.model, 'plamo-translate');
  assert.equal(entry.maxTokens, 8096);
  assert.ok(!JSON.stringify(data).includes('credential-123'));
  assert.ok(!JSON.stringify(data).includes('private?q=secret'));
  assert.ok((await b.content({ type: 'errorHistory' })).error);
  assert.ok((await b.content({ type: 'clearErrors' })).error);
  await b.control({ type: 'clearCache' }); b.configure({ cacheMinutes: 1 }); b.tick(86400000);
  assert.equal((await b.control({ type: 'errorHistory' })).entries.length, 1);
  const restarted = background(() => completion('訳文'), {}, storage);
  assert.equal((await restarted.control({ type: 'errorHistory' })).entries.length, 1);
  await restarted.extension({ type: 'clearErrors' });
  assert.equal((await restarted.control({ type: 'errorHistory' })).entries.length, 0);
});

test("diagnostics record recovered structure and HTTP failures, skip private requests and remain bounded under concurrent writes", async () => {
  const storage = {};
  let requests = 0;
  const b = background(() => ++requests === 1 ? completion('invalid markup') : completion('<p id="b0">First <a id="k0">link</a></p><p id="b1">Second <a id="k0">link</a></p>'), {}, storage);
  await b.send([], { documents: batchDocuments });
  assert.ok((await b.control({ type: 'errorHistory' })).entries.some(e => e.stage === 'batch-structure' && e.response === 'invalid markup'));
  const privateBackground = background(() => ({ httpStatus: 500 }), {}, storage);
  const count = storage.translationErrors.length;
  await privateBackground.send(['private original'], {}, 1, { tab: { id: 1, incognito: true } });
  assert.equal(storage.translationErrors.length, count);
  requests = 0;
  const retry = background(() => ++requests === 1 ? { httpStatus: 503, retryAfter: '0' } : completion('成功'), { retryTransient: true }, storage);
  assert.equal((await retry.send(['retry original'])).parts[0], '成功');
  assert.equal(storage.translationErrors[0].httpStatus, 503);
  const failing = background(({ url }) => url.endsWith('/tokenize') ? { tokens: [1] } : { httpStatus: 500 }, { shareInFlight: false, tokenizer: 'llama' }, storage);
  await Promise.all(Array.from({ length: 105 }, (_, i) => failing.send([`original ${i} ` + 'x'.repeat(40000)], {}, i + 1)));
  assert.equal(storage.translationErrors.length, 100);
  assert.ok(new TextEncoder().encode(JSON.stringify(storage.translationErrors)).length <= 4 * 1024 * 1024);
  assert.ok(storage.translationErrors[0].original.endsWith('[省略: 32000文字を超過]'));
});

test("diagnostics preserve malformed JSON and stream output and evict by bytes without losing the newest error", async () => {
  const storage = { translationErrors: Array.from({ length: 90 }, () => ({ original: '日'.repeat(20000) })) };
  const b = background(() => new Response('{broken JSON', { headers: { 'Content-Type': 'application/json' } }), {}, storage);
  assert.ok((await b.send(['Original'])).error);
  assert.equal(storage.translationErrors[0].response, '{broken JSON');
  assert.ok(storage.translationErrors.length < 90);
  assert.ok(new TextEncoder().encode(JSON.stringify(storage.translationErrors)).length <= 4 * 1024 * 1024);
  const streaming = background(() => new Response('data: {"choices":[{"delta":{"content":"途中の訳"}}]}\n\ndata: {broken\n\n', { headers: { 'Content-Type': 'text/event-stream' } }), { streamTranslation: true }, storage);
  assert.ok((await streaming.send(['Stream original'])).error);
  const response = JSON.parse(storage.translationErrors[0].response);
  assert.equal(response.partialOutput, '途中の訳');
  assert.equal(response.invalidEvent, '{broken');
});


test('history totals weight speeds by measured time and keep missing metrics unknown', async () => {
  let index = 0;
  const responses = [
    { tokens: 100, milliseconds: 1000, generation: 500 },
    { tokens: 150, milliseconds: 3000, generation: 2500 },
    { milliseconds: 1000 }
  ];
  const b = background(() => {
    const sample = responses[index++]; b.tick(sample.milliseconds);
    return { ...completion('訳文'), ...(sample.tokens ? { usage: { completion_tokens: sample.tokens },
      timings: { predicted_n: sample.tokens, predicted_ms: sample.generation } } : {}) };
  });
  await b.send([], { document: [{ text: 'First paragraph.' }] });
  await b.send([], { document: [{ text: 'Second paragraph.' }] });
  let totals = (await b.control({ type: 'cacheHistory' })).totals;
  assert.equal(totals.pages, 2);
  assert.equal(totals.requests, 2);
  assert.equal(totals.outputTokens, 250);
  assert.equal(totals.milliseconds, 4000);
  assert.equal(totals.tokensPerSecond, 62.5);
  assert.equal(totals.generationTokensPerSecond, 250 / 3);
  await b.send([], { document: [{ text: 'Unknown metrics.' }] });
  totals = (await b.control({ type: 'cacheHistory' })).totals;
  assert.equal(totals.outputTokens, null);
  assert.equal(totals.tokensPerSecond, null);
  assert.equal(totals.generationTokensPerSecond, null);
  await b.control({ type: 'clearCache' });
  totals = (await b.control({ type: 'cacheHistory' })).totals;
  assert.equal(totals.pages, 0);
  assert.equal(totals.outputTokens, 0);
  assert.equal(totals.generationTokensPerSecond, null);
});


test('page API throughput divides tokens by elapsed time without counting concurrent responses repeatedly', async () => {
  const releases = [];
  const b = background(() => new Promise(resolve => releases.push(resolve)), { concurrency: 6 });
  const pending = Array.from({ length: 6 }, (_, i) => b.send([], {
    document: [{ text: `Concurrent paragraph ${i}.` }], sessionId: 'parallel-page'
  }));
  for (let i = 0; i < 20 && releases.length < 6; i++) await new Promise(setImmediate);
  assert.equal(releases.length, 6);
  b.tick(43600);
  releases.forEach((resolve, i) => resolve({ ...completion('訳文'), usage: { completion_tokens: i === 0 ? 806 : 807 } }));
  await Promise.all(pending);
  const data = await b.control({ type: 'cacheHistory' });
  assert.equal(data.rows.length, 1);
  const row = data.rows[0];
  assert.equal(row.milliseconds, 43600);
  assert.equal(row.outputTokens, 4841);
  assert.equal(row.tokensPerSecond.toFixed(1), '111.0');
  assert.equal(data.totals.tokensPerSecond, row.tokensPerSecond);
});
