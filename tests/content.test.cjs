const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { JSDOM } = require("jsdom");
const source = readFileSync(require.resolve("../extension/content.js"), "utf8");
const textOf = nodes => nodes.map(node => node.text !== undefined ? node.text : textOf(node.children)).join("");
const translateTree = nodes => nodes.map(node => node.protected ? node : node.text !== undefined ? { text: node.text.trim() ? `訳:${node.text}` : node.text } : { ...node, children: translateTree(node.children) });
function setup(html, translator = translateTree, preferences = {}) {
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
      if (msg.type === "contentPreferences") return { concurrency: 1, ...preferences };
      if (msg.type === "translate") {
        calls.push(msg);
        if (msg.documents) return { documents: await Promise.all(msg.documents.map(async document => ({ document: await translator(document) }))) };
        return { document: await translator(msg.document) };
      }
      return {};
    }
  } };
  // Content runs independently; executeScript globals need not be shared.
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
  assert.equal(s.w.Kotoba, undefined);
  assert.equal(textOf(s.calls[0].document), "Read the docs carefully.");
  assert.equal(s.calls[0].document[1].tag, "a");
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
  assert.equal(textOf(s.calls[0].document), "Call request() to load the document.");
  assert.equal(s.calls[0].document[1].protected, true);
  assert.equal(s.w.document.querySelector("code"), code);
  assert.equal(code.textContent, "request()");
  await s.message({ type: "restore" });
  assert.equal(s.w.document.querySelector("p").textContent, "Call request() to load the document.");
  s.dom.window.close();
});

test("nested links and screen-reader notes remain one complete paragraph with punctuation", async () => {
  const s = setup(`<p><span>As models improve, the July </span><a href="/incident"><u class="decoration"><span>Hugging Face incident</span></u></a><span> and </span><a href="https://alignment.openai.com/misalignment-reports/" target="_blank"><u><span>other model misalignment examples</span></u>⁠<span class="sr-only">(opens in a new window)</span></a><span> show that models can evade containment.</span></p>`);
  const original = s.w.document.querySelector("p").innerHTML;
  await s.message({ type: "start", source: "en", target: "ja" }); await s.settle();
  assert.equal(s.calls.length, 1);
  assert.equal(textOf(s.calls[0].document), "As models improve, the July Hugging Face incident and other model misalignment examples show that models can evade containment.");
  assert.ok(!JSON.stringify(s.calls[0].document).includes("opens in a new window"));
  assert.equal(s.w.document.querySelector(".sr-only").textContent, "(opens in a new window)");
  await s.message({ type: "restore" });
  assert.equal(s.w.document.querySelector("p").innerHTML, original);
  s.dom.window.close();
});

test("CVE lists, commas and parentheses do not split a paragraph into independent translations", async () => {
  const labels = ["CVE-2026-24834", "privilege isolation", "filesystem isolation", "gVisor (file descriptor handling)", "Moby/Docker (syscall filters)", "kernel security", "CVE-2026-74753", "CVE-2026-80521", "CVE-2026-80841"];
  const links = labels.map((text, i) => `<a href="/patch/${i}"><u><span>${text}</span></u>⁠<span class="sr-only">(opens in a new window)</span></a>`);
  const html = `<p><span>We upstream patches for Kata Containers (</span>${links.slice(0, 3).join("<span>, </span>")}<span>), </span>${links[3]}<span>, and </span>${links[4]}<span>. We also improve </span>${links[5]}<span>, including fixes for </span>${links.slice(6).join("<span>, </span>")}<span>. We disclosed additional vulnerabilities.</span></p>`;
  const s = setup(html);
  await s.message({ type: "start", source: "en", target: "ja" }); await s.settle();
  assert.equal(s.calls.length, 1);
  const text = textOf(s.calls[0].document);
  assert.ok(text.includes("Kata Containers (CVE-2026-24834, privilege isolation, filesystem isolation), gVisor"));
  assert.ok(text.endsWith("CVE-2026-74753, CVE-2026-80521, CVE-2026-80841. We disclosed additional vulnerabilities."));
  assert.equal(s.w.document.querySelectorAll("a").length, 9);
  assert.equal(s.w.document.querySelectorAll(".sr-only").length, 9);
  s.dom.window.close();
});

