/* global browser, Kotoba */
const $ = id => document.getElementById(id);
const names = new Intl.DisplayNames(["ja"], { type: "language" });
for (const id of ["source", "target"]) {
  for (const code of [...(id === "source" ? ["auto"] : []), ...Kotoba.LANGUAGES]) {
    const option = document.createElement("option"); option.value = code;
    option.textContent = code === "auto" ? "自動判定" : names.of(code);
    $(id).append(option);
  }
}
let tabId, timer, ready = false;
function error(value) {
  $("status").textContent = value.message || String(value); $("status").classList.add("error");
  const stale = value.code === "stale_content";
  $("reload").hidden = !stale;
  if (stale) {
    ready = false; $("progress-section").hidden = true;
    for (const id of ["start", "selection", "restore"]) $(id).disabled = true;
  }
}
let running = false, busy = false;
async function page(action) {
  const result = await browser.runtime.sendMessage({ type: "page", tabId, action, source: $("source").value, target: $("target").value, hoverEnabled: $("hover").checked });
  if (result.error) { const e = new Error(result.error); e.code = result.errorCode; throw e; }
  return result;
}
function render(state) {
  running = state.running;
  $("status").classList.remove("error");
  $("status").textContent = state.cacheRestored ? "保存した訳文を復元しました" : state.running || state.total && !state.failed ? "" : state.message || "";
  $("progress-section").hidden = !state.total && !state.preparing;
  const percent = state.percent || 0;
  $("progress").value = percent; $("percent").textContent = `${percent}%`;
  if (state.preparing) { $("progress").removeAttribute("value"); $("percent").textContent = ""; }
  $("progress-label").textContent = state.preparing ? "ページを解析中" : state.running ? "翻訳中" : state.failed ? "一部未翻訳" : percent === 100 ? "翻訳完了" : "停止中";
  $("counts").textContent = `${state.done} / ${state.total} 段落`;
  $("elapsed").textContent = state.startedAt ? `${Math.floor(((state.finishedAt || Date.now()) - state.startedAt) / 1000)}秒` : "";
  $("hover").checked = state.hoverEnabled !== false;
  $("start").textContent = state.running ? "翻訳を停止" : state.failed ? "未翻訳部分を再試行" : state.total && percent < 100 ? "翻訳を再開" : "ページを翻訳";
  $("start").disabled = !ready || busy;
  $("selection").disabled = !ready || busy;
  $("restore").disabled = busy || !state.translated && !state.running;
  $("source").disabled = state.running; $("target").disabled = state.running;
  $("swap").disabled = state.running || $("source").value === "auto";
}
async function refresh() {
  try { const state = await page("status"); render(state); } catch (e) { error(e); }
}
async function init() {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true }); tabId = tab.id;
    const prefs = await browser.runtime.sendMessage({ type: "preferences" });
    if (prefs.error) throw new Error(prefs.error);
    $("batch-translation").checked = prefs.batchTranslation;
    $("main-content-only").checked = prefs.mainContentOnly;
    $("source").value = prefs.source; $("target").value = prefs.target;
    if (!/^https?:\/\//.test(tab.url || "")) throw new Error("通常のWebページで開いてください。Firefoxの内部ページやPDFでは利用できません。");
    const state = await page("status");
    $("source").value = state.source || prefs.source; $("target").value = state.target || prefs.target;
    ready = true; render(state); timer = setInterval(refresh, 700);
  } catch (e) { error(e); }
}
for (const action of ["start", "restore", "selection"]) {
  $(action).addEventListener("click", async () => {
    try {
      busy = true; $(action).disabled = true;
      await page(action === "start" && running ? "stop" : action);
      busy = false;
      if (action === "selection") window.close(); else await refresh();
    } catch (e) { busy = false; error(e); $(action).disabled = !ready; }
  });
}
for (const id of ["source", "target"]) $(id).addEventListener("change", async () => {
  try { await page("configure"); await refresh(); } catch (e) { error(e); }
});
$("options").addEventListener("click", () => browser.runtime.openOptionsPage());
$("swap").addEventListener("click", async () => {
  [$("source").value, $("target").value] = [$("target").value, $("source").value];
  try { await page("configure"); await refresh(); } catch (e) { error(e); }
});
$("hover").addEventListener("change", async () => {
  try { await page("hover"); } catch (e) { error(e); }
});
$("reload").addEventListener("click", async () => {
  try { await browser.tabs.reload(tabId); window.close(); } catch (e) { error(e); }
});
addEventListener("unload", () => clearInterval(timer));
init();

for (const [id, key] of [["batch-translation", "batchTranslation"], ["main-content-only", "mainContentOnly"]]) $(id).addEventListener("change", async () => {
  const field = $(id);
  field.disabled = true;
  try {
    const { settings = {} } = await browser.storage.local.get("settings");
    await browser.storage.local.set({ settings: { ...settings, [key]: field.checked } });
  } catch (e) { field.checked = !field.checked; error(e); }
  finally { field.disabled = false; }
});
