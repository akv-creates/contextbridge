// ConteXetu background service worker.
// Handles keyboard shortcut commands and delegates heavy work to popup flow.

importScripts('telemetry.js');

console.log('[ConteXetu] Service worker loaded');

// Fires once per install (not on every browser restart / SW wake) — the
// activation-funnel starting point for the demand-test experiment.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    self.CBTelemetry.trackEvent('install');
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function getStorage(keys) {
  return new Promise((r) => chrome.storage.local.get(keys, r));
}

function notify(title, message, isError) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: isError ? 'icons/icon48.png' : 'icons/icon48.png',
    title: title,
    message: message,
    priority: 1,
  });
}

// ── ChatGPT scraper (mirrors popup.js chatgptScraper, runs via executeScript) ─

function chatgptScraperFn() {
  var turns = [];
  var articles = document.querySelectorAll('article[data-testid^="conversation-turn-"]');
  if (articles.length === 0) {
    articles = document.querySelectorAll('[data-message-author-role]');
  }
  articles.forEach(function (el) {
    var role = el.getAttribute('data-message-author-role');
    if (!role) {
      var testId = el.getAttribute('data-testid') || '';
      role = testId.includes('user') ? 'user' : 'assistant';
    }
    var textEl = el.querySelector('.whitespace-pre-wrap') ||
                 el.querySelector('[data-message-text-content]') ||
                 el;
    var text = (textEl.innerText || textEl.textContent || '').trim();
    if (text) turns.push({ role: role, content: text });
  });
  return turns;
}

// ── Gemini scraper (mirrors popup.js geminiScraper, runs via executeScript) ──

function geminiScraperFn() {
  var turns = [];
  var elements = document.querySelectorAll('user-query, model-response');
  if (elements.length === 0) {
    elements = document.querySelectorAll('.query-text, .model-response-text, message-content');
  }
  elements.forEach(function (el) {
    var tag = el.tagName.toLowerCase();
    var role = (tag === 'user-query' || el.classList.contains('query-text')) ? 'user' : 'assistant';
    var textEl = el;
    if (tag === 'user-query') textEl = el.querySelector('.query-text') || el;
    if (tag === 'model-response') textEl = el.querySelector('message-content') || el.querySelector('.markdown') || el;
    var text = (textEl.innerText || textEl.textContent || '').trim();
    if (text) turns.push({ role: role, content: text });
  });
  return turns;
}

// Shared POST to /context/capture — used by ChatGPT/Gemini scraping and the
// Google Docs/Slides API capture path below.
async function captureMessages(sourceModel, messages) {
  const stored = await getStorage(['BACKEND_URL', 'userId']);
  const backendUrl = stored.BACKEND_URL || 'http://localhost:3001';
  const userId = stored.userId || 'default';

  const res = await fetch(backendUrl + '/context/capture', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_model: sourceModel, user_id: userId, messages }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || ('Backend error ' + res.status));
  }
  return res.json();
}

// Runs the scrape + capture for a given tab (ChatGPT or Gemini), returning
// the backend response (or { error } / { unsupported }). Shared by the
// keyboard command and the floating-bridge panel's "Capture this chat" button.
function scraperForUrl(url) {
  if (url.includes('chatgpt.com')) return { model: 'chatgpt', fn: chatgptScraperFn };
  if (url.includes('gemini.google.com')) return { model: 'gemini', fn: geminiScraperFn };
  return null;
}

async function captureChatGptTab(tab) {
  const url = (tab && tab.url) || '';
  const site = scraperForUrl(url);
  if (!site) {
    return { unsupported: true, error: 'This page is not a ChatGPT or Gemini conversation.' };
  }

  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: site.fn,
    });
  } catch (err) {
    return { error: 'Could not read page: ' + err.message };
  }

  const messages = results?.[0]?.result || [];
  if (messages.length === 0) {
    return { error: 'No conversation found on this page.' };
  }

  try {
    return await captureMessages(site.model, messages);
  } catch (err) {
    return { error: err.message };
  }
}

// Triggers a real browser download of a Google Docs/Slides export URL.
// chrome.downloads uses the full authenticated browsing context — unlike a
// page-initiated fetch, it isn't subject to the page's CSP, CORS, or
// SameSite cookie restrictions, which is why this (not fetch) is the
// reliable path for exporting from docs.google.com.
function downloadGoogleExport(url, filename) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename, saveAs: false }, (downloadId) => {
      if (chrome.runtime.lastError || !downloadId) {
        reject(new Error((chrome.runtime.lastError && chrome.runtime.lastError.message) || 'Download failed to start'));
      } else {
        resolve(downloadId);
      }
    });
  });
}

// Google Docs/Slides capture: trigger the export download via the real
// browsing context (immune to CORS/CSP/SameSite, unlike fetch). Reading the
// downloaded bytes back automatically is NOT possible — confirmed in real
// testing: Chrome blocks any extension-page script (popup, background,
// offscreen document) from reading file:// content via XHR/fetch with
// "Not allowed to load local resource", regardless of the "Allow access to
// file URLs" toggle. That setting grants a different, narrower capability
// (content scripts running on file:// pages you navigate to) — not blanket
// file content reading. So the manual "drop the file into the popup" step
// isn't a fallback for an edge case; it's the only way to finish.
async function captureGoogleExport({ exportUrl, filename }) {
  try {
    await downloadGoogleExport(exportUrl, filename);
  } catch (err) {
    return { error: 'Could not start download: ' + err.message };
  }
  return { downloaded: true, needsManualUpload: true, filename };
}

