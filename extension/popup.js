/* global browser, Kotoba */
const $ = id => document.getElementById(id);
const names = new Intl.DisplayNames(["ja"], { type: "language" });
for (const id of ["source", "target"]) {
  for (const code of [...(id === "source" ? ["auto"] : []), ...Kotoba.LANGUAGES]) {
    const option = document.createElement("option"); option.value = code;
    option.textContent = code === "auto" ? "自動判定" : code === "ja(easy)" ? "やさしい日本語" : names.of(code);
    $(id).append(option);
  }
}
let tabId, timer, ready = false, polling = false, closed = false, revision = 0, lastState;
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
let serverAvailable = false, nextServerCheck = 0, checkingServer = false;
async function checkServer(force = false) {
  if (checkingServer || !force && Date.now() < nextServerCheck) return;
  checkingServer = true;
  const field = $("server-status");
  $("recheck-server").disabled = true;
  $("recheck-server").textContent = "確認中…";
  try {
    const result = await browser.runtime.sendMessage({ type: "serverStatus", force });
    if (result.error) throw new Error(result.error);
    serverAvailable = result.available;
    field.hidden = !result.enabled || serverAvailable;
    field.classList.toggle("error", !serverAvailable);
    field.textContent = serverAvailable ? "" : result.message;
    $("recheck-server").hidden = !result.enabled || serverAvailable;
    nextServerCheck = result.nextCheckAt || Date.now() + 60000;
  } catch (e) {
    serverAvailable = false; field.hidden = false; field.classList.add("error"); field.textContent = e.message;
    $("recheck-server").hidden = false;
    nextServerCheck = Date.now() + 30000;
  }
  checkingServer = false; $("recheck-server").disabled = false; $("recheck-server").textContent = "再確認";
  controls();
}
$("recheck-server").addEventListener("click", () => checkServer(true));
async function page(action) {
  const result = await browser.runtime.sendMessage({ type: "page", tabId, action, source: $("source").value, target: $("target").value, hoverEnabled: $("hover").checked });
  if (result.error) { const e = new Error(result.error); e.code = result.errorCode; throw e; }
  return result;
}
function render(state) {
  lastState = state;
  running = state.running;
  $("status").classList.remove("error");
  $("status").textContent = state.cacheRestored ? "保存した訳文を復元しました" : state.running || state.total && !state.failed && !state.skipped ? "" : state.message || "";
  $("progress-section").hidden = !state.total && !state.preparing;
  const percent = state.percent || 0;
  $("progress").value = percent; $("percent").textContent = `${percent}%`;
  if (state.preparing) { $("progress").removeAttribute("value"); $("percent").textContent = ""; }
  $("progress-label").textContent = state.preparing ? "ページを解析中" : state.running ? "翻訳中" : state.failed ? "一部未翻訳" : percent === 100 ? "翻訳完了" : "停止中";
  $("progress-pending").hidden = !state.running || state.preparing || !state.activePercent;
  $("progress-pending").style.left = `${percent}%`; $("progress-pending").style.width = `${state.activePercent || 0}%`;
  $("progress-activity").hidden = !state.running || state.preparing;
  $("work").textContent = `処理中 ${state.active || 0}段落 · 未着手 ${state.pending || 0}段落`;
  const phase = { preparing: "翻訳を準備中", queued: "順番待ち", tokenizing: "入力を計測中", translating: "応答待ち", retrying: "再試行まで待機", receiving: "訳文を受信中" }[state.phase] || "";
  $("phase").textContent = phase ? `${phase}${state.phase === "receiving" && state.receivedCharacters ? ` · ${state.receivedCharacters}文字` : ""} ${Math.floor((Date.now() - state.phaseStartedAt) / 1000)}秒` : "";
  $("counts").textContent = `${state.done} / ${state.total} 段落`;
  $("elapsed").textContent = state.startedAt ? `${Math.floor(((state.finishedAt || Date.now()) - state.startedAt) / 1000)}秒` : "";
  $("hover").checked = state.hoverEnabled !== false;
  $("start-label").textContent = state.running ? "翻訳を停止" : state.failed ? "未翻訳部分を再試行" : state.total && percent < 100 ? "翻訳を再開" : "ページを翻訳";
  $("start").classList.toggle("running", state.running);
  controls();
}
function controls() {
  $("start").disabled = !ready || busy || !running && !serverAvailable;
  $("selection").disabled = !ready || busy || !serverAvailable;
  $("restore").disabled = !ready || busy || !lastState?.translated && !running;
  $("source").disabled = !ready || busy || running; $("target").disabled = !ready || busy || running;
  $("swap").disabled = !ready || busy || running || $("source").value === "auto";
  $("hover").disabled = !ready || busy;
}
function scheduleRefresh() {
  clearTimeout(timer);
  if (ready && !closed && !document.hidden && !busy) timer = setTimeout(refresh, running ? 700 : 2500);
}
async function refresh() {
  if (polling || closed || document.hidden || busy || !ready) return;
  polling = true;
  const version = revision;
  try { const [state] = await Promise.all([page("status"), checkServer()]); if (version === revision) render(state); }
  catch (e) { if (version === revision) error(e); }
  finally { polling = false; scheduleRefresh(); }
}
async function perform(action) {
  if (!ready || busy) return;
  if (["start", "selection"].includes(action) && !serverAvailable) return;
  busy = true; revision++; clearTimeout(timer); controls();
  try {
    const state = await page(action);
    if (action === "selection") window.close(); else render(state);
  } catch (e) { error(e); }
  finally { busy = false; controls(); scheduleRefresh(); }
}
async function init() {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true }); tabId = tab.id;
    const prefs = await browser.runtime.sendMessage({ type: "preferences" });
    if (prefs.error) throw new Error(prefs.error);
    $("batch-translation").checked = prefs.batchTranslation;
    $("main-content-only").checked = prefs.mainContentOnly;
    if (!/^https?:\/\//.test(tab.url || "")) throw new Error("通常のWebページで開いてください。Firefoxの内部ページやPDFでは利用できません。");
    $("server-status").hidden = false; $("server-status").textContent = "APIサーバーを確認しています…";
    const [state] = await Promise.all([page("status"), checkServer(true)]);
    $("source").value = state.source; $("target").value = state.target;
    ready = true; render(state); scheduleRefresh();
  } catch (e) { error(e); controls(); }
}
for (const action of ["start", "restore", "selection"]) {
  $(action).addEventListener("click", () => perform(action === "start" && running ? "stop" : action));
}
for (const id of ["source", "target"]) $(id).addEventListener("change", () => perform("configure"));
$("options").addEventListener("click", () => browser.runtime.openOptionsPage());
$("history").addEventListener("click", async () => {
  try { await browser.tabs.create({ url: browser.runtime.getURL("history.html") }); window.close(); }
  catch (e) { error(e); }
});
$("swap").addEventListener("click", () => {
  [$("source").value, $("target").value] = [$("target").value, $("source").value];
  perform("configure");
});
$("hover").addEventListener("change", () => perform("hover"));
$("reload").addEventListener("click", async () => {
  try { await browser.tabs.reload(tabId); window.close(); } catch (e) { error(e); }
});
document.addEventListener("visibilitychange", () => {
  clearTimeout(timer);
  if (!document.hidden) refresh();
});
addEventListener("unload", () => { closed = true; clearTimeout(timer); });
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

$("dictionary").addEventListener("click", async () => {
  try {
    const tab = tabId ? await browser.tabs.get(tabId) : null;
    const domain = /^https?:\/\//.test(tab?.url || "") ? new URL(tab.url).hostname : "";
    await browser.tabs.create({ url: browser.runtime.getURL("dictionary.html") + (domain ? `?domain=${encodeURIComponent(domain)}` : "") });
    window.close();
  } catch (e) { error(e); }
});
