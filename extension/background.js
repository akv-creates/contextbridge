// Background service worker — minimal. All real work happens in popup.js via executeScript.
// This file is required by manifest.json but does nothing for the main capture/inject flow.

console.log('[ContextBridge] Service worker loaded');
