/* global browser */
(() => {
  if (globalThis.__kotobaLoaded) return;
  globalThis.__kotobaLoaded = true;
  const SKIP = new Set("SCRIPT STYLE NOSCRIPT TEMPLATE PRE CODE KBD SAMP VAR TEXTAREA INPUT SELECT OPTION BUTTON SVG MATH CANVAS VIDEO AUDIO IFRAME OBJECT EMBED".split(" "));
  const INLINE_CODE = new Set(["CODE", "KBD", "SAMP", "VAR"]);
  const records = new Map();
  let state = { url: location.href, source: null, target: null, running: false, done: 0, total: 0, failed: 0, message: "", concurrency: 1, percent: 0, startedAt: 0, finishedAt: 0, hoverEnabled: true };
  let generation = 0, panel, tooltip, host, shadow, lastHover;
  let appliedDirection = null;
  let panelKind, pageUI, pageDismissed = false, panelTimer, selectionCleanup;
  let showTimer, hideTimer, hoverCandidate, hoverAnchor, pinned = false, marks;
  let requestSequence = 0;
  const progressListeners = new Map();

  function ui() {
    if (host?.isConnected) return;
    host = document.createElement("div");
    host.dataset.kotobaUi = "true";
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
      h2 { margin:0; font-size:13px; font-weight:600; } p { margin:8px 0; white-space:pre-wrap; } small { color:#71717a; }
      button { display:inline-flex; align-items:center; justify-content:center; min-height:30px; font:inherit; font-size:12px; font-weight:500; border:1px solid #dedee3; border-radius:5px; padding:4px 10px; background:#fff; color:#52525b; cursor:pointer; }
      button:hover { background:#f4f4f5; } button.primary { color:#fff; border-color:#087fdb; background:#087fdb; } button.primary:hover { background:#006fc5; }
      button:disabled { opacity:.45; cursor:default; } button:focus-visible,select:focus-visible,summary:focus-visible { outline:2px solid #38bdf8; outline-offset:2px; }
      button.icon { border:0; background:transparent; min-height:24px; min-width:24px; padding:0 4px; color:#71717a; }
      button.icon:hover,button[aria-pressed="true"] { color:#087fdb; background:#f0f9ff; }
      .close { font-size:20px; line-height:1; } .tools,.actions { display:flex; align-items:center; gap:8px; } .actions { margin-top:12px; justify-content:flex-end; }
      select { width:100%; min-width:0; font:inherit; padding:7px 8px; background:white; color:#27272a; border:1px solid #dedee3; border-radius:5px; }
      .languages { display:flex; gap:12px; margin-bottom:12px; } label { display:block; flex:1; min-width:0; font-size:11px; color:#71717a; } label select { margin-top:4px; font-size:12px; }
      .result { border-top:1px solid #e4e4e7; padding-top:12px; font-size:14px; line-height:1.8; user-select:text; }
      .error { color:#b42318; font-size:12px; } .message:empty { display:none; }
      .progress-label,.progress-detail { display:flex; justify-content:space-between; align-items:center; gap:10px; font-size:12px; }
      .progress-label strong { color:#087fdb; font-variant-numeric:tabular-nums; font-weight:600; }
      .progress-detail { font-size:11px; color:#71717a; margin-top:6px; font-variant-numeric:tabular-nums; }
      progress { display:block; appearance:none; width:100%; height:4px; border:0; border-radius:3px; overflow:hidden; background:#e4e4e7; margin-top:8px; }
      progress::-moz-progress-bar { background:#0ba5ec; border-radius:3px; }
      details { font-size:12px; color:#71717a; } summary { cursor:pointer; } details p { color:#52525b; max-height:150px; overflow:auto; }
      .mark { position:fixed; pointer-events:none; border-radius:2px; background:#0ea5e91a; border-bottom:1px solid #0ea5e955; }
      .original { margin:0; font-size:14px; line-height:1.75; user-select:text; } .tooltip .heading { margin-bottom:6px; }
      [hidden] { display:none!important; }
    `;
    shadow.append(style);
    document.documentElement.append(host);
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
    node.append(header, bar, detail);
    return { node, label, percent, bar, count, elapsed };
  }
  function statusPanel() {
    if (pageDismissed || panelKind === "selection") return;
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
    pageUI.label.textContent = state.running ? "翻訳中" : state.failed ? "一部未翻訳" : state.percent === 100 ? "翻訳完了" : state.total ? "停止中" : "対象なし";
    pageUI.bar.value = state.percent; pageUI.percent.textContent = `${state.percent}%`;
    pageUI.count.textContent = `${state.done} / ${state.total} 段落`;
    pageUI.elapsed.textContent = state.startedAt ? `${Math.floor(((state.finishedAt || Date.now()) - state.startedAt) / 1000)}秒` : "";
    pageUI.message.textContent = state.failed || !state.total ? state.message : "";
    pageUI.message.classList.toggle("error", state.failed > 0);
    pageUI.action.textContent = state.running ? "停止" : state.failed ? "再試行" : "再開";
    pageUI.action.hidden = !state.running && (!state.total || state.percent === 100 && !state.failed);
    pageUI.original.disabled = !records.size && !state.running;
    if (!state.running) { clearInterval(panelTimer); panelTimer = null; }
  }
  function clearTooltip() {
    clearTimeout(showTimer); clearTimeout(hideTimer); showTimer = null; hideTimer = null; hoverCandidate = null;
    tooltip?.remove(); marks?.remove(); tooltip = null; marks = null; lastHover = null; pinned = false;
  }
  function currentPage() {
    if (state.url !== location.href) {
      stop(); restore();
      state = { ...state, url: location.href, source: null, target: null, done: 0, total: 0, failed: 0, message: "", percent: 0, startedAt: 0, finishedAt: 0 };
    }
  }
  function stop() {
    generation++;
    state.running = false;
    state.finishedAt = Date.now(); state.message = "停止しました";
    browser.runtime.sendMessage({ type: "cancel" }).catch(() => {});
    if (panel) statusPanel();
  }
  function restore() {
    stop(); clearTooltip();
    for (const [node, record] of records) {
      // Never restore an outdated snapshot over a site's own update.
      if (node.isConnected && node.data === record.translated) node.data = record.original;
    }
    records.clear(); appliedDirection = null; state.done = 0; state.total = 0; state.failed = 0; state.percent = 0; state.startedAt = 0; state.finishedAt = 0;
    state.message = "原文に戻しました";
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
  function prose(text, element) {
    const value = text.trim();
    if (!/\p{L}/u.test(value)) return false;
    if (/^(?:(?:https?:\/\/|www\.)\S+|[^\s@]+@[^\s@]+\.[^\s@]+|(?:\/|\.\/|\.\.\/)[\w./@%+~#?=&:-]+)$/u.test(value)) return false;
    const lang = language(element);
    if (lang && sameLanguage(lang, state.target)) return false;
    // Avoid re-translating unlabelled Japanese/Korean prose into the same language.
    if (state.target === "ja" && /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(value) && !/[a-zA-Z]{4}/.test(value)) return false;
    if (state.target === "ko" && /\p{Script=Hangul}/u.test(value) && !/[a-zA-Z]{4}/.test(value)) return false;
    return true;
  }
  function collect() {
    const groups = [];
    const styleCache = new WeakMap();
    const computed = el => { if (!styleCache.has(el)) styleCache.set(el, getComputedStyle(el)); return styleCache.get(el); };
    const isBlock = el => /^(block|flow-root|flex|grid|list-item|table-cell|table-caption|table-row|inline-block|inline-flex|inline-grid)$/.test(computed(el).display) || /^(P|H[1-6]|LI|DT|DD|TD|TH|BLOCKQUOTE|FIGCAPTION|SUMMARY|HR)$/.test(el.tagName);
    let group = null;
    const boundary = () => { group = null; };
    function append(node, original, block, protectedPart = false) {
      if (!group || group.block !== block || group.root !== node.getRootNode() || group.nodes.length >= 200 || group.size + original.length > 100000) {
        group = { block, root: node.getRootNode(), nodes: [], size: 0 }; groups.push(group);
      }
      group.nodes.push({ node, original, protectedPart }); group.size += original.length;
    }
    function walk(element, block) {
      if (element === host || SKIP.has(element.tagName) && !INLINE_CODE.has(element.tagName) || element.matches('[data-kotoba-ui],.notranslate,[translate="no"],[hidden],[inert],[aria-hidden="true"],[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="searchbox"],[role="combobox"]')) { boundary(); return; }
      const css = computed(element);
      if (css.display === "none" || css.visibility !== "visible" || css.opacity === "0") { boundary(); return; }
      if (INLINE_CODE.has(element.tagName)) {
        if (!css.display.startsWith("inline") || !element.textContent.trim() || element.textContent.length > 10000) boundary();
        else append(element, element.textContent, block, true);
        return;
      }
      if (isBlock(element)) { block = element; boundary(); }
      if (element.shadowRoot) {
        // Traverse rendered light DOM through <slot>, avoiding duplicate content.
        for (const child of element.shadowRoot.children) walk(child, block);
      } else {
        const children = element.tagName === "SLOT" && element.assignedNodes().length ? element.assignedNodes({ flatten: true }) : element.childNodes;
        for (const node of children) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.tagName === "BR") boundary(); else walk(node, block);
          } else if (node.nodeType === Node.TEXT_NODE && node.data.trim()) {
            const record = records.get(node);
            if (record && node.data === record.translated) { boundary(); continue; }
            records.delete(node);
            if (!prose(node.data, element)) { boundary(); continue; }
            const range = document.createRange(); range.selectNodeContents(node);
            if (![...range.getClientRects()].some(rect => rect.width > 0 && rect.height > 0)) continue;
            append(node, node.data, block);
          }
        }
      }
      if (isBlock(element)) boundary();
    }
    if (document.body) walk(document.body, document.body);
    return groups.filter(group => group.nodes.some(node => !node.protectedPart));
  }
  async function translatePage(source, target) {
    currentPage();
    if (state.running) return { ...state };
    if (appliedDirection && appliedDirection !== `${source}:${target}`) restore();
    state.source = source; state.target = target;
    const groups = collect();
    const run = ++generation;
    state.running = true; state.done = 0; state.total = groups.length; state.failed = 0;
    state.percent = 0; state.startedAt = Date.now(); state.finishedAt = 0;
    state.message = groups.length ? "" : "翻訳対象がありません";
    if (panelKind === "selection") closePanel();
    pageDismissed = false; clearTooltip();
    const totalChars = groups.reduce((sum, group) => sum + group.nodes.reduce((n, item) => n + (item.protectedPart ? 0 : item.original.length), 0), 0);
    let completedChars = 0;
    const activeProgress = new Map();
    const updateProgress = () => {
      if (run !== generation) return;
      state.percent = totalChars ? Math.min(100, Math.floor((completedChars + [...activeProgress.values()].reduce((a, b) => a + b, 0)) / totalChars * 100)) : 0;
      statusPanel();
    };
    statusPanel();
    let cursor = 0;
    async function worker() {
      while (run === generation && cursor < groups.length) {
        const group = groups[cursor++];
        const requestId = `page-${run}-${++requestSequence}`;
        const length = group.nodes.reduce((sum, item) => sum + (item.protectedPart ? 0 : item.original.length), 0);
        progressListeners.set(requestId, progress => {
          if (run !== generation) return;
          activeProgress.set(requestId, Math.max(activeProgress.get(requestId) || 0, Math.min(length, progress.completed)));
          updateProgress();
        });
        try {
          const response = await browser.runtime.sendMessage({ type: "translate", requestId, parts: group.nodes.map(n => n.original), protectedParts: group.nodes.map(n => n.protectedPart), source, target });
          if (state.url !== location.href) { currentPage(); return; }
          if (run !== generation) return;
          if (response.error) throw new Error(response.error);
          if (!response.parts || response.parts.length !== group.nodes.length) throw new Error("翻訳結果の数が一致しません。");
          // Atomic per paragraph: don't mix a response with a live site update.
          if (group.nodes.every(({ node, original, protectedPart }) => node.isConnected && (protectedPart ? node.textContent : node.data) === original)) {
            const range = document.createRange();
            range.setStartBefore(group.nodes[0].node); range.setEndAfter(group.nodes.at(-1).node);
            const originalBlock = range.toString();
            const translatedGroup = { originalBlock, nodes: group.nodes.filter(item => !item.protectedPart).map(item => item.node) };
            appliedDirection = `${source}:${target}`;
            group.nodes.forEach(({ node, original, protectedPart }, i) => {
              if (protectedPart) return;
              node.data = response.parts[i];
              records.set(node, { original, translated: node.data, group: translatedGroup });
            });
          } else { state.failed++; state.message = "更新された段落は適用していません"; }
        } catch (error) {
          if (run !== generation) return;
          state.failed++; state.message = error.message;
          // A failed connection should not produce hundreds of identical calls.
          state.running = false; state.finishedAt = Date.now(); generation++;
          browser.runtime.sendMessage({ type: "cancel" }).catch(() => {});
          statusPanel(); return;
        } finally { progressListeners.delete(requestId); }
        activeProgress.delete(requestId); completedChars += length;
        state.done++; updateProgress();
      }
    }
    await Promise.all(Array.from({ length: Math.min(state.concurrency, Math.max(1, groups.length)) }, worker));
    if (run === generation) {
      state.running = false;
      state.finishedAt = Date.now();
      state.message = state.failed ? "一部の段落を適用できませんでした" : groups.length ? "" : "翻訳対象がありません";
      statusPanel();
    }
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
    if (pinned || !tooltip || hideTimer) return;
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
    tools.append(pin, closeButton(clearTooltip)); header.append(label, tools);
    const text = document.createElement("p"); text.className = "original"; text.dir = "auto"; text.textContent = group.originalBlock;
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
      if (tooltip || hoverCandidate) clearTooltip(); else closePanel();
    }
  });

  async function selection(message) {
    currentPage();
    const text = message.text || getSelection()?.toString();
    if (!text?.trim()) throw new Error("ページ上で翻訳したい文章を選択してください。");
    if (!state.source) state.source = message.defaults?.source || message.source || "en";
    if (!state.target) state.target = message.defaults?.target || message.target || "ja";
    if (message.source) state.source = message.source;
    if (message.target) state.target = message.target;
    if (state.running) stop();
    clearTooltip();
    const range = getSelection()?.rangeCount ? getSelection().getRangeAt(0) : null;
    const anchor = range?.getBoundingClientRect?.();
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
    const target = select("訳文", state.target, languageCodes);
    const original = document.createElement("details"); const summary = document.createElement("summary"); summary.textContent = "原文";
    const originalText = document.createElement("p"); originalText.dir = "auto"; originalText.textContent = text; original.append(summary, originalText);
    const result = document.createElement("p"); result.className = "result"; result.dir = "auto"; result.setAttribute("aria-live", "polite");
    const progress = progressView(); progress.label.textContent = "翻訳中";
    const actions = document.createElement("div"); actions.className = "actions";
    let request = 0, requestId, busy = false, elapsedTimer;
    const cancel = () => {
      request++; busy = false; progressListeners.delete(requestId); clearInterval(elapsedTimer);
      browser.runtime.sendMessage({ type: "cancel" }).catch(() => {});
    };
    selectionCleanup = () => { cancel(); if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true }); };
    const action = button("停止", () => {
      if (busy) {
        cancel(); progress.node.hidden = true; result.hidden = false; result.textContent = "停止しました";
        action.textContent = "再翻訳"; source.disabled = false; target.disabled = false;
      } else run();
    }); action.className = "primary";
    const run = async () => {
      const id = ++request;
      requestId = `selection-${++requestSequence}`;
      const currentId = requestId;
      const startedAt = Date.now();
      busy = true; source.disabled = true; target.disabled = true;
      state.source = source.value; state.target = target.value;
      result.hidden = true; result.classList.remove("error"); progress.node.hidden = false;
      progress.bar.value = 0; progress.percent.textContent = "0%"; progress.count.textContent = "";
      progress.elapsed.textContent = "0秒"; action.textContent = "停止";
      elapsedTimer = setInterval(() => { progress.elapsed.textContent = `${Math.floor((Date.now() - startedAt) / 1000)}秒`; }, 1000);
      progressListeners.set(currentId, value => {
        const percent = Math.min(100, Math.floor(value.completed / Math.max(1, value.total) * 100));
        progress.bar.value = percent; progress.percent.textContent = `${percent}%`;
      });
      try {
        const response = await browser.runtime.sendMessage({ type: "translate", requestId: currentId, parts: [text], source: source.value, target: target.value });
        if (id !== request || !node.isConnected) return;
        result.classList.toggle("error", !!response.error);
        result.textContent = response.error || response.parts[0];
      } catch (error) { if (id === request) { result.textContent = error.message; result.classList.add("error"); } }
      finally {
        progressListeners.delete(currentId);
        if (id === request) {
          clearInterval(elapsedTimer); busy = false; progress.node.hidden = true; result.hidden = false;
          action.textContent = "再翻訳"; source.disabled = false; target.disabled = false;
          if (visibleAnchor) positionNear(node, visibleAnchor);
        }
      }
    };
    actions.append(action); node.append(original, progress.node, result, actions);
    if (visibleAnchor) positionNear(node, visibleAnchor);
    node.tabIndex = -1; node.focus({ preventScroll: true });
    await run();
  }
  browser.runtime.onMessage.addListener(async message => {
    currentPage();
    try {
      if (message.type === "ping") return { ok: true };
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
      if (message.type === "configure") {
        if ((state.source && state.source !== message.source || state.target && state.target !== message.target) && records.size) restore();
        state.source = message.source; state.target = message.target;
        return { ...state };
      }
      if (message.type === "start") {
        const beforePreferences = generation;
        const prefs = await browser.runtime.sendMessage({ type: "contentPreferences" });
        if (beforePreferences !== generation) return { ...state };
        state.concurrency = prefs.concurrency || message.concurrency || 1;
        // Don't keep the popup alive for the whole page translation.
        translatePage(message.source, message.target).catch(error => { state.running = false; state.message = error.message; statusPanel(); });
        return { ...state };
      }
      if (message.type === "stop") { stop(); return { ...state }; }
      if (message.type === "restore") { restore(); return { ...state }; }
      if (message.type === "selection") { selection(message).catch(error => { box("選択範囲を翻訳").append(document.createTextNode(error.message)); }); return { ok: true }; }
      throw new Error("不明な操作です。");
    } catch (error) { return { error: error.message }; }
  });
  addEventListener("pagehide", () => browser.runtime.sendMessage({ type: "cancel" }).catch(() => {}));
})();
