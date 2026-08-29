// ConteXetu content script for claude.ai.
// Intentionally a no-op: claude.ai capture flows through the popup's paste mode
// (and via MCP for Claude Desktop / Claude Code). No DOM scraping here.
(function () {
  if (window.__contextBridgeClaude) return;
  window.__contextBridgeClaude = true;
})();
