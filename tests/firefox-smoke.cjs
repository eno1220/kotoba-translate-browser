// Real Firefox + the installed extension + a local mock OpenAI endpoint.
// No model or user's Firefox profile is used.
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");

(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kotoba-firefox-"));
  let resolveResult;
  const result = new Promise(resolve => resolveResult = resolve);
  const requests = [];
  let active = 0, maximum = 0;
  const server = http.createServer(async (req, res) => {
    if (req.url === "/fixture") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(`<!doctype html><html lang="en"><title>Kotoba smoke</title><body>
        <h1>Translation example</h1><p id="paragraph">Read <a id="link" href="/docs">the documentation</a> carefully.</p>
        <pre id="code">const code = 123;</pre><p translate="no" id="skip">Keep this brand</p>
        <p hidden id="hidden">Hidden prose</p><p lang="ja" id="japanese">これは日本語です。</p>
        <input id="input" value="private draft"><p id="injection">Potentially unsafe model response.</p>
        <p>Call <code id="inline-code">request()</code> to load the document.</p>
        <p id="inline-sentence"><span>If you have read my </span><a id="posts" href="/posts"><u><span>earlier posts</span></u></a><span> about </span><a id="assembly" href="/assembly"><u><span>assembly on Linux x86_64</span></u>⁠<span class="sr-only">(opens in a new window)</span></a><span>, you may know my interest in low-level programming.</span></p>
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
    if (req.url === "/result") { resolveResult(body); res.end("ok"); return; }
    if (req.url !== "/v1/chat/completions") { res.writeHead(404); res.end(); return; }
    active++; maximum = Math.max(maximum, active);
    requests.push({ body, authorization: req.headers.authorization });
    const input = body.messages[0].content;
    let content = "訳:" + input;
    if (input.includes("earlier posts") && input.includes("assembly on Linux x86_64")) content = '以前の<a id="k2"><u id="k3">Linux x86_64のアセンブリ言語</u></a>に関する<a id="k0"><u id="k1">投稿</u></a>を読んだ方は、私が低レベルプログラミングに関心を持っていることをご存じでしょう。';
    if (input.includes("Potentially unsafe")) content = '<img src=x onerror="window.compromised=true">';
    await new Promise(r => setTimeout(r, 40));
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }));
    active--;
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const source = path.join(directory, "extension");
  await fs.cp(path.resolve("extension"), source, { recursive: true });
  const manifest = JSON.parse(await fs.readFile(path.join(source, "manifest.json"), "utf8"));
  manifest.permissions.push("<all_urls>"); // captureTab for visual QA in this temporary build only.
  manifest.background.scripts.push("smoke.js");
  await fs.writeFile(path.join(source, "manifest.json"), JSON.stringify(manifest));
  // Preview the real popup in a tab while targeting the fixture tab.
  const popupSource = await fs.readFile(path.join(source, "popup.js"), "utf8");
  await fs.writeFile(path.join(source, "popup.js"), 'async function sendPreview(message) { const bg = await browser.runtime.getBackgroundPage(); try { return await bg.handle(message, {id:browser.runtime.id}); } catch(error) { return {error:error.message}; } }\n' + popupSource.replaceAll('browser.runtime.sendMessage(', 'sendPreview(').replace('const [tab] = await browser.tabs.query({ active: true, currentWindow: true });', 'const tab = await browser.tabs.get(Number(new URL(location.href).searchParams.get("previewTab")));'));
  const contentSource = await fs.readFile(path.join(source, "content.js"), "utf8");
  // Expose only the test build's shadow root to assert the visible UI.
  await fs.writeFile(path.join(source, "content.js"), contentSource.replace('attachShadow({ mode: "closed" })', 'attachShadow({ mode: "open" })'));
  await fs.writeFile(path.join(source, "smoke.js"), `
    (async () => {
      const base = 'http://127.0.0.1:${port}';
      const check = (value, message) => { if (!value) throw new Error(message); };
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      try {
        await browser.storage.local.set({ settings: { ...Kotoba.DEFAULTS, port: '${port}', apiKey: 'smoke-key', inputTokens: 400 } });
        const tab = await browser.tabs.create({url: base + '/fixture', active: true});
        for (let i=0; i<100; i++) { if ((await browser.tabs.get(tab.id)).status === 'complete') break; await wait(100); }
        await ensureContent(tab.id);
        const send = msg => browser.tabs.sendMessage(tab.id, msg);
        const inspect = async code => (await browser.tabs.executeScript(tab.id, {code}))[0];
        check((await send({type:'status'})).translated === 0, 'translated automatically');
        await inspect('window.testClicks = 0; document.querySelector("#link").addEventListener("click", e => {e.preventDefault();window.testClicks++})');
        await send({type:'start',source:'en',target:'ja'});
        const preview = await browser.tabs.create({url:browser.runtime.getURL('popup.html')+'?previewTab='+tab.id,active:true});
        await wait(250);
        await fetch(base + '/screenshot', {method:'POST',body:JSON.stringify({name:'popup',image:await browser.tabs.captureTab(preview.id,{format:'png'})})});
        await browser.tabs.remove(preview.id);
        await browser.tabs.update(tab.id,{active:true});
        let state;
        for (let i=0; i<300; i++) { state = await send({type:'status'}); if (!state.running) break; await wait(100); }
        check(state.done === state.total && state.failed === 0 && state.translated > 0, JSON.stringify(state));
        check(state.percent === 100, 'progress did not reach 100%');
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
        const order = await inspect('({first:document.querySelector("#inline-sentence a").id,last:document.querySelectorAll("#inline-sentence a")[1].id,note:document.querySelector(".sr-only").textContent})');
        check(order.first === 'assembly' && order.last === 'posts' && order.note === '(opens in a new window)', 'link order or screen-reader note changed incorrectly');
        check(data.injection.startsWith('<img') && data.images === 0 && !data.compromised, 'model HTML executed');
        await inspect('getSelection().removeAllRanges(); const hoverRange = document.createRange(); hoverRange.selectNodeContents(document.querySelector("h1").firstChild); const rect = hoverRange.getBoundingClientRect(); document.dispatchEvent(new PointerEvent("pointermove", {clientX:rect.left+10,clientY:rect.top+rect.height/2,pointerType:"mouse",bubbles:true}));');
        for (let i=0; i<30; i++) { if(await inspect('!!document.querySelector("[data-kotoba-ui]").shadowRoot.querySelector(".tooltip")')) break; await wait(100); }
        const hover = await inspect('({text:document.querySelector("[data-kotoba-ui]").shadowRoot.querySelector(".tooltip .original")?.textContent,collapsed:getSelection()?.isCollapsed,visibility:document.visibilityState,focus:document.hasFocus()})');
        check(hover.text === 'Translation example', 'original hover missing: '+JSON.stringify(hover));
        await fetch(base + '/screenshot', {method:'POST',body:JSON.stringify({name:'page',image:await browser.tabs.captureTab(tab.id,{format:'png'})})});
        await send({type:'restore'});
        check(await inspect('document.querySelector("#paragraph").textContent') === 'Read the documentation carefully.', 'restore failed');
        check(await inspect('document.querySelector("#inline-sentence a").id') === 'posts', 'original link order was not restored');
        await inspect('const r = document.createRange(); r.selectNodeContents(document.querySelector("#paragraph")); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);');
        await send({type:'selection',source:'en',target:'ja'});
        await wait(250);
        check(await inspect('!!document.querySelector("[data-kotoba-ui]")'), 'selection panel missing');
        await fetch(base + '/screenshot', {method:'POST',body:JSON.stringify({name:'selection',image:await browser.tabs.captureTab(tab.id,{format:'png'})})});
        const options = await browser.tabs.create({url:browser.runtime.getURL('options.html'),active:true});
        await wait(200);
        await fetch(base + '/screenshot', {method:'POST',body:JSON.stringify({name:'options',image:await browser.tabs.captureTab(options.id,{format:'png'})})});
        await browser.tabs.remove(options.id);
        await fetch(base + '/result', { method:'POST', body: JSON.stringify({ok:true,state,data}) });
      } catch(error) { await fetch(base + '/result', { method:'POST', body: JSON.stringify({ok:false,error:[error.message,error.stack].join(String.fromCharCode(10))}) }); }
    })();
  `);
  const child = spawn(process.execPath, [path.resolve("node_modules/web-ext/bin/web-ext.js"), "run", "--source-dir", source, "--firefox", process.env.FIREFOX || "/Applications/Firefox.app/Contents/MacOS/firefox", "--args=-headless", "--no-reload", "--no-input", "--no-config-discovery"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_UPDATE_NOTIFIER: "1" } });
  let logs = "";
  child.stdout.on("data", chunk => logs += chunk);
  child.stderr.on("data", chunk => logs += chunk);
  let timeout;
  try {
    const response = await Promise.race([result, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Firefox smoke timed out\n" + logs)), 45000); })]);
    assert.ok(response.ok, response.error);
    assert.equal(maximum, 1);
    assert.ok(requests.length > 5);
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
