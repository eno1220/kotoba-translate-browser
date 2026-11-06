const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { JSDOM } = require('jsdom');

test('error viewer renders untrusted content as text, exports JSON and clears only diagnostics', async () => {
  const w = new JSDOM(readFileSync(require.resolve('../extension/errors.html'), 'utf8'), { runScripts: 'outside-only' }).window;
  const entry = { timestamp: Date.now(), stage: 'paragraph-structure', error: { message: '<img src=x onerror=alert(1)>' }, original: '<a>original</a>' };
  let entries = [entry], downloaded;
  const messages = [];
  w.browser = { runtime: { sendMessage: async message => {
    messages.push(message.type);
    if (message.type === 'clearErrors') { entries = []; return {}; }
    assert.equal(message.type, 'errorHistory'); return { entries };
  } } };
  w.confirm = () => true;
  w.URL.createObjectURL = blob => { downloaded = blob; return 'blob:test'; };
  w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function () { assert.equal(this.download, 'kotoba-errors.json'); };
  w.eval(readFileSync(require.resolve('../extension/errors.js'), 'utf8'));
  const flush = () => new Promise(setImmediate); await flush();
  const $ = id => w.document.getElementById(id);
  assert.equal($('entries').querySelectorAll('details').length, 1);
  assert.equal($('entries').querySelector('img'), null);
  assert.deepEqual(JSON.parse($('entries').querySelector('pre').textContent), entry);
  $('export').click(); assert.ok(downloaded instanceof w.Blob);
  $('clear').click(); await flush();
  assert.equal($('entries').children.length, 0);
  assert.equal($('export').disabled, true);
  assert.deepEqual(messages, ['errorHistory', 'clearErrors', 'errorHistory']);
  w.close();
});
