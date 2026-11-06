/* global browser */
(() => {
  const PROTOCOL = 5;
  if (globalThis.__kotobaLoaded) return;
  globalThis.__kotobaLoaded = true;
  const SKIP = new Set("SCRIPT STYLE NOSCRIPT TEMPLATE PRE CODE KBD SAMP VAR TEXTAREA INPUT SELECT OPTION BUTTON SVG MATH CANVAS VIDEO AUDIO IFRAME OBJECT EMBED".split(" "));
  const INLINE_CODE = new Set(["CODE", "KBD", "SAMP", "VAR"]);
  const INLINE_TAGS = new Set("a span strong em b i u s del sub sup mark small abbr q cite code kbd samp var".split(" "));
  const OPAQUE = new Set("BR WBR IMG HR".split(" "));
  const records = new Map();
  const transactions = new Set();
  const pageURL = () => { const url = new URL(location.href); url.hash = ""; return url.href; };
  let state = { url: pageURL(), source: null, target: null, running: false, done: 0, total: 0, failed: 0, message: "", concurrency: 1, percent: 0, startedAt: 0, finishedAt: 0, active: 0, pending: 0, activePercent: 0, phase: "", phaseStartedAt: 0, hoverEnabled: true };
  let generation = 0, panel, tooltip, host, shadow, lastHover;
  let appliedDirection = null;
  let panelKind, pageUI, pageDismissed = false, panelTimer, selectionCleanup;
  let showTimer, hideTimer, hoverCandidate, hoverAnchor, pinned = false, marks;
  let requestSequence = 0;
  const progressListeners = new Map();
  let scrollDirection = 1, previousScrollY = scrollY;
  document.addEventListener("scroll", () => {
    if (Math.abs(scrollY - previousScrollY) >= 4) scrollDirection = scrollY > previousScrollY ? 1 : -1;
    previousScrollY = scrollY;
  }, { passive: true, capture: true });
  function yieldToBrowser() {
    // Posted tasks yield to input/paint without the background-tab timer clamp.
    if (typeof MessageChannel === "function") return new Promise(resolve => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
      channel.port2.postMessage(null);
    });
    return new Promise(resolve => setTimeout(resolve, 0));
  }
  const preferences = { responsiveScan: true, prioritizeVisible: true, prioritizeContent: true, semanticBatching: true, adaptiveScheduling: true, inputTokens: 6000, tokenizer: "bytes", mainContentOnly: false, selectionButton: false,
    keyboardShortcuts: true, copyButton: true, focusOriginal: true, pageProgress: true, announceProgress: true, hoverEnabled: true };
  let announcer, announcementKey, launcher, launcherTimer, originalFocus;
  function applyPreferences(value) {
    if (preferences.focusOriginal && value.focusOriginal === false && originalFocus) clearTooltip();
    if (typeof value.hoverEnabled === "boolean" && preferences.hoverEnabled !== value.hoverEnabled) state.hoverEnabled = value.hoverEnabled;
    Object.assign(preferences, value);
    if (!state.hoverEnabled) clearTooltip();
    if (!preferences.selectionButton) clearLauncher();
    if (!preferences.copyButton) shadow?.querySelectorAll(".copy").forEach(node => node.remove());
    if (!preferences.pageProgress && panelKind === "page") closePanel();
    if (announcer && !preferences.announceProgress) announcer.textContent = "";
  }
  async function readPreferences() {
    const value = await browser.runtime.sendMessage({ type: "contentPreferences" });
    if (value.error) throw new Error(value.error);
    applyPreferences(value); return value;
  }

  function ui() {
    if (host?.isConnected) return;
    host = document.createElement("div");
    host.dataset.kotobaUi = "true"; host.lang = "ja"; host.dir = "ltr";
    host.style.cssText = "all:initial!important;position:fixed!important;inset:0 auto auto 0!important;z-index:2147483647!important;width:0!important;height:0!important";
    shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      :host { color-scheme:light; }
      * { box-sizing:border-box; }
      .box { position:fixed; font:13px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:#27272a; background:#fff; border:1px solid #dedee3; box-shadow:0 4px 20px #00000012; border-radius:8px; padding:14px 16px; text-align:start; overflow-wrap:anywhere; }
      .panel { right:16px; bottom:16px; width:min(320px,calc(100vw - 24px)); max-height:70vh; overflow:auto; }
      .panel.selection { width:min(420px,calc(100vw - 24px)); }
      .tooltip { width:max-content; max-width:min(520px,calc(100vw - 24px)); max-height:min(360px,45vh); overflow:auto; white-space:pre-wrap; pointer-events:auto; z-index:2; }
      .heading { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:10px; }
      h2 { margin:0; font-size:13px; font-weight:600; } p { margin:8px 0; white-space:pre-wrap; } small { color:#62626c; }
      button { display:inline-flex; align-items:center; justify-content:center; min-height:36px; font:inherit; font-size:12px; font-weight:500; border:1px solid #dedee3; border-radius:5px; padding:4px 10px; background:#fff; color:#52525b; cursor:pointer; }
      button:hover { background:#f4f4f5; } button.primary { color:#fff; border-color:#006fc5; background:#006fc5; } button.primary:hover { background:#005da6; }
      button:disabled { opacity:.45; cursor:default; } button:focus-visible,select:focus-visible,summary:focus-visible,.box:focus-visible { outline:2px solid #006fc5; outline-offset:2px; }
      button.icon { border:0; background:transparent; min-height:32px; min-width:32px; padding:0 4px; color:#71717a; }
      button.icon:hover,button[aria-pressed="true"] { color:#087fdb; background:#f0f9ff; }
      .close { font-size:20px; line-height:1; } .tools,.actions { display:flex; align-items:center; gap:8px; } .actions { margin-top:12px; justify-content:flex-end; }
      select { width:100%; min-width:0; font:inherit; padding:7px 8px; background:white; color:#27272a; border:1px solid #dedee3; border-radius:5px; }
      .languages { display:flex; align-items:end; gap:8px; margin-bottom:12px; } label { display:block; flex:1; min-width:0; font-size:12px; color:#62626c; } label select { margin-top:4px; font-size:13px; }
      .result { border-top:1px solid #e4e4e7; padding-top:12px; font-size:14px; line-height:1.8; user-select:text; }
      .error { color:#b42318; font-size:12px; } .message:empty { display:none; }
      .progress-label,.progress-detail { display:flex; justify-content:space-between; align-items:center; gap:10px; font-size:12px; }
      .progress-label strong { color:#087fdb; font-variant-numeric:tabular-nums; font-weight:600; }
      .progress-detail { font-size:11px; color:#71717a; margin-top:6px; font-variant-numeric:tabular-nums; }
      progress { display:block; appearance:none; width:100%; height:4px; border:0; border-radius:3px; overflow:hidden; background:#e4e4e7; }
      .progress-track { margin-top:8px; }
      progress::-moz-progress-bar { background:#0ba5ec; border-radius:3px; }
      .progress-track { position:relative; border-radius:3px; overflow:hidden; }
      .progress-pending { position:absolute; inset-block:0; pointer-events:none; background:repeating-linear-gradient(120deg,#bae6fd 0 4px,#e0f2fe 4px 8px); }
      .progress-activity { display:flex; flex-wrap:wrap; justify-content:space-between; gap:2px 10px; margin-top:6px; color:#62626c; font-size:11px; font-variant-numeric:tabular-nums; }
      details { font-size:12px; color:#71717a; } summary { cursor:pointer; } details p { color:#52525b; max-height:150px; overflow:auto; }
      .mark { position:fixed; pointer-events:none; border-radius:2px; background:#0ea5e91a; border-bottom:1px solid #0ea5e955; }
      .original { margin:0; font-size:14px; line-height:1.75; user-select:text; } .tooltip .heading { margin-bottom:6px; }
      .launcher { padding:5px 10px; min-height:36px; color:#006fc5; }
      .sr-only { position:absolute; width:1px; height:1px; padding:0; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
      @media(forced-colors:active) { .box,button,select { border:1px solid ButtonText; } .mark { outline:1px solid Highlight; } }
      [hidden] { display:none!important; }
    `;
    shadow.append(style);
    announcer = document.createElement("div"); announcer.className = "sr-only";
    announcer.setAttribute("role", "status"); announcer.setAttribute("aria-atomic", "true"); shadow.append(announcer);
    document.documentElement.append(host);
  }
  function announce() {
    if (!preferences.announceProgress) return;
    const key = state.preparing ? "preparing" : state.running ? `running-${Math.floor(state.percent / 25)}` : `${state.finishedAt}-${state.message}-${state.failed}`;
    if (key === announcementKey) return;
    announcementKey = key; ui();
    announcer.textContent = state.preparing ? "翻訳対象を解析しています" : state.running ? `ページ翻訳 ${Math.floor(state.percent / 25) * 25}%`
      : state.failed ? `一部未翻訳。${state.message}` : state.percent === 100 ? "ページ翻訳が完了しました" : state.message;
  }
  function copyButton(getText) {
    const node = button("コピー", async () => {
      node.disabled = true;
      try {
        const response = await browser.runtime.sendMessage({ type: "copyText", text: getText() });
        if (response.error) throw new Error(response.error);
        node.textContent = "コピーしました";
      } catch { node.textContent = "コピーできませんでした"; }
      finally { node.disabled = false; }
    });
    node.className = "copy"; return node;
  }
  function button(label, action) {
    const node = document.createElement("button"); node.type = "button"; node.textContent = label; node.addEventListener("click", action); return node;
  }
  function closeButton(action) {
    const node = button("×", action); node.className = "icon close"; node.setAttribute("aria-label", "閉じる"); node.title = "閉じる"; return node;
  }
  function closePanel() {
    if (panelKind === "page") pageDismissed = true;
    selectionCleanup?.(); selectionCleanup = null;
    clearInterval(panelTimer); panelTimer = null;
    panel?.remove(); panel = null; pageUI = null; panelKind = null;
  }
  function box(title, kind = "selection") {
    ui(); closePanel(); panel = document.createElement("section"); panel.className = `box panel ${kind}`; panelKind = kind;
    panel.setAttribute("role", kind === "page" ? "region" : "dialog"); panel.setAttribute("aria-label", title);
    const header = document.createElement("div"); header.className = "heading";
    const heading = document.createElement("h2"); heading.textContent = title;
    header.append(heading, closeButton(closePanel)); panel.append(header); shadow.append(panel); return panel;
  }
  function progressView() {
    const node = document.createElement("div");
    const header = document.createElement("div"); header.className = "progress-label";
    const label = document.createElement("span"), percent = document.createElement("strong");
    header.append(label, percent);
    const bar = document.createElement("progress"); bar.max = 100; bar.value = 0; bar.setAttribute("aria-label", "翻訳の進捗");
    const detail = document.createElement("div"); detail.className = "progress-detail";
    const count = document.createElement("span"), elapsed = document.createElement("span"); detail.append(count, elapsed);
    const track = document.createElement("div"); track.className = "progress-track";
    const pending = document.createElement("div"); pending.className = "progress-pending"; pending.hidden = true; pending.setAttribute("aria-hidden", "true");
    track.append(bar, pending);
    const activity = document.createElement("div"); activity.className = "progress-activity"; activity.hidden = true;
    const work = document.createElement("span"), phase = document.createElement("span"); activity.append(work, phase);
    node.append(header, track, detail, activity);
    return { node, label, percent, bar, count, elapsed, pending, activity, work, phase };
  }
  function statusPanel() {
    announce();
    if (!preferences.pageProgress || pageDismissed || panelKind === "selection") return;
    if (!pageUI) {
      const node = box("ページ翻訳", "page"); pageDismissed = false;
      const progress = progressView();
      const message = document.createElement("p"); message.className = "message"; message.setAttribute("aria-live", "polite");
      const actions = document.createElement("div"); actions.className = "actions";
      const original = button("原文に戻す", restore);
      const action = button("停止", () => state.running ? stop() : translatePage(state.source, state.target)); action.className = "primary";
      actions.append(original, action); node.append(progress.node, message, actions);
      pageUI = { ...progress, message, original, action };
    }
    if (state.running && !panelTimer) panelTimer = setInterval(statusPanel, 1000);
    pageUI.label.textContent = state.preparing ? "ページを解析中" : state.running ? "翻訳中" : state.failed ? "一部未翻訳" : state.percent === 100 ? "翻訳完了" : state.total ? "停止中" : "対象なし";
    pageUI.bar.value = state.percent; pageUI.percent.textContent = `${state.percent}%`;
    if (state.preparing) { pageUI.bar.removeAttribute("value"); pageUI.percent.textContent = ""; }
    pageUI.pending.hidden = !state.running || state.preparing || !state.activePercent;
    pageUI.pending.style.left = `${state.percent}%`; pageUI.pending.style.width = `${state.activePercent}%`;
    pageUI.activity.hidden = !state.running || state.preparing;
    pageUI.work.textContent = `処理中 ${state.active}段落 · 未着手 ${state.pending}段落`;
    const phase = { preparing: "翻訳を準備中", queued: "順番待ち", tokenizing: "入力を計測中", translating: "応答待ち", retrying: "再試行まで待機", receiving: "訳文を受信中" }[state.phase] || "";
    pageUI.phase.textContent = phase ? `${phase}${state.phase === "receiving" && state.receivedCharacters ? ` · ${state.receivedCharacters}文字` : ""} ${Math.floor((Date.now() - state.phaseStartedAt) / 1000)}秒` : "";
    pageUI.count.textContent = `${state.done} / ${state.total} 段落`;
    pageUI.elapsed.textContent = state.startedAt ? `${Math.floor(((state.finishedAt || Date.now()) - state.startedAt) / 1000)}秒` : "";
    pageUI.message.textContent = state.failed || state.skipped || !state.total ? state.message : "";
    pageUI.message.classList.toggle("error", state.failed > 0);
    pageUI.action.textContent = state.running ? "停止" : state.failed ? "再試行" : "再開";
    pageUI.action.hidden = !state.running && (!state.total || state.percent === 100 && !state.failed);
    pageUI.original.disabled = !records.size && !state.running;
    if (!state.running) { clearInterval(panelTimer); panelTimer = null; }
  }
  function clearTooltip() {
    clearTimeout(showTimer); clearTimeout(hideTimer); showTimer = null; hideTimer = null; hoverCandidate = null;
    const focused = tooltip?.contains(shadow.activeElement);
    tooltip?.remove(); marks?.remove(); tooltip = null; marks = null; lastHover = null; pinned = false;
    const previousFocus = originalFocus; originalFocus = null;
    if (focused && previousFocus?.isConnected) {
      returningFocus = true; previousFocus.focus({ preventScroll: true }); returningFocus = false;
    }
  }
  function currentPage() {
    if (state.url !== pageURL()) {
      stop(); restore();
      state = { ...state, url: pageURL(), source: null, target: null, done: 0, total: 0, failed: 0, message: "", percent: 0, startedAt: 0, finishedAt: 0 };
    }
  }
  function clearActivity() {
    state.active = 0; state.pending = 0; state.activePercent = 0; state.phase = ""; state.phaseStartedAt = 0; state.receivedCharacters = 0;
  }
  function stop() {
    generation++; clearActivity();
    state.running = false; state.preparing = false;
    state.finishedAt = Date.now(); state.message = "停止しました";
    browser.runtime.sendMessage({ type: "cancel" }).catch(() => {});
    if (panel || state.startedAt) statusPanel();
  }
  function restore() {
    stop(); clearTooltip();
    for (const unit of transactions) {
      if (!snapshotMatches(unit.appliedSnapshot) || !contiguous(unit.appliedRoots, unit.parent)) continue;
      if (unit.inPlace) {
        for (const item of unit.originalSnapshot) if (item.data !== undefined) item.node.data = item.data;
        continue;
      }
      const next = unit.appliedRoots.at(-1).nextSibling;
      for (const node of unit.appliedRoots) node.remove();
      for (const item of [...unit.originalSnapshot].reverse()) {
        if (item.children) item.node.replaceChildren(...item.children);
        else if (item.data !== undefined) item.node.data = item.data;
      }
      const fragment = document.createDocumentFragment(); fragment.append(...unit.roots);
      unit.parent.insertBefore(fragment, next);
    }
    transactions.clear();
    records.clear(); appliedDirection = null; state.done = 0; state.total = 0; state.failed = 0; state.percent = 0; state.startedAt = 0; state.finishedAt = 0;
    state.cacheRestored = false; state.message = "原文に戻しました";
    if (panelKind === "page") closePanel();
  }
  function parentElement(node) { return node.parentElement || node.getRootNode()?.host || null; }
  function language(element) {
    for (let el = element; el; el = parentElement(el)) {
      if (el.hasAttribute("lang")) return el.getAttribute("lang").toLowerCase();
    }
    return "";
  }
  function sameLanguage(a, b) {
    if (a.startsWith("zh") && b.startsWith("zh")) {
      const script = x => /hant|tw|hk|mo/.test(x) ? "hant" : "hans";
      return script(a) === script(b);
    }
    return a.split("-")[0] === b.split("-")[0];
  }
  function prose(text, element, lang = language(element)) {
    const value = text.trim();
    if (!/\p{L}/u.test(value)) return false;
    if (/^(?:(?:https?:\/\/|www\.)\S+|[^\s@]+@[^\s@]+\.[^\s@]+|(?:\/|\.\/|\.\.\/)[\w./@%+~#?=&:-]+)$/u.test(value)) return false;
    if (lang && sameLanguage(lang, state.target)) return false;
    // Avoid re-translating unlabelled Japanese/Korean prose into the same language.
    if (state.target === "ja" && /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(value) && !/[a-zA-Z]{4}/.test(value)) return false;
    if (state.target === "ko" && /\p{Script=Hangul}/u.test(value) && !/[a-zA-Z]{4}/.test(value)) return false;
    return true;
  }
  function snapshot(roots, opaque = new Set()) {
    const result = [];
    function visit(node) {
      if (node.nodeType === Node.TEXT_NODE) result.push({ node, data: node.data });
      else if (node.nodeType === Node.ELEMENT_NODE) {
        // Protected subtrees stay live and are never rewritten, even on restore.
        if (opaque.has(node)) { result.push({ node }); return; }
        result.push({ node, children: [...node.childNodes], attributes: [...node.attributes].map(attr => [attr.name, attr.value]) });
        for (const child of node.childNodes) visit(child);
      }
    }
    roots.forEach(visit); return result;
  }
  function attributesMatch(node, attributes) {
    return attributes.length === node.attributes.length && attributes.every(([name, value]) => node.getAttribute(name) === value);
  }
  function snapshotMatches(items, checkAttributes = true) {
    return items.every(item => item.node.isConnected && (item.children
      ? item.children.length === item.node.childNodes.length && item.children.every((child, i) => child === item.node.childNodes[i])
      : item.data === undefined || item.node.data === item.data) && (!checkAttributes || !item.attributes || attributesMatch(item.node, item.attributes)));
  }
  function contiguous(roots, parent) {
    return roots.length && roots.every((node, i) => node.parentNode === parent && (!i || roots[i - 1].nextSibling === node));
  }
  async function collect(run = generation, scanPreferences = preferences) {
    const scan = { ...scanPreferences };
    // Release detached SPA paragraphs when another manual scan starts.
    for (const [node] of records) if (!node.isConnected) records.delete(node);
    for (const unit of transactions) if (!snapshotMatches(unit.appliedSnapshot, false) || !contiguous(unit.appliedRoots, unit.parent)) {
      transactions.delete(unit);
      for (const item of unit.appliedSnapshot) if (item.data !== undefined && records.get(item.node)?.translated === item.data) records.delete(item.node);
    }
    const groups = [], cache = new WeakMap(), blockCache = new WeakMap(), omissionCache = new WeakMap(), languageCache = new WeakMap();
    const getLanguage = element => {
      const path = [];
      let el = element;
      while (el && !languageCache.has(el) && !el.hasAttribute("lang")) { path.push(el); el = parentElement(el); }
      const lang = el ? languageCache.get(el) ?? el.getAttribute("lang").toLowerCase() : "";
      if (el) languageCache.set(el, lang);
      for (const item of path) languageCache.set(item, lang);
      return lang;
    };
    const computed = el => { if (!cache.has(el)) cache.set(el, getComputedStyle(el)); return cache.get(el); };
    const isBlock = el => /^(block|flow-root|flex|grid|list-item|table(?:-.+)?)(?:\s|$)/.test(computed(el).display) || /^(P|H[1-6]|LI|DT|DD|TD|TH|BLOCKQUOTE|FIGCAPTION|SUMMARY|HR)$/.test(el.tagName) || el.getAttribute("role") === "heading";
    const hidden = el => {
      const disclosure = el.closest("details:not([open])");
      if (disclosure && el !== disclosure) {
        const summary = [...disclosure.children].find(child => child.tagName === "SUMMARY");
        if (!summary?.contains(el)) return true;
      }
      const css = computed(el);
      return el === host || el.matches('[data-kotoba-ui],[hidden],[inert],[aria-hidden="true"],.sr-only,.visually-hidden,.screen-reader-text') || css.display === "none" || css.contentVisibility === "hidden" || css.visibility && css.visibility !== "visible" || css.opacity === "0" ||
        (/absolute|fixed/.test(css.position) && parseFloat(css.width) <= 1 && parseFloat(css.height) <= 1 && (css.overflow === "hidden" || css.clipPath?.includes("inset(50%")));
    };
    const excluded = el => SKIP.has(el.tagName) && !INLINE_CODE.has(el.tagName) || el.matches('[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="searchbox"],[role="combobox"]');
    const protectedElement = el => INLINE_CODE.has(el.tagName) || el.matches('.notranslate,[translate="no"]') || getLanguage(el) && sameLanguage(getLanguage(el), state.target);
    const omitted = el => {
      if (!omissionCache.has(el)) omissionCache.set(el, hidden(el) || excluded(el) || protectedElement(el));
      return omissionCache.get(el);
    };
    const applied = new Set([...transactions].flatMap(unit => unit.appliedRoots));
    function makeUnit(roots) {
      if (!roots.length) return;
      const parent = roots[0].parentNode;
      if (!contiguous(roots, parent)) return;
      const elements = new Map(), extras = new Map(), textBindings = new Map(), opaque = new Set();
      let eligible = false, id = 0, length = 0, originalBlock = "";
      const extra = (node, owner) => { if (node.nodeType === Node.ELEMENT_NODE) opaque.add(node); if (!extras.has(owner)) extras.set(owner, []); extras.get(owner).push(node); return []; };
      function protectedText(node) {
        if (node.nodeType === Node.TEXT_NODE) return node.data;
        if (node.nodeType !== Node.ELEMENT_NODE || hidden(node) || excluded(node)) return "";
        return [...node.childNodes].map(protectedText).join("");
      }
      function build(node, owner = null) {
        if (node.nodeType === Node.TEXT_NODE) {
          const text = node.data.replace(/[\u200b\u2060\ufeff]/g, "");
          if (!text) return extra(node, owner);
          length += text.length; originalBlock += text;
          if (/\p{L}/u.test(text) && prose(text, parentElement(node), getLanguage(parentElement(node)))) eligible = true;
          const item = { text }; textBindings.set(item, node);
          return [item];
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return extra(node, owner);
        if (hidden(node)) return extra(node, owner);
        if (excluded(node) || OPAQUE.has(node.tagName)) {
          opaque.add(node);
          if (node.tagName === "BR") originalBlock += "\n";
          const key = `k${id++}`; elements.set(key, node);
          return [{ id: key, tag: "span", protected: true, children: [] }];
        }
        const protect = protectedElement(node);
        // Attribute-free spans are DOM scaffolding, not linguistic boundaries.
        if (node.tagName === "SPAN" && !node.attributes.length && !protect) return [...node.childNodes].flatMap(child => build(child, owner));
        const key = `k${id++}`;
        // Serialize unfamiliar inline wrappers as spans; retain their actual DOM identity.
        const name = node.tagName.toLowerCase();
        const tag = INLINE_TAGS.has(name) && (!protect || INLINE_CODE.has(node.tagName)) ? name : "span";
        if (protect) opaque.add(node);
        elements.set(key, node);
        const text = protect ? protectedText(node) : "";
        if (protect) originalBlock += text;
        const children = protect ? [{ text }] : [...node.childNodes].flatMap(child => build(child, key));
        return [{ id: key, tag, children, ...(protect ? { protected: true } : {}) }];
      }
      const tree = roots.flatMap(node => build(node));
      if (!eligible || !length) return;
      const context = parentElement(roots[0]);
      groups.push({ order: groups.length, roots: [...roots], parent, elements, extras, document: tree, length, originalBlock, textBindings, opaque,
        originalSnapshot: snapshot(roots, opaque), context, contextLanguage: getLanguage(context),
        contextAttributes: [...context.attributes].map(attr => [attr.name, attr.value]) });
    }
    let visited = 0;
    function checkpoint() {
      if (run !== generation || state.url !== pageURL()) throw new DOMException("キャンセルしました", "AbortError");
      if (scan.responsiveScan && ++visited % 80 === 0) return yieldToBrowser();
    }
    // Post-order indexing avoids recursive look-ahead into huge SPA subtrees.
    async function indexBlocks(root) {
      const stack = [[root, false]];
      while (stack.length) {
        const pause = checkpoint(); if (pause) await pause;
        const [el, ready] = stack.pop();
        if (ready) {
          blockCache.set(el, [...el.children].some(child => !omitted(child) && (isBlock(child) || child.shadowRoot || child.tagName === "SLOT" || blockCache.get(child))));
        } else {
          stack.push([el, true]);
          for (const child of el.children) if (!omitted(child)) stack.push([child, false]);
        }
      }
    }
    async function walk(container) {
      let roots = [];
      const flush = () => { makeUnit(roots); roots = []; };
      if (!blockCache.has(container)) await indexBlocks(container);
      const assigned = container.tagName === "SLOT" ? container.assignedNodes({ flatten: true }) : [];
      const children = container.tagName === "DETAILS" && !container.open
        ? [...container.children].filter(child => child.tagName === "SUMMARY").slice(0, 1)
        : assigned.length ? assigned : [...container.childNodes];
      // CSS flex/block on a link or span does not turn it into a separate
      // linguistic paragraph. Keep explicit paragraph containers intact.
      if (scan.adaptiveScheduling && blockCache.get(container) && /^(P|H[1-6]|TD|TH|DT|DD|SUMMARY|FIGCAPTION)$/.test(container.tagName) &&
        !children.some(node => applied.has(node)) && !container.querySelector('p,h1,h2,h3,h4,h5,h6,li,dt,dd,table,[role="heading"],[role="listitem"],[role="row"]') &&
        ![...container.querySelectorAll("*")].some(node => node.shadowRoot || node.tagName === "SLOT")) {
        makeUnit(children); return;
      }
      for (const node of children) {
        const pause = checkpoint(); if (pause) await pause;
        if (applied.has(node)) { flush(); continue; }
        if (node.nodeType === Node.ELEMENT_NODE && omitted(node)) {
          // Inline exclusions remain in the paragraph, but are never sent as prose.
          if (isBlock(node)) flush(); else roots.push(node);
          continue;
        }
        if (node.nodeType === Node.ELEMENT_NODE && node.shadowRoot) { flush(); await walk(node.shadowRoot); continue; }
        if (node.nodeType === Node.ELEMENT_NODE && (node.tagName === "SLOT" || isBlock(node) || blockCache.get(node))) {
          flush(); await walk(node); continue;
        }
        if (roots.length && (roots[0].parentNode !== node.parentNode || roots.at(-1).nextSibling !== node)) flush();
        roots.push(node);
      }
      flush();
    }
    let scopes = scan.mainContentOnly ? [...document.querySelectorAll('main,[role="main"]')] : [];
    if (scan.mainContentOnly && !scopes.length) scopes = [...document.querySelectorAll("article")];
    if (!scopes.length && document.body) scopes = [document.body];
    scopes = scopes.filter(node => !scopes.some(other => other !== node && other.contains(node)));
    for (const scope of scopes) {
      let blocked = false;
      for (let el = scope; el; el = parentElement(el)) if (omitted(el)) { blocked = true; break; }
      if (!blocked) await walk(scope);
    }
    if (scan.prioritizeVisible || scan.prioritizeContent || scan.semanticBatching || scan.adaptiveScheduling) {
      const ordered = [];
      for (const group of groups) {
        if (scan.responsiveScan && ++visited % 80 === 0) await yieldToBrowser();
        if (run !== generation) throw new DOMException("キャンセルしました", "AbortError");
        const context = group.context;
        const content = context.closest('article,main,[role="main"],[role="article"]');
        const article = context.closest('article,[role="article"]');
        const peripheral = context.closest('nav,aside,footer,[role="navigation"],[role="complementary"],[role="contentinfo"],.sidebar,.widget-area');
        const banner = context.closest('header,[role="banner"]');
        const chrome = peripheral || (banner && (!article || !article.contains(banner)) ? banner : null);
        const table = context.closest('table,[role="table"],[role="grid"]');
        const figure = context.closest("figure");
        const gallery = figure && (figure.previousElementSibling?.tagName === "FIGURE" || figure.nextElementSibling?.tagName === "FIGURE") ? figure.parentElement : null;
        group.priority = chrome ? 3 : content ? (table || context.closest("summary") ? 1 : 0) : 2;
        group.component = table || chrome || gallery || context.closest('section,blockquote,figure,article,main,[role="main"],[role="article"],[role="list"],ul,ol,dl') || context.closest("div") || context.getRootNode().host || document.body;
        group.semanticUnit = context.closest('tr,li,figure,blockquote,[role="row"],[role="listitem"]');
        group.heading = /^H[1-6]$/.test(context.tagName) || context.getAttribute("role") === "heading";
        ordered.push({ group, distance: scan.prioritizeVisible ? viewportDistance(group) : 0 });
      }
      const sections = new Map();
      for (let index = 0; index < ordered.length; index++) {
        const group = ordered[index].group;
        const next = ordered[index + 1]?.group;
        if (group.heading && group.priority < 3 && next?.priority === 1 && next.context.closest('summary,table,[role="table"],[role="grid"]')) {
          // A regional/table heading belongs with its supplemental content,
          // rather than being sent alone ahead of every other section.
          group.priority = 1; group.component = next.component;
          if (!group.semanticUnit && next.semanticUnit) group.semanticUnit = next.semanticUnit;
        }
        if (group.heading) sections.set(group.component, group.context);
        group.section = sections.get(group.component) || group.component;
        if (group.heading && !group.semanticUnit && next && !next.heading && !next.semanticUnit && next.component === group.component && next.priority === group.priority) {
          group.semanticUnit = group.context; next.semanticUnit = group.context;
        }
      }
      if (scan.prioritizeContent) {
        // Some sites use only divs. Infer priority conservatively from complete
        // prose and link density; this changes ordering, never the target scope.
        const stats = new Map();
        const linkedLength = (nodes, linked = false) => nodes.reduce((sum, node) => sum + (node.protected ? 0 : node.text !== undefined
          ? linked ? node.text.length : 0 : linkedLength(node.children, linked || node.tag === "a")), 0);
        for (const { group } of ordered) if (group.priority === 2) {
          const item = stats.get(group.component) || { chars: 0, prose: 0, links: 0, units: 0 };
          item.chars += group.length; item.units++; item.links += linkedLength(group.document);
          if (/[。！？]|[.!?](?:\s|$)/u.test(group.originalBlock)) item.prose += group.length;
          stats.set(group.component, item);
        }
        for (const { group } of ordered) if (group.priority === 2) {
          const item = stats.get(group.component), density = item.links / Math.max(1, item.chars);
          if (item.chars >= 160 && item.prose >= 120 && density < 0.45) group.priority = group.component.tagName === "TABLE" ? 1 : 0;
          else if (item.units >= 3 && density >= 0.8) group.priority = 3;
        }
      }
      return ordered.sort((a, b) => (scan.prioritizeContent ? a.group.priority - b.group.priority : 0) || a.distance - b.distance).map(item => item.group);
    }
    return groups;
  }
  function viewportDistance(group) {
    return viewportPosition(group).distance;
  }
  function viewportPosition(group) {
    if (!group.parent.isConnected || !contiguous(group.roots, group.parent)) return { distance: Infinity, behind: false };
    const range = document.createRange(); range.setStartBefore(group.roots[0]); range.setEndAfter(group.roots.at(-1));
    let rect = range.getBoundingClientRect?.() || group.parent.getBoundingClientRect?.();
    if (rect && !(rect.width || rect.right - rect.left || rect.height || rect.bottom - rect.top)) rect = [...(range.getClientRects?.() || [])].find(item => item.width || item.height);
    if (!rect) return { distance: Infinity, behind: false };
    return { distance: Math.max(0, -rect.bottom, rect.top - innerHeight, -rect.right || 0, rect.left - innerWidth || 0),
      behind: scrollDirection > 0 ? rect.bottom < 0 : rect.top > innerHeight };
  }
  function unitStillMatches(unit) {
    if (!snapshotMatches(unit.originalSnapshot) || !contiguous(unit.roots, unit.parent) || !attributesMatch(unit.context, unit.contextAttributes) || language(unit.context) !== unit.contextLanguage) return false;
    for (let el = unit.context; el; el = parentElement(el)) {
      if (el.matches('[hidden],[inert],[aria-hidden="true"],[translate="no"],.notranslate,.sr-only,.visually-hidden,.screen-reader-text,[data-kotoba-ui],[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="searchbox"],[role="combobox"]')) return false;
      if (el.tagName === "DETAILS" && !el.open && ![...el.children].find(child => child.tagName === "SUMMARY")?.contains(unit.context)) return false;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.contentVisibility === "hidden" || style.visibility && style.visibility !== "visible" || style.opacity === "0") return false;
      if (/absolute|fixed/.test(style.position) && parseFloat(style.width) <= 1 && parseFloat(style.height) <= 1 && (style.overflow === "hidden" || style.clipPath?.includes("inset(50%"))) return false;
    }
    return true;
  }
  function applyDocument(unit, tree) {
    if (!unitStillMatches(unit)) return false;
    // When inline order is unchanged, update Text.data only. Frameworks keep their
    // text-node references, focus stays put, and no child-list mutations are needed.
    const edits = [];
    function plan(source, target) {
      let i = 0, j = 0;
      while (i < source.length && j < target.length) {
        if (source[i].text !== undefined && target[j].text !== undefined) {
          const bindings = [];
          let text = "";
          while (i < source.length && source[i].text !== undefined) bindings.push(unit.textBindings.get(source[i++]));
          while (j < target.length && target[j].text !== undefined) text += target[j++].text;
          if (bindings.some(node => !node)) return false;
          bindings.forEach((node, index) => edits.push([node, index ? "" : text]));
        } else {
          const before = source[i++], after = target[j++];
          if (!before.id || before.id !== after.id || before.tag !== after.tag || !!before.protected !== !!after.protected) return false;
          if (!before.protected && !plan(before.children, after.children)) return false;
        }
      }
      return i === source.length && j === target.length;
    }
    const translatedNodes = [];
    function render(nodes, owner = null) {
      const fragment = document.createDocumentFragment();
      for (const item of nodes) {
        if (item.text !== undefined) {
          const node = document.createTextNode(item.text); translatedNodes.push(node); fragment.append(node);
        } else {
          const element = unit.elements.get(item.id);
          if (!element) throw new Error("翻訳結果の要素が一致しません。");
          if (!item.protected) element.replaceChildren(render(item.children, item.id));
          fragment.append(element);
        }
      }
      fragment.append(...(unit.extras.get(owner) || []));
      return fragment;
    }
    unit.inPlace = plan(unit.document, tree);
    if (unit.inPlace) {
      for (const [node, text] of edits) { if (node.data !== text) node.data = text; translatedNodes.push(node); }
      unit.appliedRoots = unit.roots;
    } else {
      const next = unit.roots.at(-1).nextSibling;
      for (const node of unit.roots) node.remove();
      const fragment = render(tree);
      unit.appliedRoots = [...fragment.childNodes];
      unit.parent.insertBefore(fragment, next);
    }
    unit.appliedSnapshot = snapshot(unit.appliedRoots, unit.opaque); transactions.add(unit);
    const group = { originalBlock: unit.originalBlock, nodes: translatedNodes, source: state.source };
    for (const node of translatedNodes) records.set(node, { translated: node.data, group });
    return true;
  }
  async function translatePage(source, target) {
    currentPage();
    if (state.running) return { ...state };
    if (appliedDirection && appliedDirection !== `${source}:${target}`) restore();
    state.source = source; state.target = target;
    const run = ++generation;
    state.running = true; state.preparing = true; state.done = 0; state.total = 0; state.failed = 0; state.skipped = 0; state.cacheRestored = false;
    state.percent = 0; state.startedAt = Date.now(); state.finishedAt = 0;
    state.message = ""; clearActivity();
    if (panelKind === "selection") closePanel();
    pageDismissed = false; clearTooltip();
    statusPanel();
    const scheduling = { ...preferences };
    let groups;
    try { groups = await collect(run, scheduling); }
    catch (error) { if (run !== generation) return; throw error; }
    if (run !== generation) return;
    if (state.url !== pageURL()) { currentPage(); return; }
    state.preparing = false; state.total = groups.length;
    state.message = groups.length ? "" : "翻訳対象がありません";
    let totalChars = groups.reduce((sum, group) => sum + group.length, 0);
    let completedChars = 0, cursor = 0, batchingAvailable = true;
    const unsent = new Set(groups), sourceOrder = [...groups].sort((a, b) => a.order - b.order);
    let planning = Promise.resolve();
    const activeProgress = new Map();
    const updateProgress = () => {
      if (run !== generation) return;
      const active = [...activeProgress.values()];
      const processed = active.reduce((sum, item) => sum + Math.max(item.completed, item.deliveredChars), 0);
      state.percent = totalChars ? Math.min(100, Math.floor((completedChars + processed) / totalChars * 100)) : 0;
      state.active = active.reduce((sum, item) => sum + item.remaining.size, 0);
      state.pending = unsent.size;
      state.activePercent = totalChars ? Math.max(0, (active.reduce((sum, item) => sum + item.length, 0) - processed) / totalChars * 100) : 0;
      const current = active.find(item => item.phase === "receiving" || item.phase === "translating") || active.find(item => item.phase === "tokenizing") || active[0];
      state.phase = current?.phase || ""; state.phaseStartedAt = current?.since || 0;
      state.receivedCharacters = current?.receivedCharacters || 0;
      statusPanel();
    };
    updateProgress();
    async function adaptiveBatch() {
      const candidates = sourceOrder.filter(group => {
        if (!unsent.has(group)) return false;
        if (!snapshotMatches(group.originalSnapshot) || !contiguous(group.roots, group.parent) || !attributesMatch(group.context, group.contextAttributes) || language(group.context) !== group.contextLanguage) {
          unsent.delete(group); state.total--; totalChars -= group.length; state.skipped = (state.skipped || 0) + 1; return false;
        }
        return true;
      });
      const blocks = [];
      for (let index = 0; index < candidates.length; index++) {
        if (run !== generation) return [];
        if (scheduling.responsiveScan && index && index % 80 === 0) await yieldToBrowser();
        const group = candidates[index], previous = blocks.at(-1);
        const position = scheduling.prioritizeVisible ? viewportPosition(group) : { distance: 0, behind: false };
        group.wireBytes ??= wireSize(group.document) + 18;
        if (group.semanticUnit && previous?.unit === group.semanticUnit && previous.component === group.component && previous.section === group.section && previous.priority === (group.priority || 0) && previous.groups.at(-1).order + 1 === group.order) {
          previous.groups.push(group);
          if (position.distance < previous.position.distance) previous.position = position;
        } else blocks.push({ groups: [group], unit: group.semanticUnit, component: group.component, section: group.section, priority: group.priority || 0, position });
      }
      const horizon = Math.max(1, innerHeight) * 1.5;
      const score = block => [block.position.distance <= horizon ? 0 : 1, scheduling.prioritizeContent ? block.priority : 0,
        block.position.distance === 0 ? 0 : 1, block.position.behind ? 1 : 0, block.position.distance, block.groups[0].order];
      for (const block of blocks) block.score = score(block);
      const compare = (a, b) => { for (let i = 0; i < a.score.length; i++) if (a.score[i] !== b.score[i]) return a.score[i] < b.score[i] ? -1 : 1; return 0; };
      let best = 0;
      for (let i = 1; i < blocks.length; i++) if (compare(blocks[i], blocks[best]) < 0) best = i;
      const first = blocks[best];
      if (!first || run !== generation) return [];
      const near = first.position.distance <= horizon, warmup = cursor === 0;
      const batching = scheduling.semanticBatching && state.batchTranslation && batchingAvailable;
      const limit = Math.min(scheduling.inputTokens, warmup ? 1200 : near ? 2400 : scheduling.inputTokens);
      const maxItems = batching ? warmup ? 4 : near ? 16 : 64 : 1;
      const size = group => scheduling.tokenizer === "bytes" ? group.wireBytes : group.wireBytes / 3;
      const selected = [];
      let bytes = 0;
      for (let index = best; index < blocks.length; index++) {
        const block = blocks[index], last = selected.at(-1);
        if (selected.length && (block.component !== first.component || block.priority !== first.priority ||
          (block.position.distance <= horizon) !== near || last.order + 1 !== block.groups[0].order)) break;
        if (selected.length && block.section !== last.section) {
          // Small complete peer sections in a table/list can share a request.
          // Article sections stay separate, and never join after a heading was
          // omitted by viewport prioritization or an earlier translation.
          if (first.priority !== 1 || !block.groups[0].heading) break;
          let sectionSize = 0, sectionItems = 0;
          for (let end = index; end < blocks.length && blocks[end].section === block.section; end++) {
            sectionItems += blocks[end].groups.length;
            sectionSize += blocks[end].groups.reduce((sum, group) => sum + size(group), 0);
          }
          if (bytes + sectionSize > limit || selected.length + sectionItems > maxItems) break;
        }
        const blockSize = block.groups.reduce((sum, group) => sum + size(group), 0);
        if (selected.length && (bytes + blockSize > limit || selected.length + block.groups.length > maxItems)) break;
        const blockMax = batching && !selected.length && blockSize <= limit ? Math.min(64, Math.max(maxItems, block.groups.length)) : maxItems;
        for (const group of block.groups) {
          if (selected.length && (selected.length >= blockMax || bytes + size(group) > limit)) break;
          if (!unitStillMatches(group)) {
            unsent.delete(group); state.total--; totalChars -= group.length; state.skipped = (state.skipped || 0) + 1;
            continue;
          }
          selected.push(group); bytes += size(group);
          if (!batching) break;
        }
        if (selected.length >= maxItems || !batching || selected.length < block.groups.length) break;
      }
      for (const group of selected) unsent.delete(group);
      cursor += selected.length;
      return selected;
    }
    function chooseBatch() {
      if (!scheduling.adaptiveScheduling) {
        const batch = nextBatch(); for (const group of batch) unsent.delete(group); return Promise.resolve(batch);
      }
      const next = planning.then(adaptiveBatch);
      planning = next.then(() => {}, () => {});
      return next;
    }
    function nextBatch() {
      if (!batchingAvailable) return [groups[cursor++]];
      if (scheduling.semanticBatching && state.batchTranslation) {
        const first = groups[cursor], batch = [];
        const limit = cursor === 0 ? Math.min(1800, scheduling.inputTokens) : scheduling.inputTokens;
        const maxItems = cursor === 0 ? 8 : 64;
        const estimateSize = group => {
          group.wireBytes ??= wireSize(group.document) + 18;
          return scheduling.tokenizer === "bytes" ? group.wireBytes : group.wireBytes / 3;
        };
        let bytes = 0;
        while (cursor < groups.length && batch.length < maxItems) {
          const group = groups[cursor];
          // Remote tokenizers do the exact packing in the background. This is
          // only a planning estimate; the bytes mode is a conservative bound.
          const estimate = estimateSize(group);
          if (batch.length && (group.component !== first.component || group.priority !== first.priority || bytes + estimate > limit)) break;
          if (batch.length && group.semanticUnit && group.semanticUnit !== batch.at(-1).semanticUnit) {
            let end = cursor, unitSize = 0;
            while (end < groups.length && end - cursor <= 64 && groups[end].semanticUnit === group.semanticUnit) unitSize += estimateSize(groups[end++]);
            // Keep a table row/list item together when it fits a fresh request.
            if (unitSize <= limit && (bytes + unitSize > limit || batch.length + end - cursor > maxItems)) break;
          }
          batch.push(group); cursor++; bytes += estimate;
        }
        return batch;
      }
      const visible = viewportDistance(groups[cursor]) === 0;
      const limit = !state.batchTranslation || cursor === 0 ? 1 : cursor < 3 ? 2 : visible ? 4 : 16;
      const batch = [];
      let size = 0;
      while (cursor < groups.length && batch.length < limit) {
        const group = groups[cursor], nextSize = visible ? JSON.stringify(group.document).length : 0;
        if (batch.length && ((viewportDistance(group) === 0) !== visible || visible && size + nextSize > 1200)) break;
        batch.push(group); cursor++; size += nextSize;
      }
      return batch;
    }
    async function worker() {
      while (run === generation && unsent.size) {
        const batch = await chooseBatch();
        if (run !== generation) return;
        if (!batch.length) { updateProgress(); continue; }
        const requestId = `page-${run}-${++requestSequence}`;
        const length = batch.reduce((sum, group) => sum + group.length, 0);
        const progress = { length, completed: 0, deliveredChars: 0, remaining: new Set(batch.map((_, index) => index)), phase: "preparing", since: Date.now() };
        activeProgress.set(requestId, progress);
        const accept = (index, response) => {
          if (!Number.isInteger(index) || !progress.remaining.has(index)) return;
          const group = batch[index];
          if (response.error && response.errorCode === "structure") {
            state.failed++; state.message = response.error;
          } else {
            if (response.error) throw new Error(response.error);
            if (!response.document) throw new Error("翻訳結果が不正です。");
            if (applyDocument(group, response.document)) appliedDirection = `${source}:${target}`;
            else { state.failed++; state.message = "更新された段落は適用していません"; }
          }
          progress.remaining.delete(index); progress.deliveredChars += group.length; state.done++;
        };
        progressListeners.set(requestId, value => {
          if (run !== generation) return;
          progress.completed = Math.max(progress.completed, Math.min(length, value.completed));
          if (Number.isFinite(value.receivedCharacters)) progress.receivedCharacters = value.receivedCharacters;
          if (["queued", "translating", "tokenizing", "preparing", "retrying", "receiving"].includes(value.phase) && progress.phase !== value.phase) {
            progress.phase = value.phase; progress.since = Date.now();
          }
          for (const result of value.results || []) accept(result.index, result);
          updateProgress();
        });
        updateProgress();
        try {
          const response = await browser.runtime.sendMessage({ type: "translate", protocol: PROTOCOL, requestId, sessionId: `${run}-${state.startedAt}`, sessionStartedAt: state.startedAt, ...(batch.length > 1 ? { documents: batch.map(group => group.document) } : { document: batch[0].document }), source, target });
          if (state.url !== pageURL()) { currentPage(); return; }
          if (run !== generation) return;
          if (response.error && (batch.length > 1 || response.errorCode !== "structure")) throw new Error(response.error);
          if (response.batchFallback) batchingAvailable = false;
          const responses = batch.length > 1 ? response.documents : [response];
          if (!responses || responses.length !== batch.length) throw new Error("翻訳結果が不正です。");
          responses.forEach((result, index) => accept(index, result));
        } catch (error) {
          if (run !== generation) return;
          state.failed++; state.message = error.message;
          // A failed connection should not produce hundreds of identical calls.
          state.running = false; state.finishedAt = Date.now(); generation++; clearActivity();
          browser.runtime.sendMessage({ type: "cancel" }).catch(() => {});
          statusPanel(); return;
        } finally { progressListeners.delete(requestId); }
        activeProgress.delete(requestId); completedChars += length;
        updateProgress();
      }
    }
    await Promise.all(Array.from({ length: Math.min(state.concurrency, Math.max(1, groups.length)) }, worker));
    if (run === generation) {
      state.running = false; clearActivity();
      state.finishedAt = Date.now();
      state.message = state.failed ? "一部の段落を適用できませんでした" : state.skipped ? `更新・非表示の${state.skipped}段落を見送りました` : groups.length ? "" : "翻訳対象がありません";
      statusPanel();
    }
  }
  const wireEncoder = new TextEncoder();
  function wireSize(nodes) {
    return nodes.reduce((size, node) => size + (node.text !== undefined
      ? wireEncoder.encode(node.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")).length
      : wireEncoder.encode(`<${node.tag} id="${node.id}"${node.protected ? ' translate="no"' : ""}></${node.tag}>`).length + wireSize(node.children)), 0);
  }
  function hoverRecord(event) {
    const caret = document.caretPositionFromPoint?.(event.clientX, event.clientY);
    const hit = node => {
      const record = records.get(node);
      if (!record || node.data !== record.translated) return null;
      const range = document.createRange(); range.selectNodeContents(node);
      const anchor = [...range.getClientRects()].find(r => event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom);
      return anchor ? { group: record.group, anchor } : null;
    };
    const record = caret && hit(caret.offsetNode);
    if (record) return record;
    // caretPositionFromPoint may stop at a shadow host. The composed event path
    // still contains elements inside an open shadow root.
    for (const element of event.composedPath()) {
      if (element.nodeType !== Node.ELEMENT_NODE) continue;
      for (const node of element.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) { const found = hit(node); if (found) return found; }
      }
    }
    return null;
  }
  function scheduleHide() {
    clearTimeout(showTimer); hoverCandidate = null;
    if (pinned || !tooltip || hideTimer || tooltip.contains(shadow.activeElement)) return;
    hideTimer = setTimeout(clearTooltip, 220);
  }
  function positionNear(element, anchor) {
    const rect = element.getBoundingClientRect();
    const above = anchor.top - rect.height - 8;
    Object.assign(element.style, {
      right: "auto", bottom: "auto",
      left: `${Math.max(12, Math.min(anchor.left, innerWidth - rect.width - 12))}px`,
      top: `${Math.max(12, above >= 12 ? above : Math.min(anchor.bottom + 8, innerHeight - rect.height - 12))}px`
    });
  }
  function showOriginal(group, anchor) {
    clearTooltip(); ui(); lastHover = group;
    marks = document.createElement("div"); marks.setAttribute("aria-hidden", "true");
    for (const node of group.nodes) {
      if (!node.isConnected || node.data !== records.get(node)?.translated) continue;
      const range = document.createRange(); range.selectNodeContents(node);
      for (const rect of [...range.getClientRects()].slice(0, 100)) {
        if (rect.bottom < 0 || rect.top > innerHeight) continue;
        const mark = document.createElement("div"); mark.className = "mark";
        Object.assign(mark.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` }); marks.append(mark);
      }
    }
    shadow.append(marks);
    tooltip = document.createElement("aside"); tooltip.className = "box tooltip"; tooltip.setAttribute("role", "dialog"); tooltip.setAttribute("aria-label", "原文");
    const header = document.createElement("div"); header.className = "heading";
    const label = document.createElement("small"); label.textContent = "原文";
    const tools = document.createElement("div"); tools.className = "tools";
    const pin = button("固定", () => { pinned = !pinned; pin.setAttribute("aria-pressed", String(pinned)); });
    pin.className = "icon"; pin.setAttribute("aria-pressed", "false");
    if (preferences.copyButton) tools.append(copyButton(() => group.originalBlock));
    tools.append(pin, closeButton(clearTooltip)); header.append(label, tools);
    const text = document.createElement("p"); text.className = "original"; text.dir = "auto"; text.lang = group.source === "auto" ? "" : group.source || ""; text.textContent = group.originalBlock;
    tooltip.append(header, text); shadow.append(tooltip);
    positionNear(tooltip, anchor);
    tooltip.addEventListener("pointerenter", () => { clearTimeout(hideTimer); hideTimer = null; clearTimeout(showTimer); });
    tooltip.addEventListener("pointerleave", () => {
      const selection = shadow.getSelection?.() || getSelection();
      if (selection && !selection.isCollapsed) return;
      scheduleHide();
    });
    tooltip.addEventListener("pointerup", () => {
      const selection = shadow.getSelection?.() || getSelection();
      if (selection && !selection.isCollapsed) { pinned = true; pin.setAttribute("aria-pressed", "true"); }
    });
    tooltip.addEventListener("focusin", () => { clearTimeout(hideTimer); hideTimer = null; });
    tooltip.addEventListener("focusout", event => { if (!tooltip?.contains(event.relatedTarget)) scheduleHide(); });
  }
  document.addEventListener("pointermove", event => {
    if (event.composedPath().includes(host)) return;
    if (!records.size) return;
    if (!state.hoverEnabled || event.buttons || event.pointerType === "touch" || !getSelection()?.isCollapsed) { if (!pinned) scheduleHide(); return; }
    if (pinned) return;
    const match = hoverRecord(event);
    if (!match) { scheduleHide(); return; }
    clearTimeout(hideTimer); hideTimer = null;
    if (lastHover === match.group || hoverCandidate === match.group) return;
    clearTimeout(showTimer); hoverCandidate = match.group; hoverAnchor = match.anchor;
    showTimer = setTimeout(() => showOriginal(match.group, hoverAnchor), 280);
  }, { passive: true });
  document.addEventListener("pointerdown", event => { if (!event.composedPath().includes(host)) clearTooltip(); }, { passive: true });
  document.addEventListener("scroll", clearTooltip, { passive: true, capture: true });
  document.addEventListener("pointerout", event => { if (!event.relatedTarget && !pinned) scheduleHide(); });
  addEventListener("resize", clearTooltip);
  addEventListener("blur", clearTooltip);
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      clearLauncher();
      if (tooltip || hoverCandidate) clearTooltip(); else closePanel();
    }
    if (event.key === "F2" && preferences.focusOriginal && tooltip && originalFocus) {
      event.preventDefault(); pinned = true; tooltip.querySelector("[aria-pressed]").setAttribute("aria-pressed", "true");
      tooltip.tabIndex = -1; tooltip.focus({ preventScroll: true });
    }
  });
  let returningFocus = false;
  document.addEventListener("focusin", event => {
    if (returningFocus || !preferences.focusOriginal || event.composedPath().includes(host)) return;
    const element = event.composedPath()[0];
    if (!element?.matches?.('a,button,[tabindex]') || pinned) return;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const record = records.get(node);
      if (!record || node.data !== record.translated) continue;
      showOriginal(record.group, element.getBoundingClientRect()); originalFocus = element; return;
    }
  });
  document.addEventListener("focusout", event => {
    if (event.composedPath().includes(host) || !originalFocus || pinned) return;
    // Allow F2 to move focus into the original's dialog before deciding to hide it.
    setTimeout(() => {
      if (tooltip && !tooltip.contains(shadow.activeElement) && document.activeElement !== originalFocus) clearTooltip();
    }, 0);
  });

  function clearLauncher() { clearTimeout(launcherTimer); launcher?.remove(); launcher = null; }
  let selecting = false;
  function scheduleLauncher() {
    clearLauncher();
    if (!preferences.selectionButton || selecting || panelKind === "selection") return;
    launcherTimer = setTimeout(() => {
      if (!preferences.selectionButton || selecting || panelKind === "selection") return;
      const selected = getSelection();
      if (!selected || selected.isCollapsed || !selected.rangeCount || !selected.toString().trim()) return;
      const range = selected.getRangeAt(0);
      for (const endpoint of [range.startContainer, range.endContainer, range.commonAncestorContainer]) {
        for (let el = endpoint.nodeType === Node.ELEMENT_NODE ? endpoint : parentElement(endpoint); el; el = parentElement(el)) {
          if (el === host || el.matches('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="searchbox"],[role="combobox"]')) return;
        }
      }
      const anchor = range.getBoundingClientRect?.();
      if (!anchor || !anchor.width || anchor.bottom <= 0 || anchor.top >= innerHeight) return;
      const text = selected.toString(); ui();
      launcher = button("翻訳", () => {
        clearLauncher(); selection({ text, anchor }).catch(error => box("選択範囲を翻訳").append(document.createTextNode(error.message)));
      });
      launcher.className = "box launcher"; launcher.setAttribute("aria-label", "選択したテキストを翻訳");
      launcher.addEventListener("pointerdown", event => event.preventDefault());
      shadow.append(launcher); positionNear(launcher, anchor);
    }, 200);
  }
  document.addEventListener("selectionchange", scheduleLauncher);
  document.addEventListener("pointerdown", event => { if (!event.composedPath().includes(host)) { selecting = true; clearLauncher(); } }, { passive: true });
  document.addEventListener("pointerup", event => { selecting = false; if (!event.composedPath().includes(host)) scheduleLauncher(); }, { passive: true });
  document.addEventListener("scroll", clearLauncher, { passive: true, capture: true });
  addEventListener("resize", clearLauncher); addEventListener("blur", () => { selecting = false; clearLauncher(); });

  async function selection(message) {
    currentPage();
    const text = message.text || getSelection()?.toString();
    if (!text?.trim()) throw new Error("ページ上で翻訳したい文章を選択してください。");
    const beforePreferences = generation;
    await readPreferences();
    if (beforePreferences !== generation) return;
    clearLauncher();
    if (!state.source) state.source = message.defaults?.source || message.source || "en";
    if (!state.target) state.target = message.defaults?.target || message.target || "ja";
    if (message.source) state.source = message.source;
    if (message.target) state.target = message.target;
    if (state.running) stop();
    clearTooltip();
    const range = getSelection()?.rangeCount ? getSelection().getRangeAt(0) : null;
    const anchor = message.anchor || range?.getBoundingClientRect?.();
    const visibleAnchor = anchor?.width > 0 && anchor.bottom > 0 && anchor.top < innerHeight ? anchor : null;
    const previousFocus = document.activeElement;
    const node = box("選択範囲を翻訳");
    const languages = document.createElement("div"); languages.className = "languages"; node.append(languages);
    const names = new Intl.DisplayNames(["ja"], { type: "language" });
    const languageCodes = "ja en zh-hans zh-hant ko ar az be bg bn ca ceb de es et eu fa fr gu he hi hr hu hy id it jv ka kk km lt lv ml mr ms my ne nl pa pl ru si sk sl sr sw ta te th tl ur uz vi".split(" ");
    function select(label, value, codes) {
      const wrapper = document.createElement("label"); wrapper.textContent = label + " ";
      const control = document.createElement("select");
      for (const code of codes) { const option = document.createElement("option"); option.value = code; option.textContent = code === "auto" ? "自動判定" : names.of(code); control.append(option); }
      control.value = value; wrapper.append(control); languages.append(wrapper); return control;
    }
    const source = select("原文", state.source, ["auto", ...languageCodes]);
    const swap = button("⇄", () => {
      [source.value, target.value] = [target.value, source.value];
    });
    swap.className = "icon"; swap.setAttribute("aria-label", "言語を入れ替える"); swap.title = "言語を入れ替える";
    languages.append(swap);
    const target = select("訳文", state.target, languageCodes);
    source.addEventListener("change", () => { swap.disabled = busy || source.value === "auto"; });
    const original = document.createElement("details"); const summary = document.createElement("summary"); summary.textContent = "原文";
    const originalText = document.createElement("p"); originalText.dir = "auto"; originalText.textContent = text; original.append(summary, originalText);
    const result = document.createElement("p"); result.className = "result"; result.dir = "auto"; result.setAttribute("aria-live", "polite");
    const progress = progressView(); progress.label.textContent = "翻訳中";
    const actions = document.createElement("div"); actions.className = "actions";
    let request = 0, requestId, busy = false, elapsedTimer;
    const copy = copyButton(() => result.textContent); copy.disabled = true;
    const cancel = () => {
      request++; busy = false; progressListeners.delete(requestId); clearInterval(elapsedTimer);
      copy.disabled = true;
      result.setAttribute("aria-live", "polite"); result.setAttribute("aria-busy", "false");
      browser.runtime.sendMessage({ type: "cancel" }).catch(() => {});
    };
    selectionCleanup = () => { cancel(); if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true }); };
    const action = button("停止", () => {
      if (busy) {
        cancel(); progress.node.hidden = true; result.hidden = false; result.textContent = "停止しました";
        action.textContent = "再翻訳"; source.disabled = false; target.disabled = false; swap.disabled = source.value === "auto";
      } else run();
    }); action.className = "primary";
    const run = async () => {
      const id = ++request;
      requestId = `selection-${++requestSequence}`;
      const currentId = requestId;
      const startedAt = Date.now();
      busy = true; source.disabled = true; target.disabled = true; swap.disabled = true;
      state.source = source.value; state.target = target.value;
      copy.disabled = true; copy.textContent = "コピー";
      originalText.lang = source.value === "auto" ? "" : source.value; result.lang = target.value;
      result.hidden = true; result.textContent = ""; result.classList.remove("error"); result.setAttribute("aria-live", "off"); result.setAttribute("aria-busy", "true"); progress.node.hidden = false;
      progress.bar.value = 0; progress.percent.textContent = "0%"; progress.count.textContent = "";
      progress.label.textContent = "翻訳中";
      progress.elapsed.textContent = "0秒"; action.textContent = "停止";
      elapsedTimer = setInterval(() => { progress.elapsed.textContent = `${Math.floor((Date.now() - startedAt) / 1000)}秒`; }, 1000);
      progressListeners.set(currentId, value => {
        if (id !== request || !node.isConnected) return;
        const percent = Math.min(100, Math.floor(value.completed / Math.max(1, value.total) * 100));
        progress.bar.value = percent; progress.percent.textContent = `${percent}%`;
        if (value.phase === "receiving") progress.label.textContent = `訳文を受信中${value.receivedCharacters ? ` · ${value.receivedCharacters}文字` : ""}`;
        if (typeof value.preview === "string") { result.textContent = value.preview; result.hidden = false; }
      });
      try {
        const response = await browser.runtime.sendMessage({ type: "translate", protocol: PROTOCOL, requestId: currentId, parts: [text], source: source.value, target: target.value });
        if (id !== request || !node.isConnected) return;
        result.classList.toggle("error", !!response.error);
        result.textContent = response.error || response.parts[0];
        copy.disabled = !!response.error;
      } catch (error) { if (id === request) { result.textContent = error.message; result.classList.add("error"); } }
      finally {
        progressListeners.delete(currentId);
        if (id === request) {
          result.setAttribute("aria-live", "polite"); result.setAttribute("aria-busy", "false");
          clearInterval(elapsedTimer); busy = false; progress.node.hidden = true; result.hidden = false;
          action.textContent = "再翻訳"; source.disabled = false; target.disabled = false; swap.disabled = source.value === "auto";
          if (visibleAnchor) positionNear(node, visibleAnchor);
        }
      }
    };
    if (preferences.copyButton) actions.append(copy);
    actions.append(action); node.append(original, progress.node, result, actions);
    if (visibleAnchor) positionNear(node, visibleAnchor);
    node.tabIndex = -1; node.focus({ preventScroll: true });
    await run();
  }
  browser.runtime.onMessage.addListener(async message => {
    currentPage();
    try {
      if (message.type === "ping") return { ok: true, protocol: PROTOCOL };
      if (message.type === "translationProgress") {
        if (Number.isFinite(message.completed) && message.completed >= 0 && Number.isFinite(message.total) && message.total > 0) progressListeners.get(message.requestId)?.(message);
        return { ok: true };
      }
      if (message.type === "hover") {
        state.hoverEnabled = message.hoverEnabled !== false;
        if (!state.hoverEnabled) clearTooltip();
        return { ...state };
      }
      if (message.type === "status") return { ...state, translated: records.size };
      if (message.type === "preferencesChanged") { applyPreferences(message.preferences); return { ok: true }; }
      if (message.type === "restoreCache") {
        await readPreferences();
        // A pending cache lookup must never override a manual action or a new URL.
        if (message.url !== state.url || state.source || state.running || records.size) return { ...state };
        state.source = message.source; state.target = message.target;
        const entries = new Map(message.entries.map(entry => [entry.input, entry.document]));
        const run = generation;
        const groups = await collect(run);
        if (run !== generation) return { ...state };
        let restored = 0, restoredChars = 0;
        for (const group of groups) {
          const tree = entries.get(JSON.stringify(group.document));
          if (tree && applyDocument(group, tree)) { restored++; restoredChars += group.length; }
        }
        if (restored) {
          appliedDirection = `${state.source}:${state.target}`;
          state.done = restored; state.total = groups.length;
          state.percent = Math.floor(restoredChars / groups.reduce((sum, group) => sum + group.length, 0) * 100);
          state.cacheRestored = true;
          state.message = "保存した訳文を復元しました";
        } else { state.source = null; state.target = null; }
        return { ...state };
      }
      if (message.type === "configure") {
        if ((state.source && state.source !== message.source || state.target && state.target !== message.target) && records.size) restore();
        state.source = message.source; state.target = message.target;
        return { ...state };
      }
      if (message.type === "start") {
        const beforePreferences = generation;
        const prefs = await readPreferences();
        if (beforePreferences !== generation) return { ...state };
        if (prefs.error) throw new Error(prefs.error);
        state.batchTranslation = prefs.batchTranslation === true;
        state.concurrency = prefs.concurrency || message.concurrency || 1;
        // Don't keep the popup alive for the whole page translation.
        translatePage(message.source, message.target).catch(error => { state.running = false; state.preparing = false; state.finishedAt = Date.now(); state.message = error.message; statusPanel(); });
        return { ...state };
      }
      if (message.type === "stop") { stop(); return { ...state }; }
      if (message.type === "restore") { restore(); return { ...state }; }
      if (message.type === "selection") { selection(message).catch(error => { box("選択範囲を翻訳").append(document.createTextNode(error.message)); }); return { ok: true }; }
      throw new Error("不明な操作です。");
    } catch (error) { return { error: error.message }; }
  });
  readPreferences().catch(() => {});
  addEventListener("pagehide", () => browser.runtime.sendMessage({ type: "cancel" }).catch(() => {}));
})();
