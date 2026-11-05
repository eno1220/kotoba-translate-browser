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
  w.Range.prototype.getBoundingClientRect = function() {
    const node = this.commonAncestorContainer;
    return (node.nodeType === 1 ? node : node.parentElement)?.getBoundingClientRect();
  };
  const attachShadow = w.Element.prototype.attachShadow;
  let shadow;
  w.Element.prototype.attachShadow = function(options) { shadow = attachShadow.call(this, options); return shadow; };
  const nativeStyle = w.getComputedStyle.bind(w);
  w.getComputedStyle = el => {
    const css = nativeStyle(el);
    return { display: css.display || "inline", visibility: css.visibility || "visible", opacity: css.opacity || "1" };
  };
  const calls = [];
  const copied = [];
  let listener;
  w.browser = { runtime: {
    onMessage: { addListener: fn => listener = fn },
    sendMessage: async msg => {
      if (msg.type === "contentPreferences") return { concurrency: 1, ...preferences };
      if (msg.type === "translate") {
        calls.push(msg);
        if (msg.parts) return { parts: msg.parts.map(text => `訳:${text}`) };
        if (msg.documents) return { documents: await Promise.all(msg.documents.map(async document => ({ document: await translator(document) }))) };
        return { document: await translator(msg.document) };
      }
      if (msg.type === "copyText") copied.push(msg.text);
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
      await new Promise(r => setTimeout(r, 1));
    }
    throw new Error("translation did not finish");
  }
  return { dom, w, calls, copied, message, settle, get shadow() { return shadow; } };
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

test("cached revisit restores only identical paragraphs and preserves live links, hover originals and manual choices", async () => {
  const s = setup('<p id="same">Read <a href="/docs">the docs</a> carefully.</p><p id="changed">Updated sentence.</p>');
  const original = [{ text: "Read " }, { id: "k0", tag: "a", children: [{ text: "the docs" }] }, { text: " carefully." }];
  const link = s.w.document.querySelector("a"); let clicks = 0;
  link.addEventListener("click", event => { event.preventDefault(); clicks++; });
  const cached = { type: "restoreCache", url: "https://example.com/article", source: "en", target: "ja", entries: [
    { input: JSON.stringify(original), document: translateTree(original) },
    { input: JSON.stringify([{ text: "Old sentence." }]), document: [{ text: "古い訳文" }] }
  ] };
  await s.message(cached);
  assert.ok(s.w.document.querySelector("#same").textContent.startsWith("訳:"));
  assert.equal(s.w.document.querySelector("#changed").textContent, "Updated sentence.");
  assert.equal(s.calls.length, 0);
  assert.equal(s.w.document.querySelector("a"), link); link.click(); assert.equal(clicks, 1);
  assert.equal((await s.message({ type: "status" })).target, "ja");
  await s.message({ type: "restore" });
  assert.equal(s.w.document.querySelector("#same").textContent, "Read the docs carefully.");
  await s.message(cached);
  assert.equal(s.w.document.querySelector("#same").textContent, "Read the docs carefully.");
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

test("main-content scope skips navigation, avoids nested scopes and can be disabled", async () => {
  const html = '<nav><p>Navigation words.</p></nav><main><article><p>Main prose.</p></article></main>';
  const s = setup(html, translateTree, { mainContentOnly: true });
  await s.message({ type: "start", source: "en", target: "ja" }); await s.settle();
  assert.equal(s.calls.length, 1); assert.equal(textOf(s.calls[0].document), "Main prose.");
  assert.equal(s.w.document.querySelector("nav p").textContent, "Navigation words.");
  s.dom.window.close();
  const off = setup(html, translateTree, { mainContentOnly: false });
  await off.message({ type: "start", source: "en", target: "ja" }); await off.settle();
  assert.equal(off.calls.length, 2); off.dom.window.close();
  const fallback = setup('<p>Plain page without landmarks.</p>', translateTree, { mainContentOnly: true });
  await fallback.message({ type: "start", source: "en", target: "ja" }); await fallback.settle();
  assert.equal(fallback.calls.length, 1); fallback.dom.window.close();
});

test("visible paragraph priority changes request order without changing restoration", async () => {
  for (const prioritizeVisible of [true, false]) {
    const s = setup('<p>Far away.</p><p>On screen.</p><p>Nearby.</p>', translateTree, { prioritizeVisible });
    [...s.w.document.querySelectorAll("p")].forEach((el, index) => {
      const top = [5000, 10, 1000][index];
      el.getBoundingClientRect = () => ({ top, bottom: top + 20, left: 0, right: 100, width: 100, height: 20 });
    });
    await s.message({ type: "start", source: "en", target: "ja" }); await s.settle();
    assert.deepEqual(s.calls.map(call => textOf(call.document)), prioritizeVisible ? ["On screen.", "Nearby.", "Far away."] : ["Far away.", "On screen.", "Nearby."]);
    await s.message({ type: "restore" }); assert.equal(s.w.document.querySelector("p").textContent, "Far away.");
    s.dom.window.close();
  }
});

test("large-page parsing yields to stop before making API requests", async () => {
  const s = setup('<p>A paragraph to parse.</p>'.repeat(250));
  const nativeTimeout = s.w.setTimeout.bind(s.w);
  let interrupted = false;
  s.w.setTimeout = (fn, ms) => nativeTimeout(() => {
    if (ms === 0 && !interrupted) { interrupted = true; s.message({ type: "stop" }); }
    fn();
  }, ms);
  const start = await s.message({ type: "start", source: "en", target: "ja" });
  assert.equal(start.preparing, true);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(interrupted, true); assert.equal(s.calls.length, 0);
  assert.equal((await s.message({ type: "status" })).running, false);
  s.dom.window.close();
});

test("progress and announcements have independent switches", async () => {
  for (const announceProgress of [true, false]) {
    const s = setup('<p>Translate this sentence.</p>', translateTree, { pageProgress: false, announceProgress });
    await s.message({ type: "start", source: "en", target: "ja" }); await s.settle();
    assert.equal(s.shadow?.querySelector(".panel") || null, null);
    assert.equal(s.shadow?.querySelector('[role="status"]')?.textContent || "", announceProgress ? "ページ翻訳が完了しました" : "");
    s.dom.window.close();
  }
});

test("keyboard original dialog supports F2, copy, Escape focus return and disabling", async () => {
  const s = setup('<p>Read <a href="/docs">the docs</a> carefully.</p>');
  await s.message({ type: "start", source: "en", target: "ja" }); await s.settle();
  const link = s.w.document.querySelector("a"); link.focus();
  const tooltip = s.shadow.querySelector(".tooltip");
  assert.equal(tooltip.querySelector(".original").lang, "en");
  s.w.document.dispatchEvent(new s.w.KeyboardEvent("keydown", { key: "F2", bubbles: true }));
  assert.equal(s.shadow.activeElement, tooltip);
  tooltip.querySelector(".copy").click(); await new Promise(r => setImmediate(r));
  assert.deepEqual(s.copied, ["Read the docs carefully."]);
  s.w.document.dispatchEvent(new s.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(s.shadow.querySelector(".tooltip"), null); assert.equal(s.w.document.activeElement, link);
  await s.message({ type: "preferencesChanged", preferences: { focusOriginal: false, copyButton: false } });
  link.blur(); link.focus(); assert.equal(s.shadow.querySelector(".tooltip"), null);
  s.dom.window.close();
});

test("selection launcher requires an explicit click, avoids editors and can be disabled", async () => {
  const s = setup('<p>Selected prose.</p><div contenteditable="true">Private draft.</div>', translateTree, { selectionButton: true });
  const rect = { top: 20, bottom: 40, left: 10, right: 110, width: 100, height: 20 };
  s.w.Range.prototype.getBoundingClientRect = () => rect;
  async function select(el) {
    const range = s.w.document.createRange(); range.selectNodeContents(el);
    const selected = s.w.getSelection(); selected.removeAllRanges(); selected.addRange(range);
    s.w.document.dispatchEvent(new s.w.Event("selectionchange"));
    await new Promise(resolve => setTimeout(resolve, 240));
  }
  await new Promise(r => setImmediate(r));
  await select(s.w.document.querySelector("[contenteditable]"));
  assert.equal(s.shadow?.querySelector(".launcher") || null, null);
  await select(s.w.document.querySelector("p"));
  assert.equal(s.calls.length, 0);
  const launcher = s.shadow.querySelector(".launcher"); assert.ok(launcher);
  launcher.click(); await new Promise(r => setImmediate(r));
  assert.equal(s.calls.length, 1); assert.equal(s.calls[0].parts[0], "Selected prose.");
  assert.equal(s.shadow.querySelector(".result").textContent, "訳:Selected prose.");
  assert.equal(s.shadow.querySelector(".result").lang, "ja");
  s.shadow.querySelector(".copy").click(); await new Promise(r => setImmediate(r));
  assert.deepEqual(s.copied, ["訳:Selected prose."]);
  s.shadow.querySelector('[aria-label="閉じる"]').click();
  await s.message({ type: "preferencesChanged", preferences: { selectionButton: false } });
  await select(s.w.document.querySelector("p")); assert.equal(s.shadow.querySelector(".launcher"), null);
  s.dom.window.close();
});
