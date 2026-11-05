/* global browser */
// Only checks for existing translations; never starts an API request.
browser.runtime.sendMessage({ type: "restoreCachedPage" }).catch(() => {});