// ── Google Docs/Slides API capture ─────────────────────────────────────────
// The real fix for automatic Google capture: fetch document content directly
// from Google's REST API (proper CORS support for OAuth bearer-token
// requests, unlike the export endpoint's redirect) instead of exporting a
// file and trying to read it back. Requires manifest.json's "oauth2" block
// to have a real client_id from Google Cloud Console — until that's
// configured, getAuthToken fails and the caller falls back to the
// download+manual-drop flow, which keeps working regardless.

function getGoogleAuthToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: !!interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error((chrome.runtime.lastError && chrome.runtime.lastError.message) || 'No auth token returned'));
      } else {
        resolve(token);
      }
    });
  });
}

function removeCachedAuthToken(token) {
  return new Promise((resolve) => chrome.identity.removeCachedAuthToken({ token }, resolve));
}

// Walks a Google Docs API document body (including table cells) in reading
// order, joining all paragraph text runs into plain text.
function extractDocsApiText(doc) {
  const lines = [];
  function walkElements(elements) {
    if (!Array.isArray(elements)) return;
    for (const el of elements) {
      if (el.textRun && typeof el.textRun.content === 'string') lines.push(el.textRun.content);
    }
  }
  function walkContent(content) {
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block.paragraph) walkElements(block.paragraph.elements);
      if (block.table) {
        for (const row of block.table.tableRows || []) {
          for (const cell of row.tableCells || []) {
            walkContent(cell.content);
          }
        }
      }
    }
  }
  walkContent(doc.body && doc.body.content);
  return lines.join('').trim();
}

// Walks a Google Slides API presentation, joining each slide's shape text
// into plain text with "--- Slide N ---" markers, mirroring the .pptx
// extractor's output shape.
function extractSlidesApiText(pres) {
  const slideTexts = [];
  (pres.slides || []).forEach((slide, idx) => {
    const lines = [];
    for (const pe of slide.pageElements || []) {
      const textElements = pe.shape && pe.shape.text && pe.shape.text.textElements;
      if (!textElements) continue;
      for (const te of textElements) {
        if (te.textRun && typeof te.textRun.content === 'string') lines.push(te.textRun.content);
      }
    }
    const slideText = lines.join('').trim();
    if (slideText) slideTexts.push(`--- Slide ${idx + 1} ---\n${slideText}`);
  });
  return slideTexts.join('\n\n');
}

async function captureGoogleApi({ kind, id }) {
  let token;
  try {
    token = await getGoogleAuthToken(true);
  } catch (err) {
    return { error: 'Google sign-in not available: ' + err.message };
  }

  const isSlides = kind === 'gslides';
  const apiUrl = isSlides
    ? `https://slides.googleapis.com/v1/presentations/${id}`
    : `https://docs.googleapis.com/v1/documents/${id}`;

  let res;
  try {
    res = await fetch(apiUrl, { headers: { Authorization: `Bearer ${token}` } });
  } catch (err) {
    return { error: 'Google API request failed: ' + err.message };
  }

  if (!res.ok) {
    if (res.status === 401) await removeCachedAuthToken(token); // force re-prompt next time
    return { error: `Google API returned ${res.status}` };
  }

  const json = await res.json();
  let text = isSlides ? extractSlidesApiText(json) : extractDocsApiText(json);
  if (!text) {
    return { error: 'No extractable text found in this document.' };
  }

  // Matches the cap used by the chat scrapers and the docx/pptx upload path
  // (backend/engine/document-extractor.js) — without this, a long Google Doc
  // sails past every other capture path's limit and can trip the structurer's
  // token budget on the Groq call (rate_limit_exceeded / 413 "Request too
  // large"). Google Docs/Slides had no cap at all before this.
  const GOOGLE_CAPTURE_MAX_CHARS = 15000;
  const truncated = text.length > GOOGLE_CAPTURE_MAX_CHARS;
  if (truncated) text = text.slice(0, GOOGLE_CAPTURE_MAX_CHARS);

  try {
    const result = await captureMessages(kind, [{ role: 'user', content: text }]);
    return truncated ? { ...result, truncated: true } : result;
  } catch (err) {
    return { error: err.message };
  }
}

// Fetches the formatted inject text for a session — run here (extension
// context) rather than in the content script, since a content-script fetch
// to an arbitrary origin can be blocked by the host page's CSP connect-src.
async function fetchFormattedInject(sessionId, targetModel) {
  const stored = await getStorage(['BACKEND_URL', 'userId']);
  const backendUrl = stored.BACKEND_URL || 'http://localhost:3001';
  const userId = stored.userId || 'default';

  const res = await fetch(backendUrl + '/context/inject', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, user_id: userId, target_model: targetModel, format: 'markdown' }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || ('Backend error ' + res.status));
  }
  return res.json();
}

// ── Message handler (from the floating-bridge content script) ─────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'CB_CAPTURE_ACTIVE_TAB') {
    captureChatGptTab(sender.tab).then(sendResponse).catch((err) => sendResponse({ error: err.message }));
    return true; // keep the message channel open for the async response
  }

  if (msg && msg.type === 'CB_CAPTURE_GOOGLE_EXPORT') {
    captureGoogleExport(msg).then(sendResponse).catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (msg && msg.type === 'CB_CAPTURE_GOOGLE_API') {
    captureGoogleApi(msg).then(sendResponse).catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (msg && msg.type === 'CB_INJECT_FORMATTED') {
    fetchFormattedInject(msg.sessionId, msg.targetModel)
      .then((data) => sendResponse(data))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
});

// ── Command handler ───────────────────────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'capture-context') return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  const result = await captureChatGptTab(tab);

  if (result.unsupported) {
    notify('ConteXetu', 'Open a ChatGPT or Gemini conversation first, then press Alt+Shift+C', true);
    return;
  }
  if (result.error) {
    notify('ConteXetu — Capture Failed', result.error, true);
    return;
  }
  notify('ConteXetu — Saved ✓', '"' + (result.title || 'Session') + '" captured');
});
