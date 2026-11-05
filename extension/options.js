/* global browser, Kotoba */
const form = document.getElementById("settings");
const status = document.getElementById("status");
const displayNames = new Intl.DisplayNames(["ja"], { type: "language" });
for (const key of ["source", "target"]) {
  for (const code of [...(key === "source" ? ["auto"] : []), ...Kotoba.LANGUAGES]) {
    const option = document.createElement("option"); option.value = code;
    option.textContent = code === "auto" ? "自動判定" : displayNames.of(code);
    form.elements.namedItem(key).append(option);
  }
}
async function load() {
  const { settings } = await browser.storage.local.get("settings");
  for (const [key, value] of Object.entries({ ...Kotoba.DEFAULTS, ...settings })) {
    const field = form.elements.namedItem(key); if (field) field.value = value;
  }
}
form.addEventListener("submit", async event => {
  event.preventDefault();
  try {
    const { settings: saved = {} } = await browser.storage.local.get("settings");
    const settings = Kotoba.settings({ ...saved, ...Object.fromEntries(new FormData(form)) });
    await browser.storage.local.set({ settings });
    await browser.runtime.sendMessage({ type: "clearCache" });
    status.classList.remove("error"); status.textContent = "保存しました";
  } catch (error) { status.classList.add("error"); status.textContent = error.message; }
});
load().catch(error => { status.textContent = error.message; });
document.getElementById("clear-cache").addEventListener("click", async () => {
  try {
    const result = await browser.runtime.sendMessage({ type: "clearCache" });
    if (result.error) throw new Error(result.error);
    status.classList.remove("error"); status.textContent = "キャッシュを削除しました";
  } catch (error) { status.classList.add("error"); status.textContent = error.message; }
});
