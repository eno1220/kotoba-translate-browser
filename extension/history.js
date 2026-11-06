/* global browser */
const $ = id => document.getElementById(id);
const number = new Intl.NumberFormat('ja-JP');
const names = new Intl.DisplayNames(['ja'], { type: 'language' });
const date = new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const headers = [...document.querySelectorAll('thead th')].map(node => node.textContent);
let busy = false, version;
function cell(row, index, value) {
  const node = document.createElement('td'); node.dataset.label = headers[index];
  if (typeof value === 'string') node.textContent = value; else node.append(value);
  row.append(node); return node;
}
function render(data) {
  const next = JSON.stringify(data);
  if (version === next) return;
  version = next;
  const totals = data.totals;
  const stats = document.createDocumentFragment();
  for (const [label, value] of [
    ['翻訳回数', `${number.format(totals.pages)}回`],
    ['残存段落', number.format(totals.paragraphs)],
    ['原文文字数', number.format(totals.characters)],
    ['累計処理時間', `${(totals.milliseconds / 1000).toFixed(1)}秒`],
    ['API応答数', number.format(totals.requests)],
    ['出力トークン', totals.outputTokens == null ? '—' : number.format(totals.outputTokens)],
    ['API tok/s', totals.tokensPerSecond == null ? '—' : totals.tokensPerSecond.toFixed(1)],
    ['生成 tok/s', totals.generationTokensPerSecond == null ? '—' : totals.generationTokensPerSecond.toFixed(1)],
    ['平均初回受信', totals.firstTokenMilliseconds == null ? '—' : `${(totals.firstTokenMilliseconds / 1000).toFixed(2)}秒`]
  ]) {
    const item = document.createElement('div'), name = document.createElement('dt'), valueNode = document.createElement('dd');
    name.textContent = label; valueNode.textContent = value; item.append(name, valueNode); stats.append(item);
  }
  $('totals').replaceChildren(stats);
  const focusedURL = document.activeElement?.closest('#entries a')?.href;
  const fragment = document.createDocumentFragment();
  for (const entry of data.rows) {
    const row = document.createElement('tr');
    const time = document.createElement('time'); time.dateTime = new Date(entry.startedAt).toISOString(); time.textContent = date.format(entry.startedAt);
    cell(row, 0, time);
    const site = document.createElement('div'), url = new URL(entry.url);
    const link = document.createElement('a'); link.textContent = url.hostname; link.title = url.href;
    if (/^https?:$/.test(url.protocol)) { link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; }
    const languages = document.createElement('small'); languages.textContent = `${entry.source === 'auto' ? '自動判定' : names.of(entry.source)} → ${names.of(entry.target)}`;
    site.append(link, languages); cell(row, 1, site);
    cell(row, 2, number.format(entry.paragraphs)); cell(row, 3, number.format(entry.characters));
    cell(row, 4, `${(entry.milliseconds / 1000).toFixed(1)}秒`);
    const requests = cell(row, 5, number.format(entry.requests));
    if (entry.sharedRequests) {
      const shared = document.createElement('small'); shared.textContent = `うち共有 ${entry.sharedRequests}回`; requests.append(shared);
    }
    if (entry.batchFallbacks || entry.structureRetries || entry.truncations) {
      const retry = document.createElement('details'), summary = document.createElement('summary'); summary.textContent = '再処理'; retry.append(summary);
      for (const [label, count] of [['バッチ', entry.batchFallbacks], ['構造', entry.structureRetries], ['再分割', entry.truncations]]) {
        const text = document.createElement('small'); text.textContent = `${label} ${count || 0}回`; retry.append(text);
      }
      requests.append(retry);
    }
    cell(row, 6, entry.outputTokens === null ? '—' : number.format(entry.outputTokens));
    cell(row, 7, entry.tokensPerSecond === null ? '—' : entry.tokensPerSecond.toFixed(1));
    const speed = cell(row, 8, entry.generationTokensPerSecond == null ? '—' : entry.generationTokensPerSecond.toFixed(1));
    if (entry.generationSpeedSource) {
      const label = document.createElement('small'); label.textContent = 'サーバー値'; speed.append(label);
    }
    cell(row, 9, entry.firstTokenMilliseconds == null ? '—' : `${(entry.firstTokenMilliseconds / 1000).toFixed(2)}秒`);
    fragment.append(row);
  }
  $('entries').replaceChildren(fragment);
  if (focusedURL) {
    const link = [...$('entries').querySelectorAll('a')].find(node => node.href === focusedURL);
    (link || $('refresh')).focus({ preventScroll: true });
  }
  $('empty').hidden = !!data.rows.length; $('results').hidden = !data.rows.length;
  $('clear-cache').disabled = !data.rows.length;
  $('summary').textContent = `${number.format(data.rows.length)}件 · キャッシュ ${(data.bytes / 1048576).toFixed(2)} / ${data.maxBytes / 1048576} MiB`;
}
async function refresh(manual = false) {
  if (busy) return;
  busy = true; $('refresh').disabled = true;
  try {
    const data = await browser.runtime.sendMessage({ type: 'cacheHistory' });
    if (data.error) throw new Error(data.error);
    render(data); $('status').classList.remove('error'); $('status').textContent = manual ? '更新しました' : '';
  } catch (error) { $('status').classList.add('error'); $('status').textContent = error.message; }
  finally { busy = false; $('refresh').disabled = false; }
}
$('refresh').addEventListener('click', () => refresh(true));
$('clear-cache').addEventListener('click', async () => {
  if (busy) return;
  busy = true; $('clear-cache').disabled = true; $('refresh').disabled = true;
  try {
    const result = await browser.runtime.sendMessage({ type: 'clearCache' });
    if (result.error) throw new Error(result.error);
    busy = false; await refresh(); $('status').textContent = 'キャッシュと履歴を削除しました';
  } catch (error) { $('status').classList.add('error'); $('status').textContent = error.message; $('clear-cache').disabled = false; }
  finally { busy = false; $('refresh').disabled = false; }
});
const timer = setInterval(() => { if (!document.hidden) refresh(); }, 5000);
addEventListener('unload', () => clearInterval(timer));
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
refresh();
