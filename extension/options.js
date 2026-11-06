/* global browser, Kotoba */
const form = document.getElementById("settings");
const status = document.getElementById("status");
const save = document.getElementById("save"), discard = document.getElementById("discard");
const displayNames = new Intl.DisplayNames(["ja"], { type: "language" });
let baseline, loaded = false, saving = false;
for (const key of ["source", "target"]) {
  for (const code of [...(key === "source" ? ["auto"] : []), ...Kotoba.LANGUAGES]) {
    const option = document.createElement("option"); option.value = code;
    option.textContent = code === "auto" ? "自動判定" : code === "ja(easy)" ? "やさしい日本語" : displayNames.of(code);
    form.elements.namedItem(key).append(option);
  }
}
// Read disabled fields too, so changing the tokenizer never loses its custom path.
function values() {
  return Object.fromEntries(Object.keys(Kotoba.DEFAULTS).flatMap(key => {
    const field = form.elements.namedItem(key);
    return field ? [[key, field.type === "checkbox" ? field.checked : field.value]] : [];
  }));
}
function changed() { return loaded && Object.entries(values()).some(([key, value]) => value !== baseline[key]); }
function update() {
  save.disabled = !loaded || saving || !changed(); discard.disabled = save.disabled;
  form.elements.namedItem("tokenizePath").disabled = form.elements.namedItem("tokenizer").value === "bytes";
}
function report(message, error = false) { status.textContent = message; status.classList.toggle("error", error); }
function display(settings) {
  for (const [key, value] of Object.entries({ ...Kotoba.DEFAULTS, ...settings })) {
    const field = form.elements.namedItem(key);
    if (field) { if (field.type === "checkbox") field.checked = value; else field.value = value; }
  }
  baseline = values(); loaded = true; update();
}
async function load() {
  const { settings } = await browser.storage.local.get("settings");
  display(settings); form.inert = false; form.setAttribute("aria-busy", "false"); report("");
}
form.addEventListener("input", () => { update(); report(changed() ? "未保存の変更があります" : ""); });
form.addEventListener("change", update);
form.addEventListener("submit", async event => {
  event.preventDefault();
  if (!loaded || saving || !changed()) return;
  saving = true; form.inert = true; form.setAttribute("aria-busy", "true"); update();
  try {
    const { settings: saved = {} } = await browser.storage.local.get("settings");
    const latest = { ...Kotoba.DEFAULTS, ...saved }, edits = {};
    for (const [key, value] of Object.entries(values())) if (value !== baseline[key]) {
      const current = typeof latest[key] === "boolean" ? latest[key] : String(latest[key]);
      if (current !== baseline[key] && current !== value) throw new Error("同じ設定が別の画面で更新されています。変更を破棄してから編集し直してください。");
      edits[key] = value;
    }
    const settings = Kotoba.settings({ ...latest, ...edits });
    await browser.storage.local.set({ settings });
    display(settings); report("保存しました");
  } catch (error) { report(error.message, true); }
  finally { saving = false; form.inert = false; form.setAttribute("aria-busy", "false"); update(); }
});
discard.addEventListener("click", () => load().then(() => report("未保存の変更を破棄しました")).catch(error => report(error.message, true)));
addEventListener("beforeunload", event => { if (changed()) { event.preventDefault(); event.returnValue = ""; } });
load().catch(error => report(error.message, true));
document.getElementById("show-key").addEventListener("click", event => {
  const key = form.elements.namedItem("apiKey"), visible = key.type === "password";
  key.type = visible ? "text" : "password";
  event.currentTarget.textContent = visible ? "隠す" : "表示";
  event.currentTarget.setAttribute("aria-label", visible ? "APIキーを隠す" : "APIキーを表示");
  event.currentTarget.setAttribute("aria-pressed", String(visible));
});
document.getElementById("test-connection").addEventListener("click", async event => {
  const button = event.currentTarget, result = document.getElementById("connection-status");
  button.disabled = true; result.classList.remove("error"); result.textContent = "接続を確認しています…";
  try {
    const settings = Kotoba.settings(values());
    const response = await browser.runtime.sendMessage({ type: "testConnection", settings });
    if (response.error) throw new Error(response.error);
    result.textContent = `接続できました（${(response.milliseconds / 1000).toFixed(1)}秒）`;
  } catch (error) { result.classList.add("error"); result.textContent = error.message; }
  finally { button.disabled = false; }
});
document.getElementById("clear-cache").addEventListener("click", async () => {
  try {
    const result = await browser.runtime.sendMessage({ type: "clearCache" });
    if (result.error) throw new Error(result.error);
    report("キャッシュと履歴を削除しました");
  } catch (error) { report(error.message, true); }
});
// Connect help text to controls without making the entire explanation their name.
for (const [index, help] of [...form.querySelectorAll("label > small,.switch-row + small")].entries()) {
  const field = help.parentElement.tagName === "LABEL" ? help.parentElement.querySelector("input,select") : help.previousElementSibling.querySelector("input");
  if (help.parentElement.tagName === "LABEL" && field) {
    field.setAttribute("aria-label", [...help.parentElement.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join("").trim());
  }
  help.id = `field-help-${index}`; field?.setAttribute("aria-describedby", help.id);
}

// Reveal invalid controls before Firefox tries to focus them.
form.addEventListener("invalid", event => {
  for (let parent = event.target.parentElement; parent && parent !== form; parent = parent.parentElement) {
    if (parent.tagName === "DETAILS") parent.open = true;
  }
}, true);
