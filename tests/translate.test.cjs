const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { JSDOM } = require('jsdom');
const read = file => readFileSync(require.resolve(`../extension/${file}`), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
function setup(t) {
  const dom = new JSDOM(read('translate.html'), { url: 'https://extension.test/translate.html', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const w = dom.window, calls = [], pending = [], copied = [];
  let listener;
  w.TextEncoder = TextEncoder;
  w.browser = {
    tabs: { getCurrent: async () => ({ id: 20 }) },
    runtime: { id: 'test', onMessage: { addListener: fn => listener = fn }, sendMessage: async message => {
      calls.push(message);
      if (message.type === 'translateText') return new Promise(resolve => pending.push(resolve));
      return {};
    } }
  };
  w.navigator.clipboard = { writeText: async text => copied.push(text) };
  w.eval(read('core.js')); w.eval(read('translate.js'));
  const get = id => w.document.getElementById(id);
  return { w, get, calls, pending, copied,
    input: text => { get('source-text').value = text; get('source-text').dispatchEvent(new w.Event('input')); },
    progress: data => listener({ type: 'translationProgress', requestId: calls.findLast(c => c.type === 'translateText').requestId, tabId: 20, ...data }, { id: 'test' })
  };
}
test('manual translation, scoped preview, completion, copy and reverse translation', async t => {
  const s = setup(t); await settle();
  assert.equal(s.get('translate').disabled, true);
  s.input('Hello.'); assert.equal(s.calls.length, 0);
  assert.equal(s.get('swap').disabled, true);
  s.get('source').value = 'en'; s.get('source').dispatchEvent(new s.w.Event('change'));
  s.get('translate').click(); await settle();
  assert.equal(s.calls[0].text, 'Hello.');
  assert.equal(s.get('source-text').readOnly, false);
  assert.equal(s.get('stop').hidden, false);
  s.progress({ tabId: 21, preview: '別のタブ' }); assert.equal(s.get('result-text').value, '');
  s.progress({ phase: 'receiving', preview: 'こん', completed: 2, total: 6 });
  assert.equal(s.get('result-text').value, 'こん'); assert.equal(s.get('copy').disabled, true);
  s.pending[0]({ parts: ['こんにちは。'] }); await settle();
  assert.equal(s.get('result-text').value, 'こんにちは。');
  assert.equal(s.get('result-text').lang, 'ja');
  assert.equal(s.get('result-text').getAttribute('aria-busy'), 'false');
  s.get('copy').click(); await settle(); assert.deepEqual(s.copied, ['こんにちは。']);
  s.get('swap').click();
  assert.equal(s.get('source-text').value, 'こんにちは。');
  assert.equal(s.get('source').value, 'ja'); assert.equal(s.get('target').value, 'en');
  assert.equal(s.get('result-text').value, '');
});
test('edits and stops cancel work and reject late progress, errors and results', async t => {
  const s = setup(t); await settle();
  s.input('First.'); s.get('translate').click(); await settle();
  const requestId = s.calls[0].requestId;
  s.input('Second.'); assert.equal(s.calls.at(-1).type, 'cancel');
  s.progress({ requestId, preview: '古い結果' });
  s.pending[0]({ parts: ['古い結果'] }); await settle();
  assert.equal(s.get('result-text').value, '');
  s.get('translate').click(); await settle();
  s.progress({ preview: '途中' });
  s.w.document.dispatchEvent(new s.w.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(s.calls.at(-1).type, 'cancel');
  assert.equal(s.get('result-text').value, '途中');
  assert.equal(s.get('copy').disabled, true);
  s.pending[1]({ error: '遅いエラー' }); await settle();
  assert.match(s.get('status').textContent, /停止/);
  s.get('clear').click(); assert.equal(s.get('source-text').value, '');
  assert.equal(s.w.document.activeElement, s.get('source-text'));
});
test('shortcut respects IME and errors leave input available for retry', async t => {
  const s = setup(t); await settle(); s.input('<script>Text</script>');
  const key = composing => new s.w.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: composing, cancelable: true });
  s.w.document.dispatchEvent(key(true)); assert.equal(s.calls.length, 0);
  s.w.document.dispatchEvent(key(false)); await settle();
  s.pending[0]({ error: '接続できません' }); await settle();
  assert.equal(s.get('source-text').value, '<script>Text</script>');
  assert.equal(s.get('translate').disabled, false);
  assert.equal(s.get('copy').disabled, true);
  assert.equal(s.get('status').classList.contains('error'), true);
});
