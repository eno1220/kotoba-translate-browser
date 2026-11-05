// Reproduce a page left open across the change from text parts to paragraph HTML.
(() => {
  globalThis.__kotobaLoaded = true;
  const state = { running: false, done: 0, total: 1, failed: 0, message: "", translated: 0 };
  browser.runtime.onMessage.addListener(async message => {
    if (message.type === "ping") return { ok: true };
    if (message.type === "status") return { ...state };
    if (message.type === "start") {
      const response = await browser.runtime.sendMessage({ type: "translate", parts: ["Read ", "the documentation", " carefully."], source: "en", target: "ja" });
      state.message = response.error || ""; state.failed = response.error ? 1 : 0;
      return { ...state };
    }
  });
})();
