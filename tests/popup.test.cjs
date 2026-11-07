const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { JSDOM } = require("jsdom");
const read = file => readFileSync(require.resolve(`../extension/${file}`), "utf8");
const settle = () => new Promise(resolve => setImmediate(resolve));

function setup(t) {
  const dom = new JSDOM(read("popup.html"), { url: "https://extension.test/popup.html", runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const w = dom.window, calls = [], timers = new Map();
  w.TextEncoder = TextEncoder;
  let nextTimer = 0, hidden = false, responder = () => state;
  let server = { enabled: false, available: true }, serverChecks = 0, now = Date.now();
  w.Date.now = () => now;
  const state = { running: false, done: 0, total: 0, source: "en", target: "ja", percent: 0, translated: 0 };
  Object.defineProperty(w.document, "hidden", { get: () => hidden });
  w.setTimeout = (fn, delay) => { timers.set(++nextTimer, { fn, delay }); return nextTimer; };
  w.clearTimeout = id => timers.delete(id);
  w.browser = {
    tabs: { query: async () => [{ id: 1, url: "https://example.org/article" }] },
    runtime: { sendMessage: async message => {
      if (message.type === "preferences") return { source: "en", target: "ja", batchTranslation: true };
      if (message.type === "serverStatus") { serverChecks++; return typeof server === 'function' ? server() : server; }
      calls.push(message.action); return responder(message);
    } }
  };
  w.eval(read("core.js")); w.eval(read("popup.js"));
  return { w, calls, timers, state,
    server: value => server = value, serverChecks: () => serverChecks, advance: ms => now += ms,
    respond: fn => responder = fn,
    visibility: value => { hidden = value; w.document.dispatchEvent(new w.Event("visibilitychange")); },
    tick: () => { const [id, timer] = timers.entries().next().value; timers.delete(id); timer.fn(); },
    get: id => w.document.getElementById(id)
  };
}

test("popup polls serially, slows while idle and pauses while hidden", async t => {
  const s = setup(t); await settle();
  assert.equal([...s.timers.values()][0].delay, 2500);
  let finish;
  s.respond(() => new Promise(resolve => finish = resolve));
  s.tick(); await settle();
  s.w.refresh(); await settle();
  assert.equal(s.calls.length, 2); // Initial status and one in-flight poll.
  assert.equal(s.timers.size, 0);
  finish({ ...s.state, running: true }); await settle();
  assert.equal([...s.timers.values()][0].delay, 700);
  assert.equal(s.get("start-label").textContent, "翻訳を停止");
  s.visibility(true); assert.equal(s.timers.size, 0);
  s.respond(() => ({ ...s.state, running: true }));
  s.visibility(false); await settle();
  assert.equal(s.calls.length, 3);
  assert.equal([...s.timers.values()][0].delay, 700);
});

test("a delayed status cannot overwrite a manual action or unlock other actions early", async t => {
  const s = setup(t); await settle();
  let finishPoll, finishStart;
  s.respond(message => new Promise(resolve => {
    if (message.action === "status") finishPoll = resolve; else finishStart = resolve;
  }));
  s.tick(); await settle();
  s.get("start").click(); await settle();
  assert.equal(s.get("selection").disabled, true);
  assert.equal(s.get("source").disabled, true);
  finishStart({ ...s.state, running: true, total: 4 }); await settle();
  finishPoll(s.state); await settle();
  assert.equal(s.get("start-label").textContent, "翻訳を停止");
  assert.equal(s.get("start").disabled, false);
  assert.equal(s.get("source").disabled, true);
  assert.equal([...s.timers.values()][0].delay, 700);
  s.respond(() => ({ ...s.state, total: 4, done: 2, percent: 50, translated: 2 }));
  s.get("start").click(); await settle();
  assert.equal(s.calls.at(-1), "stop");
  assert.equal(s.get("restore").disabled, false);
  assert.equal(s.get("source").disabled, false);
});

test('server availability disables starts, recovers on refresh and never disables stop or restore', async t => {
  const s = setup(t);
  let finish;
  s.server(() => new Promise(resolve => finish = resolve));
  await settle();
  assert.equal(s.get('start').disabled, true);
  assert.equal(s.get('selection').disabled, true);
  finish({ enabled: true, available: false, message: 'APIサーバーに接続できません' }); await settle();
  assert.equal(s.get('start').disabled, true);
  assert.match(s.get('server-status').textContent, /接続できません/);
  assert.equal(s.get('server-status').hidden, false);
  s.state.translated = 2;
  s.tick(); await settle();
  assert.equal(s.get('restore').disabled, false);
  s.advance(60000); s.server({ enabled: true, available: true });
  s.tick(); await settle();
  assert.equal(s.get('start').disabled, false);
  assert.equal(s.get('selection').disabled, false);
  assert.equal(s.get('server-status').hidden, true);
  assert.equal(s.get('server-status').textContent, '');
  s.state.running = true; s.advance(60000);
  s.server({ enabled: true, available: false, message: 'offline' });
  s.tick(); await settle();
  assert.equal(s.get('start').disabled, false);
  assert.equal(s.get('start-label').textContent, '翻訳を停止');
  s.respond(message => message.action === 'stop' ? { ...s.state, running: false } : s.state);
  s.get('start').click(); await settle();
  assert.equal(s.calls.at(-1), 'stop');
  assert.equal(s.get('start').disabled, true);
});

test('offline popup follows the server deadline and lets the user explicitly recheck', async t => {
  const s = setup(t);
  s.server({ enabled: true, available: false, message: 'サーバーを起動してください', nextCheckAt: s.w.Date.now() + 300000 });
  await settle();
  assert.equal(s.get('recheck-server').hidden, false);
  const count = s.serverChecks();
  for (let i = 0; i < 6; i++) {
    s.advance(5000); s.tick(); await settle();
  }
  assert.equal(s.serverChecks(), count);
  let finish;
  s.server(() => new Promise(resolve => finish = resolve));
  s.get('recheck-server').click(); await settle();
  assert.equal(s.get('recheck-server').disabled, true);
  finish({ enabled: true, available: true, nextCheckAt: s.w.Date.now() + 60000 }); await settle();
  assert.equal(s.serverChecks(), count + 1);
  assert.equal(s.get('recheck-server').hidden, true);
  assert.equal(s.get('server-status').hidden, true);
  assert.equal(s.get('start').disabled, false);
});