test("translated word order can move links while preserving the live anchors and exact original DOM", async () => {
  const s = setup('<p><span>If you have read my </span><a href="/posts">earlier posts</a><span> about </span><a href="/asm">assembly on Linux x86_64</a><span>, you may know my interest in low-level programming.</span></p>', tree => {
    const links = tree.filter(node => node.tag === "a");
    return [{ text: "以前の" }, { ...links[1], children: [{ text: "Linux x86_64のアセンブリ言語" }] }, { text: "に関する" }, { ...links[0], children: [{ text: "投稿" }] }, { text: "を読んだ方は、私が低レベルプログラミングに関心を持っていることをご存じでしょう。" }];
  });
  const p = s.w.document.querySelector("p"), original = p.innerHTML;
  const [posts, asm] = p.querySelectorAll("a"); let clicks = 0;
  posts.addEventListener("click", event => { event.preventDefault(); clicks++; });
  await s.message({ type: "start", source: "en", target: "ja" }); await s.settle();
  assert.equal(p.textContent, "以前のLinux x86_64のアセンブリ言語に関する投稿を読んだ方は、私が低レベルプログラミングに関心を持っていることをご存じでしょう。");
  assert.equal(p.querySelectorAll("a")[0], asm);
  assert.equal(p.querySelectorAll("a")[1], posts);
  posts.click(); assert.equal(clicks, 1); assert.equal(posts.getAttribute("href"), "/posts");
  await s.message({ type: "restore" });
  assert.equal(p.innerHTML, original); assert.equal(p.querySelectorAll("a")[0], posts);
  s.dom.window.close();
});

test("late responses cannot overwrite a stopped page or site mutation", async () => {
  let release;
  const s = setup('<p id="text">Original sentence.</p>', tree => new Promise(resolve => { release = () => resolve(translateTree(tree)); }));
  await s.message({ type: "start", source: "en", target: "ja" });
  await new Promise(r => setImmediate(r));
  await s.message({ type: "stop" }); release();
  await new Promise(r => setImmediate(r));
  assert.equal(s.w.document.querySelector("#text").textContent, "Original sentence.");
  s.dom.window.close();
});

test("chunk progress updates the same panel and dismissing it survives further progress", async () => {
  let release;
  const s = setup('<p>A long sentence with several chunks.</p>', tree => new Promise(resolve => { release = () => resolve(translateTree(tree)); }));
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


test("batch mode applies each result to its paragraph, preserves links and restores originals", async () => {
  const html = '<p>First <a href="/one">link</a>.</p><p>Second <a href="/two">link</a>.</p>';
  const s = setup(html, translateTree, { batchTranslation: true });
  const links = [...s.w.document.querySelectorAll("a")];
  await s.message({ type: "start", source: "en", target: "ja" });
  const state = await s.settle();
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].documents.length, 2);
  assert.equal(state.done, 2);
  assert.equal(state.percent, 100);
  assert.match(s.w.document.querySelectorAll("p")[1].textContent, /訳:Second/);
  assert.deepEqual([...s.w.document.querySelectorAll("a")], links);
  await s.message({ type: "restore" });
  assert.equal(s.w.document.body.innerHTML, html);
  s.dom.window.close();

  const off = setup(html, translateTree, { batchTranslation: false });
  await off.message({ type: "start", source: "en", target: "ja" });
  await off.settle();
  assert.equal(off.calls.length, 2);
  assert.ok(off.calls.every(call => call.document && !call.documents));
  off.dom.window.close();
});


test("late batch responses respect stop and changes to individual paragraphs", async () => {
  for (const stop of [true, false]) {
    const releases = [];
    const s = setup('<p>First sentence.</p><p>Second sentence.</p>', tree => new Promise(resolve => releases.push(() => resolve(translateTree(tree)))), { batchTranslation: true });
    await s.message({ type: "start", source: "en", target: "ja" });
    await new Promise(r => setImmediate(r));
    if (stop) await s.message({ type: "stop" });
    else s.w.document.querySelector("p").textContent = "Updated by site.";
    releases.forEach(release => release());
    await new Promise(r => setImmediate(r));
    const paragraphs = s.w.document.querySelectorAll("p");
    assert.equal(paragraphs[0].textContent, stop ? "First sentence." : "Updated by site.");
    assert.equal(paragraphs[1].textContent, stop ? "Second sentence." : "訳:Second sentence.");
    s.dom.window.close();
  }
});
