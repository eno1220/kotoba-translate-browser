const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { JSDOM } = require('jsdom');

test('history renders API metrics and unknown speeds, links to cached pages, and clears the live list', async () => {
  const w = new JSDOM(readFileSync(require.resolve('../extension/history.html'), 'utf8'), { runScripts: 'outside-only' }).window;
  const row = { url: 'https://example.org/article?q=1', source: 'en', target: 'ja', startedAt: Date.now(), milliseconds: 1500, paragraphs: 12, characters: 1234, requests: 3, outputTokens: 100, tokensPerSecond: 50 };
  let data = { rows: [row, { ...row, url: 'https://unknown.example/', outputTokens: null, tokensPerSecond: null }], bytes: 100, maxBytes: 8388608 };
  w.browser = { runtime: { sendMessage: async message => {
    if (message.type === 'clearCache') { data = { ...data, rows: [], bytes: 0 }; return {}; }
    assert.equal(message.type, 'cacheHistory'); return data;
  } } };
  w.eval(readFileSync(require.resolve('../extension/history.js'), 'utf8'));
  const flush = () => new Promise(setImmediate); await flush();
  const $ = id => w.document.getElementById(id), rows = $('entries').querySelectorAll('tr');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].querySelector('a').href, row.url);
  assert.equal(rows[0].children[7].textContent, '50.0');
  assert.equal(rows[1].children[7].textContent, '—');
  assert.equal($('results').hidden, false);
  $('clear-cache').click(); await flush();
  assert.equal($('empty').hidden, false);
  assert.equal($('results').hidden, true);
  assert.equal($('clear-cache').disabled, true);
  w.close();
});
