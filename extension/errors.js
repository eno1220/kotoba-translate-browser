/* global browser */
const $ = id => document.getElementById(id);
let entries = [], busy = false;
async function load(clear = false) {
  if (busy) return;
  busy = true;
  for (const id of ['refresh', 'clear', 'export']) $(id).disabled = true;
  try {
    if (clear) {
      const result = await browser.runtime.sendMessage({ type: 'clearErrors' });
      if (result.error) throw new Error(result.error);
    }
    const result = await browser.runtime.sendMessage({ type: 'errorHistory' });
    if (result.error) throw new Error(result.error);
    entries = result.entries;
    const fragment = document.createDocumentFragment();
    for (const entry of entries) {
      const details = document.createElement('details'), summary = document.createElement('summary');
      details.className = 'error-entry';
      summary.textContent = `${new Date(entry.timestamp).toLocaleString('ja-JP')} · ${entry.stage} · ${entry.error.message}`;
      const pre = document.createElement('pre'); pre.textContent = JSON.stringify(entry, null, 2);
      details.append(summary, pre); fragment.append(details);
    }
    $('entries').replaceChildren(fragment);
    $('status').textContent = entries.length ? `${entries.length}件` : 'エラー記録はありません。';
  } catch (error) { $('status').textContent = error.message; }
  finally {
    busy = false; $('refresh').disabled = false;
    $('clear').disabled = $('export').disabled = !entries.length;
  }
}
$('refresh').addEventListener('click', () => load());
$('clear').addEventListener('click', () => {
  if (confirm('保存したエラー記録をすべて削除しますか？')) load(true);
});
$('export').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify({ schemaVersion: 1, entries }, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'kotoba-errors.json';
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
load();
