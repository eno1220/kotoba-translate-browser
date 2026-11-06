/* global browser, Kotoba */
const $ = id => document.getElementById(id);
const names = new Intl.DisplayNames(["ja"], { type: "language" });
let entries = [], saved = [], scopes = new Set(), loaded = false, saving = false;
let savedVersion = "[]";
const L = Kotoba.DICTIONARY_LIMITS;
function report(message, error = false) { $("status").textContent = message; $("status").classList.toggle("error", error); }
function dirty() { return JSON.stringify(entries) !== JSON.stringify(saved); }
function update() {
  const count = entries.filter(e => e.domain === $("scope").value).length;
  $("count").textContent = `この範囲 ${count} / ${L.perScope}件 · 合計 ${entries.length} / ${L.entries}件`;
  $("empty").hidden = count > 0 || !loaded;
  $("remove-scope").disabled = !loaded || saving || count === 0 && !$("scope").value;
  $("save").disabled = !loaded || saving || !dirty();
  $("add-entry").disabled = !loaded || count >= L.perScope || entries.length >= L.entries || saving;
  $("discard").disabled = !loaded || saving || !dirty() && scopes.size === new Set(saved.map(e => e.domain).filter(Boolean)).size;
}
function scopeOptions(selected = $("scope").value) {
  $("scope").replaceChildren(new Option("全体共通", ""));
  for (const domain of scopes) $("scope").append(new Option(domain, domain));
  $("scope").value = scopes.has(selected) ? selected : "";
}
function languageSelect(value, source, change) {
  const select = document.createElement("select");
  select.setAttribute("aria-label", source ? "原文言語" : "訳文言語");
  for (const code of [...(source ? ["auto"] : []), ...Kotoba.LANGUAGES]) select.append(new Option(code === "auto" ? "すべて" : code === "ja(easy)" ? "やさしい日本語" : names.of(code), code));
  select.value = value;
  select.addEventListener("change", () => { change(select.value); report("未保存の変更があります"); update(); });
  return select;
}
function render() {
  $("entries").replaceChildren();
  for (const entry of entries.filter(e => e.domain === $("scope").value)) {
    const row = document.createElement("fieldset"); row.className = "dictionary-entry";
    const legend = document.createElement("legend"); legend.textContent = `用語 ${$("entries").children.length + 1}`; row.append(legend);
    const langs = document.createElement("div"); langs.className = "row";
    for (const [key, text] of [["sourceLang", "原文言語"], ["targetLang", "訳文言語"]]) {
      const label = document.createElement("label"); label.textContent = text;
      label.append(languageSelect(entry[key], key === "sourceLang", value => entry[key] = value)); langs.append(label);
    }
    row.append(langs);
    const terms = document.createElement("div"); terms.className = "row";
    for (const [key, text] of [["source", "原語"], ["target", "訳語"]]) {
      const label = document.createElement("label"); label.textContent = text;
      const input = document.createElement("input"); input.value = entry[key]; input.required = true; input.maxLength = L.term;
      input.addEventListener("input", () => { entry[key] = input.value; report("未保存の変更があります"); update(); });
      label.append(input); terms.append(label);
    }
    row.insertBefore(terms, langs);
    const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "この用語を削除";
    remove.addEventListener("click", () => { entries.splice(entries.indexOf(entry), 1); render(); report("削除は保存後に反映します"); }); row.append(remove);
    $("entries").append(row);
  }
  update();
}
$("scope").addEventListener("change", render);
$("add-domain").addEventListener("click", () => {
  try {
    if (!$("domain").value.trim()) throw new Error("ドメインを入力してください。");
    const domain = Kotoba.dictionaryDomain($("domain").value);
    if (!scopes.has(domain) && scopes.size >= L.domains) throw new Error(`ドメインは${L.domains}件までです。`);
    scopes.add(domain); scopeOptions(domain); $("domain").value = ""; render();
  } catch (error) { report(error.message, true); }
});
$("add-entry").addEventListener("click", () => {
  entries.push({ domain: $("scope").value, sourceLang: "en", targetLang: "ja", source: "", target: "" });
  render(); $("entries").lastElementChild.querySelector("input").focus(); report("未保存の変更があります");
});
$("remove-scope").addEventListener("click", () => {
  entries = entries.filter(e => e.domain !== $("scope").value);
  scopes.delete($("scope").value); scopeOptions(); render(); report("全件削除は保存後に反映します。変更を破棄すると元に戻せます");
});
$("discard").addEventListener("click", () => {
  entries = structuredClone(saved); scopes = new Set(saved.map(e => e.domain).filter(Boolean)); scopeOptions(); render(); report("未保存の変更を破棄しました");
});
$("dictionary-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!loaded || saving) return;
  try {
    const dictionary = Kotoba.dictionary(entries);
    saving = true; $("save").disabled = true; $("dictionary-form").inert = true;
    const { settings = {} } = await browser.storage.local.get("settings");
    if (JSON.stringify(settings.dictionary || []) !== savedVersion) throw new Error("別の画面で辞書が更新されています。この画面を再読み込みしてから編集してください。");
    await browser.storage.local.set({ settings: { ...settings, dictionary } });
    saved = structuredClone(dictionary); entries = structuredClone(saved); savedVersion = JSON.stringify(saved);
    scopes = new Set(saved.map(e => e.domain).filter(Boolean)); scopeOptions(); render(); report("保存しました。表示中の訳文を更新する場合は原文に戻して再翻訳してください");
  } catch (error) { report(error.message, true); }
  finally { $("dictionary-form").inert = false; saving = false; $("save").disabled = false; update(); }
});
addEventListener("beforeunload", event => { if (dirty()) { event.preventDefault(); event.returnValue = ""; } });
async function load() {
  $("save").disabled = true;
  const { settings = {} } = await browser.storage.local.get("settings");
  savedVersion = JSON.stringify(settings.dictionary || []);
  saved = Kotoba.dictionary(settings.dictionary); entries = structuredClone(saved);
  scopes = new Set(saved.map(e => e.domain).filter(Boolean));
  const domain = new URL(location.href).searchParams.get("domain");
  if (domain) {
    const normalized = Kotoba.dictionaryDomain(domain);
    if (scopes.has(normalized) || scopes.size < L.domains) scopes.add(normalized);
    scopeOptions(normalized);
  } else scopeOptions();
  loaded = true; $("dictionary-form").inert = false; $("dictionary-form").setAttribute("aria-busy", "false"); render(); report("");
}
load().catch(error => report(error.message, true));
