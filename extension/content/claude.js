// Content script for Claude.ai — passive observer only; scraping/injection done via executeScript in background.js.

(function () {
  if (window.__contextBridgeClaude) return;
  window.__contextBridgeClaude = true;

  // MutationObserver keeps page activity fresh for dynamic message loading.
  const observer = new MutationObserver(() => {});
  observer.observe(document.body, { childList: true, subtree: true });
})();
