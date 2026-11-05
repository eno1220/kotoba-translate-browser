const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { JSDOM } = require("jsdom");
const source = readFileSync(require.resolve("../extension/content.js"), "utf8");
function setup(html, translator = parts => parts.map(t => `訳:${t}`)) {
  const dom = new JSDOM(html, { url: "https://example.com/article", runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  w.Range.prototype.getClientRects = () => [{ width: 100, height: 20, left: 0, top: 0, right: 100, bottom: 20 }];
  const attachShadow = w.Element.prototype.attachShadow;
  let shadow;
  w.Element.prototype.attachShadow = function(options) { shadow = attachShadow.call(this, options); return shadow; };
  const nativeStyle = w.getComputedStyle.bind(w);
  w.getComputedStyle = el => {
    const css = nativeStyle(el);
    return { display: css.display || "inline", visibility: css.visibility || "visible", opacity: css.opacity || "1" };
  };
  const calls = [];
  let listener;
  w.browser = { runtime: {
    onMessage: { addListener: fn => listener = fn },
    sendMessage: async msg => {
      if (msg.type === "contentPreferences") return { concurrency: 1 };
      if (msg.type === "translate") { calls.push(msg); return { parts: await translator(msg.parts) }; }
      return {};
    }
  } };
  w.eval(source);
  const message = msg => listener(msg);
  async function settle() {
    for (let i = 0; i < 100; i++) {
      const status = await message({ type: "status" });
      if (!status.running) return status;
      await new Promise(r => setImmediate(r));
    }
    throw new Error("translation did not finish");
  }
  return { dom, w, calls, message, settle, get shadow() { return shadow; } };
}

test("manual DOM translation preserves links and code, skips hidden/editable/target-language text", async () => {
  const s = setup(`<html lang="en"><body><p id="p">Read <a href="/docs">the docs</a> carefully.</p>
    <pre>do not translate code</pre><p><code>let value = 1</code></p>
    <p hidden>secret hidden text</p><p style="display:none">css hidden</p>
    <p translate="no">brand words</p><p class="notranslate">other brand</p>
    <p contenteditable="true">user draft</p><input value="user value"><p lang="ja">日本語です</p>
    <p>https://example.com/path</p><p>123.45</p></body></html>`);
  assert.equal(s.calls.length, 0);
  const a = s.w.document.querySelector("a"); let clicks = 0;
  a.addEventListener("click", event => { event.preventDefault(); clicks++; });
  await s.message({ type: "start", source: "en", target: "ja" }); await s.settle();
  assert.equal(s.calls.length, 1);
  assert.deepEqual(Array.from(s.calls[0].parts), ["Read ", "the docs", " carefully."]);
  assert.equal(s.w.document.querySelector("a"), a);
  assert.equal(a.getAttribute("href"), "/docs"); a.click(); assert.equal(clicks, 1);
  assert.equal(s.w.document.querySelector("pre").textContent, "do not translate code");
  assert.equal(s.w.document.querySelector('[lang="ja"]').textContent, "日本語です");
  await s.message({ type: "restore" });
  assert.equal(s.w.document.querySelector("#p").textContent, "Read the docs carefully.");
  s.dom.window.close();
});

test("re-execution translates new content only, restore preserves site's own changes", async () => {
  const s = setup('<p id="first">First sentence.</p>');
  await s.message({ type: "start", source: "en", target: "ja" }); await s.settle();
  const second = s.w.document.createElement("p"); second.textContent = "New sentence."; s.w.document.body.append(second);
  assert.equal(s.calls.length, 1);
  await s.message({ type: "start", source: "en", target: "ja" }); await s.settle();
  assert.equal(s.calls.length, 2);
  s.w.document.querySelector("#first").textContent = "Site updated this.";
  await s.message({ type: "restore" });
  assert.equal(s.w.document.querySelector("#first").textContent, "Site updated this.");
  assert.equal(second.textContent, "New sentence.");
  s.dom.window.close();
});

test("inline code stays attached and unchanged while its surrounding sentence is grouped", async () => {
  const s = setup('<p>Call <code><span>request()</span></code> to load the document.</p>');
  const code = s.w.document.querySelector("code");
  await s.message({ type: "start", source: "en", target: "ja" }); await s.settle();
  assert.deepEqual(Array.from(s.calls[0].parts), ["Call ", "request()", " to load the document."]);
  assert.deepEqual(Array.from(s.calls[0].protectedParts), [false, true, false]);
  assert.equal(s.w.document.querySelector("code"), code);
  assert.equal(code.textContent, "request()");
  await s.message({ type: "restore" });
  assert.equal(s.w.document.querySelector("p").textContent, "Call request() to load the document.");
  s.dom.window.close();
});

test("late responses cannot overwrite a stopped page or site mutation", async () => {
  let release;
  const s = setup('<p id="text">Original sentence.</p>', parts => new Promise(resolve => { release = () => resolve(parts.map(x => `訳:${x}`)); }));
  await s.message({ type: "start", source: "en", target: "ja" });
  await new Promise(r => setImmediate(r));
  await s.message({ type: "stop" }); release();
  await new Promise(r => setImmediate(r));
  assert.equal(s.w.document.querySelector("#text").textContent, "Original sentence.");
  s.dom.window.close();
});

test("chunk progress updates the same panel and dismissing it survives further progress", async () => {
  let release;
  const s = setup('<p>A long sentence with several chunks.</p>', parts => new Promise(resolve => { release = () => resolve(parts.map(x => `訳:${x}`)); }));
  await s.message({ type: "start", source: "en", target: "ja" });
  await new Promise(r => setImmediate(r));
  const panel = s.shadow.querySelector(".panel");
  const requestId = s.calls[0].requestId;
  await s.message({ type: "translationProgress", requestId, completed: 10, total: 36 });
  const state = await s.message({ type: "status" });
  assert.ok(state.percent > 0 && state.percent < 100);
  assert.equal(s.shadow.querySelector(".panel"), panel);
  panel.querySelector('[aria-label="閉じる"]').click();
  await s.message({ type: "translationProgress", requestId, completed: 20, total: 36 });
  release(); const finished = await s.settle();
  assert.equal(finished.percent, 100);
  assert.equal(s.shadow.querySelector(".panel"), null);
  s.dom.window.close();
});

test("original hover waits, stays stable across inline nodes, and supports pinning and disabling", async () => {
  const s = setup('<p>Read <a href="/docs">the docs</a> carefully.</p>');
  await s.message({ type: "start", source: "en", target: "ja" }); await s.settle();
  let hovered = s.w.document.querySelector("p").firstChild;
  s.w.document.caretPositionFromPoint = () => ({ offsetNode: hovered });
  const move = (x = 10) => s.w.document.dispatchEvent(new s.w.MouseEvent("pointermove", { clientX: x, clientY: 10, bubbles: true }));
  move(); assert.equal(s.shadow.querySelector(".tooltip"), null);
  await new Promise(r => setTimeout(r, 310));
  const tooltip = s.shadow.querySelector(".tooltip");
  assert.ok(tooltip);
  assert.equal(tooltip.querySelector(".original").textContent, "Read the docs carefully.");
  hovered = s.w.document.querySelector("a").firstChild; move();
  assert.equal(s.shadow.querySelector(".tooltip"), tooltip);
  tooltip.querySelector('[aria-pressed]').click();
  move(200); await new Promise(r => setTimeout(r, 250));
  assert.equal(s.shadow.querySelector(".tooltip"), tooltip);
  await s.message({ type: "hover", hoverEnabled: false });
  assert.equal(s.shadow.querySelector(".tooltip"), null);
  move(); await new Promise(r => setTimeout(r, 310));
  assert.equal(s.shadow.querySelector(".tooltip"), null);
  s.dom.window.close();
});
