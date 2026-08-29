// ConteXetu content script for gemini.google.com — passive observer only;
// scraping/injection is done via executeScript from popup.js / background.js
// (same pattern as content/chatgpt.js).

(function () {
  if (window.__contextBridgeGemini) return;
  window.__contextBridgeGemini = true;

  // MutationObserver keeps page activity fresh for dynamic message loading.
  const observer = new MutationObserver(() => {});
  observer.observe(document.body, { childList: true, subtree: true });
})();
