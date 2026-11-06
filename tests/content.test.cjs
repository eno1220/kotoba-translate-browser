const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { JSDOM } = require("jsdom");
const source = readFileSync(require.resolve("../extension/content.js"), "utf8");
const textOf = nodes => nodes.map(node => node.text !== undefined ? node.text : textOf(node.children)).join("");
const translateTree = nodes => nodes.map(node => node.protected ? node : node.text !== undefined ? { text: node.text.trim() ? `訳:${node.text}` : node.text } : { ...node, children: translateTree(node.children) });
function setup(html, translator = translateTree, preferences = {}) {
  const dom = new JSDOM(html, { url: "https://example.com/article", runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window; w.TextEncoder = TextEncoder;
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
    return { display: css.display || "inline", visibility: css.visibility || "visible", opacity: css.opacity || "1", position: css.position, width: css.width, height: css.height, overflow: css.overflow, clipPath: css.clipPath, contentVisibility: css.contentVisibility };
  };
  const calls = [];
  const copied = [];
  let listener;
  w.browser = { runtime: {
    onMessage: { addListener: fn => listener = fn },
    sendMessage: async msg => {
      if (msg.type === "contentPreferences") return { concurrency: 1, prioritizeContent: false, semanticBatching: false, adaptiveScheduling: false, ...preferences };
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


test("batch mode starts with one paragraph, then preserves links in grouped results and restores originals", async t => {
  const html = '<p>First <a href="/one">link</a>.</p><p>Second <a href="/two">link</a>.</p><p>Third paragraph.</p>';
  const s = setup(html, translateTree, { batchTranslation: true }); t.after(() => s.dom.window.close());
  const links = [...s.w.document.querySelectorAll("a")];
  await s.message({ type: "start", source: "en", target: "ja" });
  const state = await s.settle();
  assert.equal(s.calls.length, 2);
  assert.ok(s.calls[0].document);
  assert.equal(s.calls[1].documents.length, 2);
  assert.equal(state.done, 3); assert.equal(state.percent, 100);
  assert.match(s.w.document.querySelectorAll("p")[1].textContent, /訳:Second/);
  assert.deepEqual([...s.w.document.querySelectorAll("a")], links);
  await s.message({ type: "restore" }); assert.equal(s.w.document.body.innerHTML, html);

  const off = setup(html, translateTree, { batchTranslation: false }); t.after(() => off.dom.window.close());
  await off.message({ type: "start", source: "en", target: "ja" }); await off.settle();
  assert.equal(off.calls.length, 3);
  assert.ok(off.calls.every(call => call.document && !call.documents));
});

test("late batch responses respect stop and changes to individual paragraphs", async t => {
  for (const stop of [true, false]) {
    const releases = [];
    const s = setup('<p>First sentence.</p><p>Second sentence.</p><p>Third sentence.</p>', tree => textOf(tree).startsWith("First") ? translateTree(tree)
      : new Promise(resolve => releases.push(() => resolve(translateTree(tree)))), { batchTranslation: true });
    t.after(() => s.dom.window.close());
    await s.message({ type: "start", source: "en", target: "ja" });
    await new Promise(r => setImmediate(r));
    assert.equal(releases.length, 2);
    if (stop) await s.message({ type: "stop" });
    else s.w.document.querySelectorAll("p")[1].textContent = "Updated by site.";
    releases.forEach(release => release());
    await s.settle(); await new Promise(r => setImmediate(r));
    const paragraphs = s.w.document.querySelectorAll("p");
    assert.equal(paragraphs[0].textContent, "訳:First sentence.");
    assert.equal(paragraphs[1].textContent, stop ? "Second sentence." : "Updated by site.");
    assert.equal(paragraphs[2].textContent, stop ? "Third sentence." : "訳:Third sentence.");
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


test("line breaks, inline widgets and opaque descendants stay in one paragraph", async () => {
  const html = '<p>Read<br><x-label>the <b>latest</b> news</x-label> <img src="/icon.png" alt="icon"> and <span translate="no"><span style="display:block">Brand widget</span><span class="sr-only">Private note</span></span> carefully.</p>';
  // A protected block descendant must not split the surrounding sentence.
  const s = setup(html);
  const p = s.w.document.querySelector("p"), original = p.innerHTML;
  const [br, widget, img] = [p.querySelector("br"), p.querySelector("x-label"), p.querySelector("img")];
  await s.message({ type: "start", source: "en", target: "ja" }); await s.settle();
  assert.equal(s.calls.length, 1);
  assert.match(textOf(s.calls[0].document), /the latest news/);
  assert.ok(!JSON.stringify(s.calls[0].document).includes("Private note"));
  assert.ok(s.calls[0].document.filter(item => item.protected).length >= 2);
  assert.equal(p.querySelector("br"), br); assert.equal(p.querySelector("img"), img);
  assert.equal(p.querySelector("x-label"), widget);
  await s.message({ type: "restore" }); assert.equal(p.innerHTML, original);
  s.dom.window.close();
});

test("unchanged inline order patches original text nodes without child-list mutations", async () => {
  const s = setup('<p><span>First </span><span>sentence</span> with <a href="/docs">a link</a>.</p>', tree => {
    // Real parser output coalesces adjacent text from presentation-only spans.
    const merged = [];
    for (const item of translateTree(tree)) {
      if (item.text !== undefined && merged.at(-1)?.text !== undefined) merged.at(-1).text += item.text;
      else merged.push(item);
    }
    return merged;
  });
  const p = s.w.document.querySelector("p"), original = p.innerHTML;
  const nodes = [...p.querySelectorAll("span,a")].map(el => el.firstChild);
  const mutations = [];
  const observer = new s.w.MutationObserver(items => mutations.push(...items));
  observer.observe(p, { subtree: true, childList: true, characterData: true });
  await s.message({ type: "start", source: "en", target: "ja" }); await s.settle();
  assert.ok(p.textContent.includes("訳:"));
  assert.deepEqual([...p.querySelectorAll("span,a")].map(el => el.firstChild), nodes);
  await s.message({ type: "restore" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.innerHTML, original);
  assert.ok(mutations.some(item => item.type === "characterData"));
  assert.ok(mutations.every(item => item.type !== "childList"));
  observer.disconnect(); s.dom.window.close();
});

test("open shadow roots translate assigned slots once and leave undistributed light DOM alone", async () => {
  const s = setup('<x-article><p slot="body">Slotted <a href="/docs">article</a>.</p><p>Undistributed text.</p></x-article>');
  const host = s.w.document.querySelector("x-article");
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = '<section><slot name="body"></slot><p>Shadow prose.</p></section>';
  const original = host.innerHTML, shadowOriginal = root.innerHTML;
  await s.message({ type: "start", source: "en", target: "ja" }); await s.settle();
  assert.deepEqual(s.calls.map(call => textOf(call.document)), ["Slotted article.", "Shadow prose."]);
  assert.equal(host.lastChild.textContent, "Undistributed text.");
  await s.message({ type: "start", source: "en", target: "ja" }); await s.settle();
  assert.equal(s.calls.length, 2);
  await s.message({ type: "restore" });
  assert.equal(host.innerHTML, original); assert.equal(root.innerHTML, shadowOriginal);
  s.dom.window.close();
});

test("source extraction retains joiners, bidi marks and emoji sequences", async () => {
  const text = "Read 🧑‍💻 and می‌خواهم and \u200eEnglish\u200f.";
  const s = setup(`<p>${text}</p>`);
  await s.message({ type: "start", source: "auto", target: "ja" }); await s.settle();
  assert.equal(textOf(s.calls[0].document), text);
  await s.message({ type: "restore" }); assert.equal(s.w.document.querySelector("p").textContent, text);
  s.dom.window.close();
});

test("pending translations reject link and ancestor language changes", async () => {
  for (const mutate of [s => s.w.document.querySelector("a").href = "/new", s => s.w.document.querySelector("p").lang = "ja", s => s.w.document.querySelector("p").style.display = "none"]) {
    let release;
    const s = setup('<p>Read <a href="/old">this article</a>.</p>', tree => new Promise(resolve => { release = () => resolve(translateTree(tree)); }));
    await s.message({ type: "start", source: "en", target: "ja" });
    for (let i = 0; i < 100 && !release; i++) await new Promise(resolve => setImmediate(resolve));
    mutate(s); release();
    assert.equal((await s.settle()).failed, 1);
    assert.equal(s.w.document.querySelector("p").textContent, "Read this article.");
    s.dom.window.close();
  }
});

test("restoration preserves live updates inside protected widgets after link reordering", async () => {
  const s = setup('<p>Read <a href="/one">one</a> and <a href="/two">two</a> <button><span>Old state</span></button>.</p>', tree => {
    const links = tree.filter(item => item.tag === "a"), widget = tree.find(item => item.protected);
    return [{ text: "読む " }, links[1], { text: " と " }, links[0], widget, { text: "。" }];
  });
  const p = s.w.document.querySelector("p"), button = p.querySelector("button");
  await s.message({ type: "start", source: "en", target: "ja" }); await s.settle();
  button.firstChild.textContent = "New live state";
  await s.message({ type: "restore" });
  assert.equal(p.querySelector("button"), button);
  assert.equal(p.textContent, "Read one and two New live state.");
  assert.equal(p.querySelector("a").getAttribute("href"), "/one");
  s.dom.window.close();
});


test("visible paragraphs appear in small batches while offscreen paragraphs keep large batches", async t => {
  const s = setup(Array.from({ length: 27 }, (_, i) => `<p>Paragraph ${i}.</p>`).join(""), translateTree, { batchTranslation: true });
  t.after(() => s.dom.window.close());
  [...s.w.document.querySelectorAll("p")].forEach((el, index) => {
    const top = index < 7 ? 20 + index * 30 : 2000 + index * 30;
    el.getBoundingClientRect = () => ({ top, bottom: top + 20, left: 0, right: 100 });
  });
  await s.message({ type: "start", source: "en", target: "ja" });
  const status = await s.settle();
  assert.deepEqual(s.calls.map(call => call.documents?.length || 1), [1, 2, 4, 16, 4]);
  assert.equal(status.done, 27); assert.equal(status.failed, 0);
});

test("progress shows work and actual waiting phase before the first paragraph finishes", async t => {
  let release;
  const s = setup('<p>First paragraph.</p><p>Second paragraph.</p>', tree => new Promise(resolve => { release = () => resolve(translateTree(tree)); }), { batchTranslation: true });
  t.after(() => s.dom.window.close());
  await s.message({ type: "start", source: "en", target: "ja" });
  await new Promise(r => setImmediate(r));
  const requestId = s.calls[0].requestId;
  const panel = s.shadow.querySelector(".panel");
  await s.message({ type: "translationProgress", requestId, completed: 0, total: 16, phase: "queued" });
  let status = await s.message({ type: "status" });
  assert.equal(status.done, 0); assert.equal(status.percent, 0);
  assert.equal(status.active, 1); assert.equal(status.pending, 1);
  assert.equal(panel.querySelector(".progress-pending").hidden, false);
  assert.match(panel.querySelector(".progress-activity").textContent, /処理中 1段落 · 未着手 1段落.*順番待ち/);
  await s.message({ type: "translationProgress", requestId, completed: 0, total: 16, phase: "translating" });
  assert.match(panel.querySelector(".progress-activity").textContent, /応答待ち/);
  release(); await new Promise(r => setImmediate(r));
  assert.equal(s.w.document.querySelector("p").textContent, "訳:First paragraph.");
  status = await s.message({ type: "status" });
  assert.equal(status.done, 1); assert.equal(status.running, true);
  await s.message({ type: "stop" }); release();
  assert.equal((await s.message({ type: "status" })).active, 0);
  assert.equal(panel.querySelector(".progress-pending").hidden, true);
  await s.message({ type: "translationProgress", requestId: s.calls[1].requestId, completed: 1, total: 1,
    results: [{ index: 0, document: translateTree(s.calls[1].document) }] });
  assert.equal(s.w.document.querySelectorAll("p")[1].textContent, "Second paragraph.");
});

test("validated batch paragraphs appear before the final response and are never applied twice", async t => {
  const releases = [];
  const s = setup('<p>First paragraph.</p><p>Second paragraph.</p><p>Third paragraph.</p>', tree => textOf(tree).startsWith("First") ? translateTree(tree)
    : new Promise(resolve => releases.push(() => resolve(translateTree(tree)))), { batchTranslation: true });
  t.after(() => s.dom.window.close());
  await s.message({ type: "start", source: "en", target: "ja" }); await new Promise(r => setImmediate(r));
  const request = s.calls[1], paragraphs = s.w.document.querySelectorAll("p");
  const progress = { type: "translationProgress", requestId: request.requestId, completed: 0, total: 33,
    results: [{ index: 0, document: translateTree(request.documents[0]) }] };
  await s.message(progress);
  assert.equal(paragraphs[1].textContent, "訳:Second paragraph.");
  assert.equal(paragraphs[2].textContent, "Third paragraph.");
  assert.equal((await s.message({ type: "status" })).done, 2);
  await s.message(progress);
  assert.equal((await s.message({ type: "status" })).done, 2);
  releases.forEach(release => release()); const status = await s.settle();
  assert.equal(status.done, 3); assert.equal(status.failed, 0);
  await s.message({ type: "restore" }); assert.equal(paragraphs[1].textContent, "Second paragraph.");
});

test('selection language swap waits for an explicit retranslation and leaves page text intact', async () => {
  const s = setup('<p>Selected prose.</p>');
  const range = s.w.document.createRange(); range.selectNodeContents(s.w.document.querySelector('p'));
  s.w.getSelection().addRange(range);
  await s.message({ type: 'selection', source: 'en', target: 'ja' });
  await new Promise(setImmediate);
  const swap = s.shadow.querySelector('[aria-label="言語を入れ替える"]');
  const selects = s.shadow.querySelectorAll('.languages select');
  assert.equal(s.calls.length, 1); assert.equal(swap.disabled, false);
  swap.click();
  assert.equal(selects[0].value, 'ja'); assert.equal(selects[1].value, 'en');
  assert.equal(s.calls.length, 1);
  s.shadow.querySelector('.actions .primary').click(); await new Promise(setImmediate);
  assert.equal(s.calls[1].source, 'ja'); assert.equal(s.calls[1].target, 'en');
  assert.equal(s.w.document.querySelector('p').textContent, 'Selected prose.');
  selects[0].value = 'auto'; selects[0].dispatchEvent(new s.w.Event('change'));
  assert.equal(swap.disabled, true);
  s.w.close();
});

test('closed disclosures translate only their first summary, including direct hidden text, and opened content can be translated later', async () => {
  const s = setup('<article><p>Article prose.</p><details><summary>Stores <strong>by area</strong></summary>Hidden direct text.<table><tr><td>Hidden city.</td><td>Hidden store.</td></tr></table></details></article>');
  await s.message({ type: 'start', source: 'en', target: 'ja' }); await s.settle();
  assert.deepEqual(s.calls.map(call => textOf(call.document)), ['Article prose.', 'Stores by area']);
  assert.equal(s.w.document.querySelector('td').textContent, 'Hidden city.');
  s.w.document.querySelector('details').open = true;
  await s.message({ type: 'start', source: 'en', target: 'ja' }); await s.settle();
  assert.ok(s.calls.slice(2).some(call => textOf(call.document) === 'Hidden direct text.'));
  assert.ok(s.w.document.querySelector('td').textContent.startsWith('訳:'));
  await s.message({ type: 'restore' });
  assert.equal(s.w.document.querySelector('td').textContent, 'Hidden city.');
  s.w.close();
});

test('semantic scheduling processes article prose, article tables, other text, then menus even when menus are visible', async () => {
  const html = '<nav><p>Visible menu.</p></nav><p>Other text.</p><article><table><tr><td>Article table.</td></tr></table><p>Offscreen article.</p></article><aside><p>Sidebar.</p></aside>';
  const s = setup(html, translateTree, { prioritizeContent: true, semanticBatching: true, batchTranslation: true });
  const originalHTML = s.w.document.body.innerHTML;
  s.w.document.querySelector('article p').getBoundingClientRect = () => ({ top: 5000, bottom: 5020, left: 0, right: 100 });
  await s.message({ type: 'start', source: 'en', target: 'ja' }); await s.settle();
  assert.deepEqual(s.calls.flatMap(call => (call.documents || [call.document]).map(textOf)), ['Offscreen article.', 'Article table.', 'Other text.', 'Visible menu.', 'Sidebar.']);
  await s.message({ type: 'restore' }); assert.equal(s.w.document.body.innerHTML, originalHTML);
  s.w.close();
});

test('semantic batches pack adjacent table cells and short paragraphs without mixing page components', async () => {
  const html = '<nav><p>Menu one.</p><p>Menu two.</p></nav><article><section><h2>Heading.</h2><p>First sentence.</p><p>Second sentence.</p></section><table>' + '<tr><td>City.</td><td>Store.</td></tr>'.repeat(60) + '</table></article>';
  const s = setup(html, translateTree, { prioritizeContent: true, semanticBatching: true, batchTranslation: true, inputTokens: 6000 });
  const originalHTML = s.w.document.body.innerHTML;
  await s.message({ type: 'start', source: 'en', target: 'ja' }); await s.settle();
  assert.equal(s.calls[0].documents.length, 3);
  const tableCalls = s.calls.filter(call => (call.documents || [call.document]).some(tree => textOf(tree) === 'City.'));
  assert.equal(tableCalls.length, 2);
  assert.equal(tableCalls[0].documents.length, 64);
  assert.ok(tableCalls.every(call => call.documents.every(tree => ['City.', 'Store.'].includes(textOf(tree)))));
  assert.equal(s.calls.length, 4);
  await s.message({ type: 'restore' }); assert.equal(s.w.document.body.innerHTML, originalHTML);
  s.w.close();
});

test('selection streaming preview is literal text, cannot be copied early, and late updates after close are ignored', async () => {
  const s = setup('<p>Selected prose.</p>');
  const originalSend = s.w.browser.runtime.sendMessage;
  let request, release;
  s.w.browser.runtime.sendMessage = message => {
    if (message.type === 'translate' && message.parts) { request = message; return new Promise(resolve => release = resolve); }
    return originalSend(message);
  };
  await s.message({ type: 'selection', text: 'Selected prose.', source: 'en', target: 'ja' }); await new Promise(setImmediate);
  await s.message({ type: 'translationProgress', requestId: request.requestId, completed: 0, total: 15, phase: 'receiving', preview: '<img src=x> unfinished' });
  assert.equal(s.shadow.querySelector('.result').textContent, '<img src=x> unfinished');
  assert.equal(s.shadow.querySelector('img'), null);
  assert.equal(s.shadow.querySelector('.copy').disabled, true);
  s.shadow.querySelector('.panel [aria-label="閉じる"]').click();
  release({ parts: ['Late translation.'] }); await new Promise(setImmediate);
  assert.equal(s.shadow.querySelector('.panel'), null);
  assert.equal(s.w.document.querySelector('p').textContent, 'Selected prose.');
  s.w.close();
});

test('semantic batches keep multi-cell rows together at the 64-unit boundary', async () => {
  const s = setup('<article><p>Intro.</p><table>' + '<tr><td>City.</td><td>Store.</td><td>Address.</td></tr>'.repeat(24) + '</table></article>', translateTree,
    { prioritizeContent: true, semanticBatching: true, batchTranslation: true, inputTokens: 6000 });
  await s.message({ type: 'start', source: 'en', target: 'ja' }); await s.settle();
  const batches = s.calls.filter(call => call.documents);
  assert.equal(batches[0].documents.length, 63); assert.equal(batches[1].documents.length, 9);
  s.w.close();
});

test('a rejected batch disables further batch attempts for that page run', async () => {
  const s = setup('<article>' + '<p>Short sentence.</p>'.repeat(10) + '</article>', translateTree,
    { prioritizeContent: true, semanticBatching: true, batchTranslation: true, inputTokens: 6000 });
  const send = s.w.browser.runtime.sendMessage;
  s.w.browser.runtime.sendMessage = async message => {
    const result = await send(message);
    return message.type === 'translate' && message.documents ? { ...result, batchFallback: true } : result;
  };
  await s.message({ type: 'start', source: 'en', target: 'ja' }); await s.settle();
  assert.equal(s.calls[0].documents.length, 8);
  assert.ok(s.calls.slice(1).every(call => call.document));
  s.w.close();
});

test('posted scan tasks yield to Stop without depending on a background-tab timer', async () => {
  const s = setup('<p>Paragraph to scan.</p>'.repeat(250));
  const NativeChannel = require('node:worker_threads').MessageChannel;
  let yielded = false;
  s.w.MessageChannel = class {
    constructor() {
      const channel = new NativeChannel(); this.port1 = channel.port1; this.port2 = channel.port2;
      const post = channel.port2.postMessage.bind(channel.port2);
      channel.port2.postMessage = value => { if (!yielded) { yielded = true; s.message({ type: 'stop' }); } post(value); };
    }
  };
  await s.message({ type: 'start', source: 'en', target: 'ja' });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(yielded, true); assert.equal(s.calls.length, 0);
  assert.equal((await s.message({ type: 'status' })).running, false);
  s.w.close();
});

test('prose and link density prioritize a div-based article without excluding an unlabelled menu', async () => {
  const article = 'This is a complete article sentence with enough detail to identify its prose. '.repeat(3);
  const s = setup('<div id="menu"><p><a href="/one">Menu one</a></p><p><a href="/two">Menu two</a></p><p><a href="/three">Menu three</a></p></div><p>Other short label</p><div id="story"><p>' + article + '</p></div>', translateTree,
    { prioritizeContent: true, semanticBatching: true, batchTranslation: true });
  await s.message({ type: 'start', source: 'en', target: 'ja' }); await s.settle();
  const texts = s.calls.flatMap(call => (call.documents || [call.document]).map(textOf));
  assert.equal(texts[0], article); assert.equal(texts[1], 'Other short label');
  assert.deepEqual(texts.slice(2), ['Menu one', 'Menu two', 'Menu three']);
  s.w.close();
});

function place(element, top) { element.getBoundingClientRect = () => ({ top, bottom: top + 30, left: 0, right: 100, width: 100, height: 30 }); }

test('adaptive scheduler prioritizes the nearby reading window and follows scroll without cancelling the active request', async () => {
  let release;
  const s = setup('<nav><p>Menu.</p></nav><article><p id="a">Reading now.</p><p id="b">Far article.</p><p id="c">Scroll destination.</p></article>', tree => textOf(tree) === 'Reading now.'
    ? new Promise(resolve => release = () => resolve(translateTree(tree))) : translateTree(tree),
    { adaptiveScheduling: true, prioritizeVisible: true, prioritizeContent: true, semanticBatching: true, batchTranslation: true });
  const doc = s.w.document;
  place(doc.querySelector('nav p'), 20); place(doc.querySelector('#a'), 10); place(doc.querySelector('#b'), 9000); place(doc.querySelector('#c'), 16000);
  let cancellations = 0;
  const send = s.w.browser.runtime.sendMessage;
  s.w.browser.runtime.sendMessage = message => { if (message.type === 'cancel') cancellations++; return send(message); };
  await s.message({ type: 'start', source: 'en', target: 'ja' }); await new Promise(setImmediate);
  assert.equal(s.calls.length, 1); assert.equal(textOf(s.calls[0].document), 'Reading now.');
  place(doc.querySelector('#a'), -16000); place(doc.querySelector('nav p'), -16000); place(doc.querySelector('#b'), -7000); place(doc.querySelector('#c'), 10);
  s.w.scrollY = 16000; doc.dispatchEvent(new s.w.Event('scroll'));
  assert.equal(cancellations, 0); assert.equal(s.calls.length, 1);
  release(); await s.settle();
  assert.equal(textOf(s.calls[1].document), 'Scroll destination.');
  assert.equal((await s.message({ type: 'status' })).done, 4);
  s.w.close();
});

test('nearby menu is processed before distant article text, with the remaining page still translated', async () => {
  const s = setup('<nav><p>Visible menu.</p></nav><article><p>Distant article.</p></article>', translateTree,
    { adaptiveScheduling: true, prioritizeVisible: true, prioritizeContent: true });
  place(s.w.document.querySelector('nav p'), 0); place(s.w.document.querySelector('article p'), 20000);
  await s.message({ type: 'start', source: 'en', target: 'ja' }); await s.settle();
  assert.deepEqual(s.calls.map(call => textOf(call.document)), ['Visible menu.', 'Distant article.']);
  s.w.close();
});

test('adaptive batches respect heading sections and keep heading with its first paragraph', async () => {
  const s = setup('<article><h2>First heading.</h2><p>First paragraph.</p><h2>Second heading.</h2><p>Second paragraph.</p></article>', translateTree,
    { adaptiveScheduling: true, prioritizeVisible: true, prioritizeContent: true, semanticBatching: true, batchTranslation: true });
  place(s.w.document.querySelector('h2'), -10);
  await s.message({ type: 'start', source: 'en', target: 'ja' }); await s.settle();
  assert.deepEqual(s.calls.map(call => Array.from(call.documents, textOf)), [['First heading.', 'First paragraph.'], ['Second heading.', 'Second paragraph.']]);
  s.w.close();
});

test('updated or hidden unsent paragraphs are removed before API submission', async () => {
  let release;
  const s = setup('<p id="first">First request.</p><p id="changed">Old text.</p><p id="hidden">Will hide.</p><p id="last">Remaining text.</p>', tree => textOf(tree) === 'First request.'
    ? new Promise(resolve => release = () => resolve(translateTree(tree))) : translateTree(tree), { adaptiveScheduling: true });
  await s.message({ type: 'start', source: 'en', target: 'ja' }); await new Promise(setImmediate);
  s.w.document.querySelector('#changed').textContent = 'Fresh site text.';
  s.w.document.querySelector('#hidden').style.display = 'none';
  release(); const state = await s.settle();
  assert.deepEqual(s.calls.map(call => textOf(call.document)), ['First request.', 'Remaining text.']);
  assert.equal(state.skipped, 2); assert.equal(state.total, 2); assert.equal(state.done, 2);
  assert.equal(s.w.document.querySelector('#changed').textContent, 'Fresh site text.');
  s.w.close();
});

test('concurrent adaptive planners reserve different paragraphs and never translate their own output again', async () => {
  const s = setup('<article>' + '<p>Distinct paragraph.</p>'.repeat(12) + '</article>', async tree => { await new Promise(setImmediate); return translateTree(tree); },
    { adaptiveScheduling: true, semanticBatching: true, batchTranslation: true, prioritizeContent: true, concurrency: 3 });
  await s.message({ type: 'start', source: 'en', target: 'ja' }); await s.settle();
  assert.equal(s.calls.reduce((n, call) => n + (call.documents?.length || 1), 0), 12);
  assert.ok([...s.w.document.querySelectorAll('p')].every(node => node.textContent === '訳:Distinct paragraph.'));
  await s.message({ type: 'start', source: 'en', target: 'ja' }); await s.settle();
  assert.equal(s.calls.reduce((n, call) => n + (call.documents?.length || 1), 0), 12);
  s.w.close();
});

test('manual rescan translates a site update to the same Text node but not an attribute-only update', async () => {
  const s = setup('<p><a href="/old">Original article.</a></p>', translateTree, { adaptiveScheduling: true });
  const link = s.w.document.querySelector('a'), text = link.firstChild;
  await s.message({ type: 'start', source: 'en', target: 'ja' }); await s.settle();
  link.setAttribute('href', '/new');
  await s.message({ type: 'start', source: 'en', target: 'ja' }); await s.settle();
  assert.equal(s.calls.length, 1);
  text.data = 'Site replaced this article.';
  await s.message({ type: 'start', source: 'en', target: 'ja' }); await s.settle();
  assert.equal(s.calls.length, 2);
  assert.ok(link.textContent.includes('Site replaced this article.'));
  await s.message({ type: 'restore' });
  assert.equal(link.textContent, 'Site replaced this article.'); assert.equal(link.getAttribute('href'), '/new');
  s.w.close();
});

test('sidebar articles and a main banner remain auxiliary while article headers stay with the body', async () => {
  const s = setup('<main><header><p>Site banner.</p></header><article><header><h1>Article title.</h1></header><p>Article body.</p></article></main><aside><article><p>Sidebar article.</p></article></aside>', translateTree,
    { adaptiveScheduling: true, prioritizeContent: true, semanticBatching: true, batchTranslation: true });
  await s.message({ type: 'start', source: 'en', target: 'ja' }); await s.settle();
  const texts = s.calls.flatMap(call => (call.documents || [call.document]).map(textOf));
  assert.deepEqual(texts, ['Article title.', 'Article body.', 'Site banner.', 'Sidebar article.']);
  s.w.close();
});

test('CSS block spans and flex links inside an explicit paragraph never split the surrounding sentence', async () => {
  const html = '<p><span style="display:block">Read </span><a href="/docs" style="display:flex"><strong>the docs</strong></a><span style="display:block"> carefully.</span></p>';
  const s = setup(html, translateTree, { adaptiveScheduling: true });
  const link = s.w.document.querySelector('a'); let clicks = 0;
  link.addEventListener('click', event => { event.preventDefault(); clicks++; });
  await s.message({ type: 'start', source: 'en', target: 'ja' }); await s.settle();
  assert.equal(s.calls.length, 1); assert.equal(textOf(s.calls[0].document), 'Read the docs carefully.');
  assert.equal(s.w.document.querySelector('a'), link); link.click(); assert.equal(clicks, 1);
  await s.message({ type: 'restore' }); assert.equal(s.w.document.body.innerHTML, html);
  s.w.close();
});

test('short regional headings travel with their details and complete peer regions share a batch', async () => {
  const s = setup('<article><p>Intro.</p><h3>First region.</h3><details><summary>Area one.</summary><p>Hidden store.</p></details><h3>Second region.</h3><details><summary>Area two.</summary><p>Hidden store.</p></details></article>', translateTree,
    { adaptiveScheduling: true, prioritizeContent: true, semanticBatching: true, batchTranslation: true });
  await s.message({ type: 'start', source: 'en', target: 'ja' }); await s.settle();
  assert.deepEqual(s.calls.map(call => Array.from(call.documents || [call.document], textOf)), [['Intro.'], ['First region.', 'Area one.', 'Second region.', 'Area two.']]);
  s.w.close();
});

test('adjacent figures share their gallery context without moving their caption nodes', async () => {
  const s = setup('<article><p>Intro.</p><figure><figcaption>Caption one.</figcaption></figure><figure><figcaption>Caption two.</figcaption></figure></article>', translateTree,
    { adaptiveScheduling: true, prioritizeContent: true, semanticBatching: true, batchTranslation: true });
  const captions = [...s.w.document.querySelectorAll('figcaption')];
  await s.message({ type: 'start', source: 'en', target: 'ja' }); await s.settle();
  assert.equal(s.calls.length, 2);
  assert.deepEqual(Array.from(s.calls[1].documents, textOf), ['Caption one.', 'Caption two.']);
  assert.deepEqual([...s.w.document.querySelectorAll('figcaption')], captions);
  s.w.close();
});
