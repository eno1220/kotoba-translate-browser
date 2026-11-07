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

test('batch controls save numeric tuning and independent switches, then restore saved values on discard', async t => {
  const e = await options(); t.after(() => e.w.close());
  assert.equal(e.field('maxBatchItems').value, '32');
  const edits = { maxBatchItems: 12, batchStartItems: 2, batchStartTokens: 800, batchGrowthFactor: 3, batchTargetSeconds: 6,
    readingOrder: false, progressiveBatching: false, batchRecovery: false, mergeSections: false, deduplicateRepetitions: false };
  for (const [key, value] of Object.entries(edits)) e.edit(key, value);
  await e.submit();
  for (const [key, value] of Object.entries(edits)) assert.equal(e.settings()[key], value);
  e.edit('maxBatchItems', 0); await e.submit(); assert.equal(e.writes(), 1);
  e.$('discard').click(); await e.flush(); assert.equal(e.field('maxBatchItems').value, '12');
});

test('invalid inputs reveal their collapsed settings sections', async t => {
  const e = await options(); t.after(() => e.w.close());
  const field = e.field('batchStartTokens');
  const sections = [];
  for (let node = field.parentElement; node; node = node.parentElement) {
    if (node.tagName === 'DETAILS') sections.push(node);
  }
  assert.equal(sections.length, 2);
  assert.ok(sections.every(section => !section.open));
  e.edit('batchStartTokens', 0);
  field.checkValidity();
  assert.ok(sections.every(section => section.open));
});


test('settings remove legacy default directions and save diagnostic retention in minutes', async t => {
  const e = await options({ source: 'de', target: 'fr' }); t.after(() => e.w.close());
  assert.equal(e.field('source'), null); assert.equal(e.field('target'), null);
  assert.equal(e.field('errorMinutes').value, '3600');
  e.edit('errorMinutes', 60); await e.submit();
  assert.equal(e.settings().errorMinutes, 60);
  assert.equal(e.settings().source, undefined); assert.equal(e.settings().target, undefined);
  e.edit('errorMinutes', 0); await e.submit();
  assert.equal(e.writes(), 1);
});

test('optional server check saves its custom health path and switch', async t => {
  const e = await options(); t.after(() => e.w.close());
  assert.equal(e.field('serverCheck').checked, false);
  e.edit('serverCheck', true); e.edit('healthPath', '/ready'); await e.submit();
  assert.equal(e.settings().serverCheck, true); assert.equal(e.settings().healthPath, '/ready');
});


test('cache capacity loads its default, saves MiB as an integer and validates bounds', async () => {
  const e = await options();
  assert.equal(e.field('cacheMiB').value, '8');
  e.edit('cacheMiB', '32'); await e.submit();
  assert.equal(e.settings().cacheMiB, 32);
  for (const value of ['0', '1025', '1.5']) {
    e.edit('cacheMiB', value); await e.submit();
    assert.equal(e.writes(), 1);
    assert.match(e.$('status').textContent, /cacheMiB/);
  }
  e.w.close();
});
