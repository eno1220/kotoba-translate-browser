/* global browser, Kotoba */
const $ = id => document.getElementById(id);
const names = new Intl.DisplayNames(['ja'], { type: 'language' });
const number = new Intl.NumberFormat('ja-JP');
for (const id of ['source', 'target']) {
  for (const code of [...(id === 'source' ? ['auto'] : []), ...Kotoba.LANGUAGES]) {
    const option = document.createElement('option');
    option.value = code;
    option.textContent = code === 'auto' ? '自動判定' : code === 'ja(easy)' ? 'やさしい日本語' : names.of(code);
    $(id).append(option);
  }
}
$('source').value = 'auto'; $('target').value = 'ja';
if (/Mac|iPhone|iPad/.test(navigator.platform)) $('shortcut').textContent = '⌘ + Enter で翻訳';
let activeRequest = null, complete = false, tabId;
const phases = { preparing: '翻訳を準備中…', queued: '順番待ち…', tokenizing: '入力を計測中…', translating: '翻訳中…', retrying: '再試行まで待機中…', receiving: '訳文を受信中…' };
function status(text = '', error = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', error);
}
function controls() {
  const hasText = !!$('source-text').value.trim();
  $('translate').disabled = !!activeRequest || !hasText || tabId === undefined;
  $('stop').hidden = !activeRequest;
  $('clear').disabled = !$('source-text').value;
  $('copy').disabled = !complete;
  $('swap').disabled = !!activeRequest || $('source').value === 'auto';
  $('result-text').setAttribute('aria-busy', String(!!activeRequest));
  $('input-count').textContent = `${number.format($('source-text').value.length)}文字`;
  $('result-count').textContent = complete ? `${number.format($('result-text').value.length)}文字` : '';
}
function cancel() {
  if (!activeRequest) return;
  activeRequest = null;
  browser.runtime.sendMessage({ type: 'cancel' }).catch(() => {});
  $('progress').hidden = true;
}
function invalidate() {
  cancel(); complete = false;
  $('result-text').value = ''; $('result-text').lang = $('target').value.split('(')[0];
  $('source-text').lang = $('source').value === 'auto' ? '' : $('source').value.split('(')[0];
  status(); controls();
}
async function translate() {
  if ($('translate').disabled) return;
  const requestId = crypto.randomUUID();
  activeRequest = requestId; complete = false;
  $('result-text').value = ''; $('progress').hidden = false; $('progress').removeAttribute('value');
  status(phases.preparing); controls();
  try {
    const result = await browser.runtime.sendMessage({ type: 'translateText', requestId, text: $('source-text').value, source: $('source').value, target: $('target').value });
    if (activeRequest !== requestId) return;
    if (result.error) throw new Error(result.error);
    if (typeof result.parts?.[0] !== 'string') throw new Error('翻訳結果を取得できませんでした。');
    $('result-text').value = result.parts[0]; complete = true;
    status('翻訳しました');
  } catch (error) {
    if (activeRequest !== requestId) return;
    $('result-text').value = ''; status(error.message, true);
  } finally {
    if (activeRequest === requestId) {
      activeRequest = null; $('progress').hidden = true; controls();
    }
  }
}
browser.runtime.onMessage.addListener((message, sender) => {
  if (sender.id !== browser.runtime.id || message.type !== 'translationProgress' || message.tabId !== tabId || message.requestId !== activeRequest) return;
  if (typeof message.preview === 'string') $('result-text').value = message.preview;
  if (message.completed > 0 && message.total > 0) $('progress').value = Math.min(100, message.completed / message.total * 100);
  const text = phases[message.phase] || phases.translating;
  if ($('status').textContent !== text) status(text);
});
$('translation-form').addEventListener('submit', event => { event.preventDefault(); translate(); });
$('source-text').addEventListener('input', invalidate);
for (const id of ['source', 'target']) $(id).addEventListener('change', invalidate);
$('stop').addEventListener('click', () => { cancel(); status('停止しました。訳文は未完了です。'); controls(); });
$('clear').addEventListener('click', () => { $('source-text').value = ''; invalidate(); $('source-text').focus(); });
$('swap').addEventListener('click', () => {
  const text = complete ? $('result-text').value : $('source-text').value;
  [$('source').value, $('target').value] = [$('target').value, $('source').value];
  $('source-text').value = text; invalidate(); $('source-text').focus();
});
$('copy').addEventListener('click', async () => {
  if (!complete) return;
  const text = $('result-text').value;
  try {
    await navigator.clipboard.writeText(text);
    if (complete && $('result-text').value === text) status('訳文をコピーしました');
  } catch {
    if (!complete || $('result-text').value !== text) return;
    status('コピーできませんでした。訳文を選択してコピーしてください。', true); $('result-text').focus(); $('result-text').select();
  }
});
document.addEventListener('keydown', event => {
  if (event.isComposing) return;
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); translate(); }
  if (event.key === 'Escape' && activeRequest) { event.preventDefault(); $('stop').click(); }
});
addEventListener('pagehide', cancel);
async function init() {
  try {
    const tab = await browser.tabs.getCurrent(); tabId = tab.id; invalidate();
  } catch { status('翻訳ページを開き直してください。', true); }
}
init();
