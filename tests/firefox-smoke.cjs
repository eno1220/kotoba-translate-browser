// Real Firefox + the installed extension + a local mock OpenAI endpoint.
// No model or user's Firefox profile is used.
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn, execFileSync } = require("node:child_process");
const assert = require("node:assert/strict");
const parserWindow = new (require("jsdom").JSDOM)("").window;

(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kotoba-firefox-"));
  let resolveResult;
  const result = new Promise(resolve => resolveResult = resolve);
  const requests = [];
  const events = [];
  let articleHTML;
  if (process.env.KOTOBA_HTML_FIXTURE) {
    const doc = new parserWindow.DOMParser().parseFromString(await fs.readFile(process.env.KOTOBA_HTML_FIXTURE, "utf8"), "text/html");
    doc.querySelectorAll("script,link,iframe,img,video,audio,source,object,embed,base").forEach(node => node.remove());
    articleHTML = doc.documentElement.outerHTML;
  }
  let active = 0, maximum = 0;
  const server = http.createServer(async (req, res) => {
    if (req.url === "/request-count") { res.end(JSON.stringify(requests.length)); return; }
    if (req.url === "/away") { res.setHeader("Content-Type", "text/html"); res.end('<!doctype html><title>Linked page</title><p>Another page.</p>'); return; }
    if (req.url === "/fixture") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      if (articleHTML) { res.end(articleHTML); return; }
      res.end(`<!doctype html><html lang="en"><title>Kotoba smoke</title><body>
        <h1>Translation example</h1><p id="paragraph">Read <a id="link" href="/docs">the documentation</a> carefully.</p>
        <pre id="code">const code = 123;</pre><p translate="no" id="skip">Keep this brand</p>
        <p hidden id="hidden">Hidden prose</p><p lang="ja" id="japanese">これは日本語です。</p>
        <input id="input" value="private draft"><p id="injection">Potentially unsafe model response.</p>
        <p>Call <code id="inline-code">request()</code> to load the document.</p>
        <p id="inline-sentence"><span>If you have read my </span><a id="posts" href="/posts"><u><span>earlier posts</span></u></a><span> about </span><a id="assembly" href="/assembly"><u><span>assembly on Linux x86_64</span></u>⁠<span class="sr-only">(opens in a new window)</span></a><span>, you may know my interest in low-level programming.</span></p>
        <p id="modern">Read<br><x-label>the latest news</x-label> 🧑‍💻.</p>
        <x-article id="component"><p slot="body">Slotted article.</p></x-article>
        <p>${"A long source sentence with enough words for chunking. ".repeat(30)}</p>
      </body></html>`); return;
    }
    if (req.method !== "POST") { res.writeHead(404); res.end(); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (req.url === "/screenshot") {
      await fs.writeFile(`/tmp/kotoba-${body.name}.png`, Buffer.from(body.image.split(",")[1], "base64"));
      res.end("ok"); return;
    }
    if (req.url === "/event") { events.push(body); res.end("ok"); return; }
    if (req.url === "/result") { resolveResult({ ...body, events }); res.end("ok"); return; }
    if (req.url !== "/v1/chat/completions") { res.writeHead(404); res.end(); return; }
    active++; maximum = Math.max(maximum, active);
    requests.push({ body, authorization: req.headers.authorization });
    const input = body.messages[0].content;
    let content = "訳:" + input;
    if (body.context?.includes("HTML fragment")) {
      const document = new parserWindow.DOMParser().parseFromString(`<mock-root>${input}</mock-root>`, "application/xml");
      function translate(node) {
        if (node.nodeType === 1 && node.getAttribute("translate") === "no") return;
        if (node.nodeType === 3 && node.data.trim()) node.data = "訳:" + node.data;
        for (const child of node.childNodes) translate(child);
      }
      translate(document.documentElement);
      content = document.documentElement.innerHTML;
    }
    if (input.includes("earlier posts") && input.includes("assembly on Linux x86_64")) content = '以前の<a id="k2"><u id="k3">Linux x86_64のアセンブリ言語</u></a>に関する<a id="k0"><u id="k1">投稿</u></a>を読んだ方は、私が低レベルプログラミングに関心を持っていることをご存じでしょう。';
    if (input.includes("Potentially unsafe")) content = '<img src=x onerror="window.compromised=true">';
    await new Promise(r => setTimeout(r, articleHTML ? 4 : 40));
    if (body.stream) {
      res.setHeader("Content-Type", "text/event-stream");
      const points = Array.from(content);
      for (let i = 0; i < points.length; i += 32) {
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: points.slice(i, i + 32).join("") }, finish_reason: null }] })}\n\n`);
        await new Promise(resolve => setTimeout(resolve, 2));
      }
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { completion_tokens: 42 } })}\n\ndata: [DONE]\n\n`);
    } else {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { completion_tokens: 42 } }));
    }
    active--;
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  const port = server.address().port;
  const source = path.join(directory, "extension");
  await fs.cp(path.resolve("extension"), source, { recursive: true });
  if (process.env.KOTOBA_BASELINE) {
    const core = await fs.readFile(path.join(source, "core.js"), "utf8");
    const protocol = core.match(/const CONTENT_PROTOCOL = (\d+);/)[1];
    const previous = execFileSync("git", ["show", `${process.env.KOTOBA_BASELINE_REF || "HEAD"}:extension/content.js`], { encoding: "utf8" });
    await fs.writeFile(path.join(source, "content.js"), previous.replace(/const PROTOCOL = \d+;/, `const PROTOCOL = ${protocol};`));
  }
  if (process.env.KOTOBA_PAGE_URL) {
    const file = path.join(source, "background.js");
    const value = await fs.readFile(file, "utf8");
    await fs.writeFile(file, value.replace('function abortTab(tabId, frameId) {', 'function abortTab(tabId, frameId) { fetch("http://127.0.0.1:'+port+'/event",{method:"POST",body:JSON.stringify({kind:"abort",tabId,frameId,jobs:jobs.size,stack:new Error().stack})}).catch(()=>{});'));
  }
  if (process.env.KOTOBA_STALE) await fs.copyFile(path.resolve("tests/fixtures/stale-content.js"), path.join(source, "stale-content.js"));
  const manifest = JSON.parse(await fs.readFile(path.join(source, "manifest.json"), "utf8"));
  manifest.permissions.push("<all_urls>"); // captureTab for visual QA in this temporary build only.
  manifest.background.scripts.push("smoke.js");
  await fs.writeFile(path.join(source, "manifest.json"), JSON.stringify(manifest));
  // Preview the real popup in a tab while targeting the fixture tab.
  const popupSource = await fs.readFile(path.join(source, "popup.js"), "utf8");
  await fs.writeFile(path.join(source, "popup.js"), 'async function sendPreview(message) { const bg = await browser.runtime.getBackgroundPage(); try { return await bg.handle(message, {id:browser.runtime.id}); } catch(error) { return {error:error.message,errorCode:error.code}; } }\n' + popupSource.replaceAll('browser.runtime.sendMessage(', 'sendPreview(').replace('const [tab] = await browser.tabs.query({ active: true, currentWindow: true });', 'const tab = await browser.tabs.get(Number(new URL(location.href).searchParams.get("previewTab")));'));
  let contentSource = await fs.readFile(path.join(source, "content.js"), "utf8");
  if (process.env.KOTOBA_PAGE_URL) {
    const report = reason => 'fetch("http://127.0.0.1:'+port+'/event",{method:"POST",body:JSON.stringify({kind:"skip",reason:"'+reason+'",article:!!group.parent.closest?.("article"),length:group.length})}).catch(()=>{});';
    contentSource = contentSource.replace('state.failed++; state.message = response.error;', report('structure')+'state.failed++; state.message = response.error;')
      .replace('state.failed++; state.message = "更新された段落は適用していません";', report('site_update')+'state.failed++; state.message = "更新された段落は適用していません";');
  }
  // Expose only the test build's shadow root to assert the visible UI.
  await fs.writeFile(path.join(source, "content.js"), contentSource.replace('attachShadow({ mode: "closed" })', 'attachShadow({ mode: "open" })'));
  await fs.writeFile(path.join(source, "smoke.js"), `
    (async () => {
      const base = 'http://127.0.0.1:${port}';
      const check = (value, message) => { if (!value) throw new Error(message); };
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      try {
        await browser.storage.local.set({ settings: { ...Kotoba.DEFAULTS, port: '${port}', apiKey: 'smoke-key', responsiveScan:${!process.env.KOTOBA_HTML_FIXTURE}, streamTranslation:${!!process.env.KOTOBA_STREAM}, inputTokens: ${process.env.KOTOBA_HTML_FIXTURE ? process.env.KOTOBA_BASELINE ? 3000 : 6000 : process.env.KOTOBA_PAGE_URL ? 3000 : 400} } });
        ${process.env.KOTOBA_HTML_FIXTURE ? `
        const articleTab = await browser.tabs.create({url:base+'/fixture',active:true});
        for(let i=0;i<100;i++) { if((await browser.tabs.get(articleTab.id)).status === 'complete') break; await wait(50); }
        await ensureContent(articleTab.id);
        await browser.tabs.sendMessage(articleTab.id,{type:'start',source:'ja',target:'en'});
        let articleState;
        for(let i=0;i<1000;i++) { articleState=await browser.tabs.sendMessage(articleTab.id,{type:'status'}); if(!articleState.running) break; await wait(30); }
        check(!articleState.running && articleState.total > 0 && !articleState.failed,JSON.stringify(articleState));
        ${process.env.KOTOBA_BASELINE ? '' : `check(articleState.total < 200, 'closed tables entered translation');
        check(!(await browser.tabs.executeScript(articleTab.id,{code:'[...document.querySelectorAll("details:not([open]) td")].some(el=>el.textContent.startsWith("訳:"))'}))[0], 'closed table text changed');`}
        await fetch(base+'/result',{method:'POST',body:JSON.stringify({ok:true,articleFixture:true,state:articleState})}); return;` : ''}
        ${process.env.KOTOBA_PAGE_URL ? `
        browser.tabs.onUpdated.addListener((tabId,change) => { if(change.status || change.url) fetch(base+'/event',{method:'POST',body:JSON.stringify({kind:'tab',tabId,change})}).catch(()=>{}); });
        const realTab = await browser.tabs.create({url:${JSON.stringify(process.env.KOTOBA_PAGE_URL)},active:true});
        for (let i=0; i<300; i++) { if((await browser.tabs.get(realTab.id)).status === 'complete') break; await wait(100); }
        const metadata = (await browser.tabs.executeScript(realTab.id,{code:'({title:document.title,url:location.href,lang:document.documentElement.lang,length:document.body?.innerText.length,article:!!document.querySelector("article")})'}))[0];
        check(metadata.length > 10000, 'page could not be loaded: '+JSON.stringify(metadata));
        await ensureContent(realTab.id);
        await browser.tabs.sendMessage(realTab.id,{type:'start',source:'en',target:'ja'});
        let realState;
        for(let i=0;i<1200;i++) { realState=await browser.tabs.sendMessage(realTab.id,{type:'status'}); if(!realState.running) break; await wait(50); }
        check(!realState.running && realState.done === realState.total && realState.translated > 0 && !realState.message.includes('不正または大きすぎ'),JSON.stringify({metadata,state:realState}));
        await fetch(base+'/result',{method:'POST',body:JSON.stringify({ok:true,realPage:true,state:realState,metadata})});
        return;` : ''}
        const dictionaryTab = await browser.tabs.create({url:browser.runtime.getURL('dictionary.html')+'?domain=127.0.0.1',active:true});
        let dictionaryView;
        for(let i=0;i<100;i++) {
          dictionaryView = browser.extension.getViews().find(view => view.location.pathname === '/dictionary.html');
          if(dictionaryView?.document.querySelector('#save')?.disabled === false) break;
          await wait(50);
        }
        check(dictionaryView?.document.querySelector('#scope').value === '127.0.0.1', 'dictionary did not select the current domain');
        const dict = id => dictionaryView.document.getElementById(id);
        const termInput = (field, value) => { field.value=value; field.dispatchEvent(new dictionaryView.Event('input',{bubbles:true})); };
        dict('add-entry').click();
        let termFields = dict('entries').querySelectorAll('input');
        termInput(termFields[0], 'File'); termInput(termFields[1], 'ファイル');
        dict('save').click();
        for(let i=0;i<100;i++) { if(dict('status').textContent.startsWith('保存しました')) break; await wait(20); }
        check((await browser.storage.local.get('settings')).settings.dictionary?.[0].target === 'ファイル', 'dictionary UI did not save');
        termInput(dict('entries').querySelectorAll('input')[1], '未保存'); dict('discard').click();
        check(dict('entries').querySelectorAll('input')[1].value === 'ファイル', 'dictionary discard failed');
        await fetch(base+'/screenshot',{method:'POST',body:JSON.stringify({name:'dictionary',image:await browser.tabs.captureTab(dictionaryTab.id,{format:'png'})})});
        await generate(await getSettings(), 'File', {source:'en',target:'ja',domain:base}, new AbortController().signal);
        dict('remove-scope').click(); dict('save').click();
        for(let i=0;i<100;i++) { if((await browser.storage.local.get('settings')).settings.dictionary?.length === 0) break; await wait(20); }
        check((await browser.storage.local.get('settings')).settings.dictionary?.length === 0, 'dictionary scope deletion did not persist');
        await browser.tabs.remove(dictionaryTab.id);
        const tab = await browser.tabs.create({url: base + '/fixture', active: true});
        for (let i=0; i<100; i++) { if ((await browser.tabs.get(tab.id)).status === 'complete') break; await wait(100); }
        ${process.env.KOTOBA_STALE ? 'await browser.tabs.executeScript(tab.id, {file:"stale-content.js",runAt:"document_idle"});' : ''}
        ${process.env.KOTOBA_STALE ? `let staleError;
        try { await ensureContent(tab.id); } catch(error) { staleError = error; }
        check(staleError?.code === 'stale_content', 'stale content was silently reused');
        await new Promise((resolve, reject) => {
          const updated = (id, change) => { if (id === tab.id && change.status === 'complete') { browser.tabs.onUpdated.removeListener(updated); resolve(); } };
          browser.tabs.onUpdated.addListener(updated);
          browser.tabs.reload(tab.id).catch(error => { browser.tabs.onUpdated.removeListener(updated); reject(error); });
        });` : ''}
        await ensureContent(tab.id);
        const batchCheck = await translateDocuments(await getSettings(), [[{text:'First short paragraph.'}],[{text:'Second short paragraph.'}]], {source:'en',target:'ja',domain:base}, new AbortController().signal, () => {});
        check(batchCheck.length === 2 && batchCheck.every(item => Kotoba.documentText(item.document).startsWith('訳:')), 'batch response did not restore paragraph text');
        const send = msg => browser.tabs.sendMessage(tab.id, msg);
        const inspect = async code => (await browser.tabs.executeScript(tab.id, {code}))[0];
        check((await send({type:'status'})).translated === 0, 'translated automatically');
        await inspect('window.testClicks = 0; document.querySelector("#link").addEventListener("click", e => {e.preventDefault();window.testClicks++})');
        await inspect('window.modernOriginal = document.querySelector("#modern").innerHTML; window.modernText = document.querySelector("#modern x-label").firstChild; window.articleRoot = document.querySelector("#component").attachShadow({mode:"open"}); window.articleRoot.innerHTML = "<section><slot name=body></slot><p>Shadow prose.</p></section>";');
        await pageAction('translate-page', tab, await getSettings());
        ${process.env.KOTOBA_HISTORY ? 'await browser.tabs.executeScript(tab.id,{code:"history.replaceState({test:true}, document.title, location.href)"});' : ''}
        let firstPaint;
        for (let i=0; i<100; i++) { firstPaint = await send({type:'status'}); if (firstPaint.done > 0) break; await wait(10); }
        check(firstPaint.done > 0 && firstPaint.running && firstPaint.done < firstPaint.total, 'first translation waited for the full page');
        const preview = await browser.tabs.create({url:browser.runtime.getURL('popup.html')+'?previewTab='+tab.id,active:true});
        await wait(250);
        await fetch(base + '/screenshot', {method:'POST',body:JSON.stringify({name:'popup',image:await browser.tabs.captureTab(preview.id,{format:'png'})})});
        const popupView = browser.extension.getViews().find(view => view.location.href.includes("previewTab="));
        check(popupView.document.querySelector("#batch-translation").checked === true, 'batch setting should default on');
        const progressState = await send({type:'status'}); popupView.render(progressState);
        if (progressState.running) {
          check(!popupView.document.querySelector('#progress-activity').hidden && popupView.document.querySelector('#work').textContent.includes('処理中'), 'popup activity missing');
          check(popupView.document.querySelector('#phase').textContent.length > 0, 'popup request phase missing');
        }
        popupView.document.querySelector("#batch-translation").click();
        await wait(100);
        check((await browser.storage.local.get('settings')).settings.batchTranslation === false, 'popup did not save batch setting');
        await browser.tabs.remove(preview.id);
        await browser.tabs.update(tab.id,{active:true});
        let state;
        for (let i=0; i<300; i++) { state = await send({type:'status'}); if (!state.running) break; await wait(100); }
        check(state.done === state.total && state.failed === 0 && state.translated > 0, JSON.stringify(state));
        check(state.percent === 100, 'progress did not reach 100%');
        const history = await handle({type:'cacheHistory'}, {id:browser.runtime.id});
        check(history.rows.length === 1 && history.rows[0].paragraphs > 0 && history.rows[0].paragraphs <= state.total && history.rows[0].characters > 0, 'history did not group cached page paragraphs: '+JSON.stringify(history));
        check(history.rows[0].outputTokens > 0 && history.rows[0].tokensPerSecond > 0 && history.rows[0].milliseconds > 0, 'history metrics missing');
        const historyTab = await browser.tabs.create({url:browser.runtime.getURL('history.html'),active:true});
        await wait(150);
        const historyView = browser.extension.getViews().find(view => view.location.pathname === '/history.html');
        for (let i=0; i<20 && !historyView.document.querySelectorAll('#entries tr').length; i++) await wait(50);
        check(historyView.document.querySelectorAll('#entries tr').length === 1, 'history page did not render: '+historyView.document.querySelector('#status')?.textContent);
        await fetch(base + '/screenshot', {method:'POST',body:JSON.stringify({name:'history',image:await browser.tabs.captureTab(historyTab.id,{format:'png'})})});
        check(historyView.document.documentElement.scrollWidth <= historyView.innerWidth, 'history overflows the viewport');
        await fetch(base + '/screenshot', {method:'POST',body:JSON.stringify({name:'history-narrow',image:await browser.tabs.captureTab(historyTab.id,{format:'png'})})});
        await browser.tabs.remove(historyTab.id); await browser.tabs.update(tab.id,{active:true});
        const data = await inspect(\`(() => {
          document.querySelector('#link').click();
          return { paragraph:document.querySelector('#paragraph').textContent, href:document.querySelector('#link').getAttribute('href'), clicks:window.testClicks,
            code:document.querySelector('#code').textContent, skip:document.querySelector('#skip').textContent,
            hidden:document.querySelector('#hidden').textContent, japanese:document.querySelector('#japanese').textContent,
            input:document.querySelector('#input').value, inlineCode:document.querySelector('#inline-code').textContent, injection:document.querySelector('#injection').textContent,
            images:document.querySelectorAll('img').length, compromised:!!window.compromised };
        })()\`);
        check(data.paragraph.includes('訳:') && data.href === '/docs' && data.clicks === 1, 'link structure or listener lost');
        check(data.code === 'const code = 123;' && data.skip === 'Keep this brand' && data.hidden === 'Hidden prose' && data.japanese === 'これは日本語です。' && data.input === 'private draft', 'excluded content changed');
        check(data.inlineCode === 'request()', 'inline code changed');
        check(await inspect('document.querySelector("#modern x-label").firstChild === window.modernText && window.modernText.data.startsWith("訳:") && !!document.querySelector("#modern br") && document.querySelector("#modern").textContent.includes("🧑‍💻")'), 'modern inline DOM identity or joiner lost');
        check(await inspect('document.querySelector("[slot=body]").textContent.startsWith("訳:") && window.articleRoot.querySelector("p").textContent.startsWith("訳:")'), 'slotted or shadow content not translated');
        const order = await inspect('({first:document.querySelector("#inline-sentence a").id,last:document.querySelectorAll("#inline-sentence a")[1].id,note:document.querySelector(".sr-only").textContent})');
        check(order.first === 'assembly' && order.last === 'posts' && order.note === '(opens in a new window)', 'link order or screen-reader note changed incorrectly');
        check(data.injection.startsWith('<img') && data.images === 0 && !data.compromised, 'model HTML executed');
        await inspect('getSelection().removeAllRanges(); const hoverRange = document.createRange(); hoverRange.selectNodeContents(document.querySelector("h1").firstChild); const rect = hoverRange.getBoundingClientRect(); document.dispatchEvent(new PointerEvent("pointermove", {clientX:rect.left+10,clientY:rect.top+rect.height/2,pointerType:"mouse",bubbles:true}));');
        for (let i=0; i<30; i++) { if(await inspect('!!document.querySelector("[data-kotoba-ui]").shadowRoot.querySelector(".tooltip")')) break; await wait(100); }
        const hover = await inspect('({text:document.querySelector("[data-kotoba-ui]").shadowRoot.querySelector(".tooltip .original")?.textContent,collapsed:getSelection()?.isCollapsed,visibility:document.visibilityState,focus:document.hasFocus()})');
        check(hover.text === 'Translation example', 'original hover missing: '+JSON.stringify(hover));
        const keyboardOriginal = await inspect('(() => { document.querySelector("#link").blur(); document.querySelector("#link").focus(); document.querySelector("#link").dispatchEvent(new FocusEvent("focusin",{bubbles:true,composed:true})); const root = document.querySelector("[data-kotoba-ui]").shadowRoot; const tip = root.querySelector(".tooltip"); document.dispatchEvent(new KeyboardEvent("keydown",{key:"F2",bubbles:true})); const focused = root.activeElement === tip; document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})); return {text:tip?.querySelector(".original").textContent,focused,returned:document.activeElement.id === "link",closed:!root.querySelector(".tooltip")}; })()');
        check(keyboardOriginal.text === 'Read the documentation carefully.' && keyboardOriginal.focused && keyboardOriginal.returned && keyboardOriginal.closed, 'keyboard original dialog failed: '+JSON.stringify(keyboardOriginal));
        await fetch(base + '/screenshot', {method:'POST',body:JSON.stringify({name:'page',image:await browser.tabs.captureTab(tab.id,{format:'png'})})});
        await pageAction('restore-page', tab, await getSettings());
        check(await inspect('document.querySelector("#paragraph").textContent') === 'Read the documentation carefully.', 'restore failed');
        check(await inspect('document.querySelector("#modern").innerHTML === window.modernOriginal && document.querySelector("[slot=body]").textContent === "Slotted article." && window.articleRoot.querySelector("p").textContent === "Shadow prose."'), 'modern DOM restore failed');
        check(await inspect('document.querySelector("#inline-sentence a").id') === 'posts', 'original link order was not restored');
        await inspect('const r = document.createRange(); r.selectNodeContents(document.querySelector("#paragraph")); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);');
        await send({type:'selection',source:'en',target:'ja'});
        await wait(250);
        check(await inspect('!!document.querySelector("[data-kotoba-ui]")'), 'selection panel missing');
        await fetch(base + '/screenshot', {method:'POST',body:JSON.stringify({name:'selection',image:await browser.tabs.captureTab(tab.id,{format:'png'})})});
        const options = await browser.tabs.create({url:browser.runtime.getURL('options.html'),active:true});
        await wait(200);
        await fetch(base + '/screenshot', {method:'POST',body:JSON.stringify({name:'options',image:await browser.tabs.captureTab(options.id,{format:'png'})})});
        const optionsView = browser.extension.getViews().find(view => view.location.pathname === "/options.html");
        const optionsForm = optionsView.document.querySelector("#settings");
        optionsView.document.querySelector('#test-connection').click();
        for (let i=0; i<30 && !optionsView.document.querySelector('#connection-status').textContent.includes('接続できました'); i++) await wait(50);
        check(optionsView.document.querySelector('#connection-status').textContent.includes('接続できました'), 'settings connection probe failed');
        check(optionsView.document.documentElement.scrollWidth <= optionsView.innerWidth, 'settings overflow the viewport');
        await fetch(base + '/screenshot', {method:'POST',body:JSON.stringify({name:'options-narrow',image:await browser.tabs.captureTab(options.id,{format:'png'})})});
        for (const key of ['responsiveScan','pageProgress','announceProgress','copyButton','focusOriginal']) optionsForm.elements.namedItem(key).checked = false;
        optionsForm.elements.namedItem('selectionButton').checked = true;
        optionsForm.requestSubmit();
        await wait(100);
        const saved = (await browser.storage.local.get('settings')).settings;
        check(saved.batchTranslation === false, 'options reset batch setting');
        check(saved.selectionButton === true && ['responsiveScan','pageProgress','announceProgress','copyButton','focusOriginal'].every(key => saved[key] === false), 'options did not save boolean switches');
        await browser.tabs.remove(options.id);
        await browser.tabs.update(tab.id, {active:true});
        await wait(100);
        await inspect('document.querySelector("[data-kotoba-ui]").shadowRoot.querySelector(".panel [aria-label=閉じる]")?.click(); const quickRange = document.createRange(); quickRange.selectNodeContents(document.querySelector("#paragraph")); document.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true})); getSelection().removeAllRanges(); getSelection().addRange(quickRange); document.dispatchEvent(new Event("selectionchange")); document.dispatchEvent(new PointerEvent("pointerup",{bubbles:true}));');
        for (let i=0;i<100;i++) { if(await inspect('!!document.querySelector("[data-kotoba-ui]").shadowRoot.querySelector(".launcher")')) break; await wait(50); }
        const beforeQuick = await (await fetch(base+'/request-count')).json();
        check(await inspect('!!document.querySelector("[data-kotoba-ui]").shadowRoot.querySelector(".launcher")'), 'selection launcher missing: '+JSON.stringify(await inspect('({focus:document.hasFocus(),selection:getSelection().toString(),top:document.querySelector("#paragraph").getBoundingClientRect().top})')));
        await inspect('document.querySelector("[data-kotoba-ui]").shadowRoot.querySelector(".launcher").click()');
        for(let i=0;i<100;i++) { if(await inspect('!!document.querySelector("[data-kotoba-ui]").shadowRoot.querySelector(".result")?.textContent')) break; await wait(50); }
        check((await (await fetch(base+'/request-count')).json()) > beforeQuick && await inspect('document.querySelector("[data-kotoba-ui]").shadowRoot.querySelector(".result").textContent.startsWith("訳:")'), 'selection launcher did not translate on click');
        check(await inspect('!document.querySelector("[data-kotoba-ui]").shadowRoot.querySelector(".copy")'), 'copy switch ignored');
        await browser.storage.local.set({ settings: { ...saved, selectionButton:false } });
        await wait(100);
        await inspect('document.querySelector("[data-kotoba-ui]").shadowRoot.querySelector(".panel [aria-label=閉じる]")?.click(); getSelection().removeAllRanges();');
        // Fill the cache after the settings changes above, then exercise both
        // history navigation and a fresh document (without Firefox's bfcache).
        await send({type:'start',source:'en',target:'ja'});
        for (let i=0; i<300; i++) { if (!(await send({type:'status'})).running) break; await wait(100); }
        check(await inspect('!document.querySelector("[data-kotoba-ui]").shadowRoot.querySelector(".panel") && !document.querySelector("[data-kotoba-ui]").shadowRoot.querySelector("[role=status]").textContent'), 'progress display switches ignored');
        check(translationCache.size > 0, 'page cache stayed empty');
        const beforeRevisit = await (await fetch(base+'/request-count')).json();
        const navigate = action => new Promise((resolve, reject) => {
          const updated = (id, change) => { if (id === tab.id && change.status === 'complete') { browser.tabs.onUpdated.removeListener(updated); resolve(); } };
          browser.tabs.onUpdated.addListener(updated);
          action().catch(error => { browser.tabs.onUpdated.removeListener(updated); reject(error); });
        });
        await navigate(() => inspect('const next = document.createElement("a"); next.href="/away"; document.body.append(next); next.click();'));
        await navigate(() => browser.tabs.goBack(tab.id));
        await navigate(() => browser.tabs.reload(tab.id));
        let cachedState;
        for (let i=0; i<100; i++) {
          try { cachedState = await send({type:'status'}); if (cachedState.translated > 0) break; } catch {}
          await wait(50);
        }
        check(cachedState?.translated > 0 && cachedState.source === 'en' && cachedState.target === 'ja', 'revisit did not restore cache');
        check((await (await fetch(base+'/request-count')).json()) === beforeRevisit, 'revisit started an API request');
        check((await inspect('document.querySelector("#paragraph").textContent')).includes('訳:'), 'cached paragraph missing');
        check((await inspect('document.querySelector("#link").getAttribute("href")')) === '/docs', 'cached link lost');
        await send({type:'restore'});
        check((await inspect('document.querySelector("#paragraph").textContent')) === 'Read the documentation carefully.', 'cached original restore failed');
        await fetch(base + '/result', { method:'POST', body: JSON.stringify({ok:true,state,data}) });
      } catch(error) { await fetch(base + '/result', { method:'POST', body: JSON.stringify({ok:false,error:[error.message,error.stack].join(String.fromCharCode(10))}) }); }
    })();
  `);
  const child = spawn(process.execPath, [path.resolve("node_modules/web-ext/bin/web-ext.js"), "run", "--source-dir", source, "--firefox", process.env.FIREFOX || "/Applications/Firefox.app/Contents/MacOS/firefox", "--args=-headless", "--pref=intl.accept_languages=en-US,en", "--no-reload", "--no-input", "--no-config-discovery"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_UPDATE_NOTIFIER: "1" } });
  let logs = "";
  child.stdout.on("data", chunk => logs += chunk);
  child.stderr.on("data", chunk => logs += chunk);
  let timeout;
  try {
    const response = await Promise.race([result, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Firefox smoke timed out\n" + logs)), 45000); })]);
    assert.ok(response.ok, response.error + (process.env.KOTOBA_PAGE_URL ? JSON.stringify(response.events) : ""));
    assert.equal(maximum, 1);
    if (response.articleFixture) {
      if (!process.env.KOTOBA_BASELINE) assert.ok(requests.length < 40, JSON.stringify({ requests: requests.length, samples: requests.slice(0, 25).map(request => ({ length: request.body.messages[0].content.length, items: (request.body.messages[0].content.match(/<p id="b/g) || []).length, first: request.body.messages[0].content.slice(0, 45) })) }));
      console.log(JSON.stringify({ articleFixture: true, baseline: !!process.env.KOTOBA_BASELINE, blocks: response.state.total, requests: requests.length, milliseconds: response.state.finishedAt - response.state.startedAt, characters: requests.reduce((sum, request) => sum + request.body.messages[0].content.length, 0) }));
      return;
    }
    if (response.realPage) {
      assert.ok(requests.length > 0);
      assert.ok(requests.every(r => r.body.context.includes(new URL(process.env.KOTOBA_PAGE_URL).origin)));
      console.log(JSON.stringify({realPage:response.metadata,state:response.state,requests:requests.length,concurrency:maximum,events:response.events.filter(event=>event.kind === "tab" || event.kind === "skip" || event.jobs > 0)}));
      return;
    }
    assert.ok(requests.length > 5);
    assert.ok(requests.some(r => r.body.glossary?.[0]?.target === "ファイル" && r.body.use_glossary === true));
    assert.ok(requests.some(r => r.body.messages[0].content.includes('earlier posts') && r.body.messages[0].content.includes('assembly on Linux x86_64')));
    assert.ok(requests.every(r => !r.body.messages[0].content.includes('(opens in a new window)')));
    assert.ok(requests.every(r => r.body.max_tokens === 8096 && r.body.context.includes(`web page on http://127.0.0.1:${port}`) && r.authorization === "Bearer smoke-key"));
    console.log(`Firefox smoke passed: ${response.state.total} blocks, ${requests.length} API requests, peak concurrency ${maximum}.`);
  } finally {
    clearTimeout(timeout); child.kill("SIGTERM");
    server.closeAllConnections(); server.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
