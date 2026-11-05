const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { JSDOM } = require("jsdom");
const entry = { domain: "", sourceLang: "en", targetLang: "ja", source: "File", target: "ファイル" };
async function editor(dictionary = []) {
  let settings = { apiKey: "secret", dictionary }, writes = 0;
  const dom = new JSDOM(readFileSync(require.resolve("../extension/dictionary.html"), "utf8"), { runScripts: "outside-only", url: "https://extension.example/dictionary.html" });
  const w = dom.window;
  w.TextEncoder = TextEncoder; w.structuredClone = structuredClone;
  w.browser = { storage: { local: {
    get: async () => ({ settings: structuredClone(settings) }),
    set: async value => { settings = value.settings; writes++; }
  } } };
  for (const file of ["core.js", "dictionary.js"]) w.eval(readFileSync(require.resolve(`../extension/${file}`), "utf8"));
  const flush = () => new Promise(resolve => setImmediate(resolve));
  await flush();
  const $ = id => w.document.getElementById(id);
  const input = (element, value) => { element.value = value; element.dispatchEvent(new w.Event("input", { bubbles: true })); };
  const submit = async () => { $("dictionary-form").dispatchEvent(new w.Event("submit", { cancelable: true })); await flush(); };
  return { w, $, input, submit, settings: () => settings, writes: () => writes, external: dictionary => settings.dictionary = dictionary };
}

test("dictionary editor saves edits and additions, and discards edits and scope deletion", async () => {
  const e = await editor([entry, { ...entry, domain: "example.com", target: "専用" }]);
  e.input(e.$("entries").querySelectorAll("input")[1], "文書");
  e.$("discard").click();
  assert.equal(e.$("entries").querySelectorAll("input")[1].value, "ファイル");
  e.input(e.$("domain"), "EXAMPLE.COM"); e.$("add-domain").click();
  assert.equal(e.$("scope").value, "example.com");
  e.$("remove-scope").click(); e.$("discard").click();
  assert.ok([...e.$("scope").options].some(o => o.value === "example.com"));
  e.$("add-entry").click();
  const row = e.$("entries").lastElementChild;
  e.input(row.querySelectorAll("input")[0], "Directory"); e.input(row.querySelectorAll("input")[1], "ディレクトリ");
  await e.submit();
  assert.equal(e.writes(), 1); assert.equal(e.settings().apiKey, "secret");
  assert.equal(e.settings().dictionary.length, 3);
  e.$("entries").firstElementChild.querySelector("button").click(); await e.submit();
  assert.equal(e.settings().dictionary.length, 2);
  e.$("remove-scope").click(); await e.submit();
  assert.equal(e.settings().dictionary.length, 1);
  assert.equal(e.settings().dictionary[0].domain, "example.com");
  e.w.close();
});

test("dictionary editor rejects duplicate terms and conflicting external edits", async () => {
  const e = await editor([entry]);
  e.$("add-entry").click();
  const fields = e.$("entries").lastElementChild.querySelectorAll("input");
  e.input(fields[0], "File"); e.input(fields[1], "文書"); await e.submit();
  assert.equal(e.writes(), 0); assert.match(e.$("status").textContent, /重複/);
  e.$("discard").click();
  e.external([{ ...entry, target: "外部" }]);
  e.input(e.$("entries").querySelectorAll("input")[1], "文書"); await e.submit();
  assert.equal(e.writes(), 0); assert.match(e.$("status").textContent, /別の画面/);
  e.w.close();
});

test("dictionary editor disables additions at the scope limit", async () => {
  const e = await editor(Array.from({ length: 100 }, (_, i) => ({ ...entry, source: `x${i}`, target: "y" })));
  assert.equal(e.$("add-entry").disabled, true);
  e.$("entries").firstElementChild.querySelector("button").click();
  assert.equal(e.$("add-entry").disabled, false);
  e.$("discard").click(); assert.equal(e.$("add-entry").disabled, true);
  e.w.close();
});
