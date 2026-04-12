// Content script for ChatGPT — passive observer only; scraping/injection done via executeScript in background.js.

(function () {
  if (window.__contextBridgeChatGPT) return;
  window.__contextBridgeChatGPT = true;

  // MutationObserver keeps page activity fresh for dynamic message loading.
  const observer = new MutationObserver(() => {});
  observer.observe(document.body, { childList: true, subtree: true });
})();
