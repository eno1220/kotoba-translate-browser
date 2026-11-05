const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { JSDOM } = require('jsdom');
async function options(initial = {}) {
  let settings = initial, writes = 0;
  const messages = [];
  const w = new JSDOM(readFileSync(require.resolve('../extension/options.html'), 'utf8'), { runScripts: 'outside-only' }).window;
  w.TextEncoder = TextEncoder;
  w.browser = {
    storage: { local: { get: async () => ({ settings: structuredClone(settings) }), set: async value => { settings = value.settings; writes++; } } },
    runtime: { sendMessage: async message => { messages.push(message); return { milliseconds: 123 }; } }
  };
  for (const file of ['core.js', 'options.js']) w.eval(readFileSync(require.resolve(`../extension/${file}`), 'utf8'));
  const flush = () => new Promise(setImmediate);
  await flush();
  const $ = id => w.document.getElementById(id), field = name => $('settings').elements.namedItem(name);
  const edit = (name, value) => {
    const node = field(name);
    if (node.type === 'checkbox') node.checked = value; else node.value = value;
    node.dispatchEvent(new w.Event('input', { bubbles: true }));
    node.dispatchEvent(new w.Event('change', { bubbles: true }));
  };
  const submit = async () => { $('settings').dispatchEvent(new w.Event('submit', { cancelable: true })); await flush(); };
  return { w, $, field, edit, flush, submit, messages, settings: () => settings, writes: () => writes, external: changes => settings = { ...settings, ...changes } };
}

test('settings save only edits, retain external changes and disabled tokenize paths, and discard unsaved values', async () => {
  const e = await options({ tokenizePath: '/custom-tokenize', dictionary: [], apiKey: 'secret' });
  assert.equal(e.$('save').disabled, true);
  assert.equal(e.field('tokenizePath').disabled, true);
  e.edit('retryTransient', true);
  assert.equal(e.$('save').disabled, false);
  const unload = new e.w.Event('beforeunload', { cancelable: true });
  e.w.dispatchEvent(unload); assert.equal(unload.defaultPrevented, true);
  e.external({ batchTranslation: false, dictionary: [{ domain: '', sourceLang: 'en', targetLang: 'ja', source: 'File', target: 'ファイル' }] });
  await e.submit();
  assert.equal(e.writes(), 1);
  assert.equal(e.settings().batchTranslation, false);
  assert.equal(e.settings().retryTransient, true);
  assert.equal(e.settings().dictionary.length, 1);
  assert.equal(e.settings().tokenizePath, '/custom-tokenize');
  assert.equal(e.$('save').disabled, true);
  e.edit('model', 'draft'); e.$('discard').click(); await e.flush();
  assert.equal(e.field('model').value, 'plamo-translate');
  e.edit('model', 'local'); e.external({ model: 'external' }); await e.submit();
  assert.equal(e.writes(), 1); assert.match(e.$('status').textContent, /別の画面/);
  e.w.close();
});

test('connection test uses unsaved inputs without saving; API key visibility and helper associations are accessible', async () => {
  const e = await options({ apiKey: 'secret' });
  e.edit('model', 'draft-model');
  e.$('test-connection').click(); await e.flush();
  assert.equal(e.messages[0].type, 'testConnection');
  assert.equal(e.messages[0].settings.model, 'draft-model');
  assert.equal(e.writes(), 0); assert.match(e.$('connection-status').textContent, /接続できました/);
  e.$('show-key').click(); assert.equal(e.field('apiKey').type, 'text');
  assert.equal(e.$('show-key').getAttribute('aria-pressed'), 'true');
  e.$('show-key').click(); assert.equal(e.field('apiKey').type, 'password');
  for (const name of ['retryTransient', 'responsiveScan', 'inputTokens']) {
    const help = e.field(name).getAttribute('aria-describedby');
    assert.ok(e.$(help)?.textContent);
  }
  e.w.close();
});
