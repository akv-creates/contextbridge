// Popup controller — calls chrome.scripting.executeScript directly. Zero message passing for capture.

const MAX_SESSIONS = 20;
const SESSIONS_KEY = 'cb_sessions';
const $ = (id) => document.getElementById(id);

let currentTab = null;
let currentSourceModel = null;
let lastCaptureResult = null;
let mergeMode = false;
let mergeSelected = new Set();
let sessionFilter = '';
let bulkDeleteMode = false;
let bulkDeleteSelected = new Set();

// ── Settings ──────────────────────────────────────────────────────────────────

function getBackendUrl() {
  return new Promise((r) => chrome.storage.local.get(['BACKEND_URL'], (v) => r(v.BACKEND_URL || 'http://localhost:3001')));
}

function getUserId() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['userId'], (r) => {
      if (r.userId) return resolve(r.userId);
      const id = crypto.randomUUID();
      chrome.storage.local.set({ userId: id }, () => resolve(id));
    });
  });
}

// ── Scraper functions — injected directly into the page from popup ────────────

function chatgptScraper() {
  var MAX_CHARS = 15000;
  var elements = document.querySelectorAll('[data-message-author-role]');
  if (!elements || elements.length === 0) return { error: 'NO_MESSAGES' };
  var messages = [];
  var totalLength = 0;
  for (var i = 0; i < elements.length; i++) {
    var el = elements[i];
    var role = el.getAttribute('data-message-author-role');
    var content = el.innerText.trim();
    if (!content) continue;
    if (totalLength + content.length > MAX_CHARS) {
      var rem = MAX_CHARS - totalLength;
      if (rem > 0) messages.push({ role: role, content: content.slice(0, rem) });
      break;
    }
    messages.push({ role: role, content: content });
    totalLength += content.length;
  }
  return messages.length === 0 ? { error: 'NO_MESSAGES' } : messages;
}

// Gemini renders conversations as Angular custom elements: <user-query> for
// the user's turns and <model-response> for Gemini's. Inner selectors
// (.query-text / message-content) trim UI chrome (feedback buttons, avatar
// labels) that el.innerText would otherwise pick up.
function geminiScraper() {
  var MAX_CHARS = 15000;
  var elements = document.querySelectorAll('user-query, model-response');
  if (!elements || elements.length === 0) {
    // Fallback for markup drift: inner content classes.
    elements = document.querySelectorAll('.query-text, .model-response-text, message-content');
    if (!elements || elements.length === 0) return { error: 'NO_MESSAGES' };
  }
  var messages = [];
  var totalLength = 0;
  for (var i = 0; i < elements.length; i++) {
    var el = elements[i];
    var tag = el.tagName.toLowerCase();
    var role = (tag === 'user-query' || el.classList.contains('query-text')) ? 'user' : 'assistant';
    var textEl = el;
    if (tag === 'user-query') textEl = el.querySelector('.query-text') || el;
    if (tag === 'model-response') textEl = el.querySelector('message-content') || el.querySelector('.markdown') || el;
    var content = (textEl.innerText || textEl.textContent || '').trim();
    if (!content) continue;
    if (totalLength + content.length > MAX_CHARS) {
      var rem = MAX_CHARS - totalLength;
      if (rem > 0) messages.push({ role: role, content: content.slice(0, rem) });
      break;
    }
    messages.push({ role: role, content: content });
    totalLength += content.length;
  }
  return messages.length === 0 ? { error: 'NO_MESSAGES' } : messages;
}

// ── Paste conversation parser ────────────────────────────────────────────────
// Parses pasted conversation text into [{role, content}] messages.
// Handles common formats: "Human:", "User:", "Assistant:", "Claude:", or
// alternating paragraphs separated by blank lines.

// ── Artifact cleaner ──────────────────────────────────────────────────────────
// Strips UI noise that gets included when you copy-paste from ChatGPT / Claude.

function cleanArtifacts(text) {
  var lines = text.split('\n');
  var cleaned = [];

  // Lines that are pure UI chrome — exact or regex matches
  var JUNK_EXACT = new Set([
    'copy', 'edit', 'regenerate', 'regenerate response', 'stop generating',
    'thumbs up', 'thumbs down', 'like', 'dislike', 'share', 'flag',
    'good response', 'bad response', 'copy code', 'run code',
    'chatgpt can make mistakes. consider checking important information.',
    'chatgpt can make mistakes, so double-check important info.',
    'free research preview. chatgpt may produce inaccurate information about people, places, or facts.',
    'this content may violate our usage policies.',
    'this is a beta feature. your feedback will help us improve.',
    'message chatgpt', 'send a message', 'type a message',
  ]);

  // Single-token model name lines (ChatGPT copies these as separate lines)
  var MODEL_LABEL = /^(gpt-?4o?[\w\-]*|o1|o3|o3-mini|o4-mini|claude[\s\-]?[\d\.]*|gemini[\s\-]?[\w]*|llama[\s\-]?[\d\.]*|mistral[\s\-]?[\w]*)$/i;

  // Citation footnote lines like "[1]: https://..."
  var CITATION_FOOTNOTE = /^\[\d+\]:\s*https?:\/\//;

  // Timestamp-only lines like "3:42 PM" or "Apr 12, 2025, 3:42 PM"
  var TIMESTAMP_ONLY = /^(\w{3}\s+\d{1,2},?\s+\d{4},?\s*)?\d{1,2}:\d{2}\s*(AM|PM)?$/i;

  for (var i = 0; i < lines.length; i++) {
    var raw = lines[i];
    var trimmed = raw.trim();
    var lower = trimmed.toLowerCase();

    if (JUNK_EXACT.has(lower)) continue;
    if (MODEL_LABEL.test(trimmed)) continue;
    if (CITATION_FOOTNOTE.test(trimmed)) continue;
    if (TIMESTAMP_ONLY.test(trimmed)) continue;

    // Strip inline citation brackets [1][2] but keep the rest of the line
    var stripped = raw.replace(/\[\d+\]/g, '').trimEnd();
    cleaned.push(stripped);
  }

  // Collapse 3+ consecutive blank lines down to 2
  return cleaned.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ── Conversation parser ───────────────────────────────────────────────────────

function parseConversationText(text) {
  var MAX_CHARS = 15000;

  // Pre-clean UI artifacts before parsing
  text = cleanArtifacts(text);

  var lines = text.split('\n');
  var messages = [];
  var currentRole = null;
  var currentContent = [];

  // Expanded label pattern — covers:
  //   "You:", "Human:", "Me:", "User:"  → user
  //   "You said:", "ChatGPT said:"      → role inferred from noun
  //   "**You**:", "**Claude**:"         → markdown bold labels
  //   "Assistant:", "Claude:", "AI:", "ChatGPT:", "GPT:", "Bot:"  → assistant
  var labelPattern = /^(?:\*{1,2})?(human|user|me|you|you said|assistant|claude|claude said|ai|bot|chatgpt|chatgpt said|gpt|gemini)(?:\*{1,2})?\s*[:\-]\s*/i;

  var USER_LABELS = new Set(['human', 'user', 'me', 'you', 'you said']);

  var hasLabels = lines.some(function(l) { return labelPattern.test(l.trim()); });

  if (hasLabels) {
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var match = line.trim().match(labelPattern);
      if (match) {
        if (currentRole && currentContent.length > 0) {
          var content = currentContent.join('\n').trim();
          if (content) messages.push({ role: currentRole, content: content });
        }
        var label = match[1].toLowerCase();
        currentRole = USER_LABELS.has(label) ? 'user' : 'assistant';
        currentContent = [line.trim().replace(labelPattern, '')];
      } else {
        currentContent.push(line);
      }
    }
    if (currentRole && currentContent.length > 0) {
      var content = currentContent.join('\n').trim();
      if (content) messages.push({ role: currentRole, content: content });
    }
  } else {
    // No labels — split on double newlines, alternate user/assistant
    var blocks = text.split(/\n\s*\n/).map(function(b) { return b.trim(); }).filter(Boolean);
    for (var i = 0; i < blocks.length; i++) {
      messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: blocks[i] });
    }
  }

  // Enforce character limit
  var totalLength = 0;
  var trimmed = [];
  for (var i = 0; i < messages.length; i++) {
    var c = messages[i].content;
    if (!c) continue;
    if (totalLength + c.length > MAX_CHARS) {
      var rem = MAX_CHARS - totalLength;
      if (rem > 0) trimmed.push({ role: messages[i].role, content: c.slice(0, rem) });
      break;
    }
    trimmed.push(messages[i]);
    totalLength += c.length;
  }

  return trimmed.length > 0 ? trimmed : null;
}

// ── HTML helpers ──────────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
var MODEL_LABELS = {
  chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini', ollama: 'Ollama',
  gdoc: 'Google Doc', gslides: 'Google Slides', docx: 'Word Doc', pptx: 'PowerPoint',
};
function modelLabel(m) { return MODEL_LABELS[m] || m; }
function sessionShieldBadge(s) {
  var flags = (s && s.pii_flags) || {};
  var total = Object.keys(flags).reduce(function (a, k) { return a + (Number(flags[k]) || 0); }, 0);
  if (total > 0) return '<span class="sc-shield" title="' + total + ' PII item(s) redacted on-device before any cloud call">🛡️ ' + total + '</span>';
  if (s && s.handled_locally) return '<span class="sc-shield sc-shield-local" title="Handled by the on-device model — 0 cloud credits">&#9889; local</span>';
  return '';
}
function formatDate(iso) { return new Date(iso).toLocaleDateString(undefined, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }); }
function timeAgo(iso) {
  var diff = Date.now() - new Date(iso).getTime();
  var mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  var hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  var days = Math.floor(hrs / 24);
  return days + 'd ago';
}

// ── Session persistence ───────────────────────────────────────────────────────

function loadSessions(cb) { chrome.storage.local.get([SESSIONS_KEY], (r) => cb(r[SESSIONS_KEY] || [])); }
function persistSession(session) {
  loadSessions((ss) => { ss.unshift(session); if (ss.length > MAX_SESSIONS) ss.length = MAX_SESSIONS; chrome.storage.local.set({ [SESSIONS_KEY]: ss }); });
  if (window.CBTelemetry) window.CBTelemetry.trackEvent('capture_success', { source_model: session.source_model });
}
function deleteSession(index) {
  loadSessions((ss) => {
    ss.splice(index, 1);
    chrome.storage.local.set({ [SESSIONS_KEY]: ss }, () => renderSessions());
  });
}
function toggleFavorite(index) {
  loadSessions((ss) => {
    if (!ss[index]) return;
    ss[index].starred = !ss[index].starred;
    chrome.storage.local.set({ [SESSIONS_KEY]: ss }, () => renderSessions());
  });
}
function deleteBulkSessions() {
  loadSessions((ss) => {
    var indices = Array.from(bulkDeleteSelected).sort((a, b) => b - a);
    indices.forEach((i) => ss.splice(i, 1));
    bulkDeleteSelected.clear();
    bulkDeleteMode = false;
    chrome.storage.local.set({ [SESSIONS_KEY]: ss }, () => renderSessions());
  });
}
function handleExportAll() {
  // Local-cache JSON dump. Fast, works offline, contains whatever the popup
  // has cached in chrome.storage.local.
  loadSessions((ss) => {
    if (!ss.length) { showToast('No sessions to export', 'error'); return; }
    var blob = new Blob([JSON.stringify(ss, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'contextbridge-sessions-' + new Date().toISOString().slice(0,10) + '.json';
    a.click();
    URL.revokeObjectURL(url);
    showToast('Exported ' + ss.length + ' sessions', 'success');
  });
}

// Bulk download via a backend route (handles markdown rendering or full-JSON
// with structured_context). `kind` is 'md' or 'json'.
async function handleExportAllViaBackend(kind) {
  try {
    var backendUrl = await getBackendUrl();
    var userId = await getUserId();
    var path = kind === 'md' ? '/context/export-all.md' : '/context/export-all.json';
    var url = backendUrl + path + '?user_id=' + encodeURIComponent(userId);

    showToast('Preparing export…', '');
    var res = await fetch(url);
    if (!res.ok) {
      var errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || ('Backend error ' + res.status));
    }
    var blob = await res.blob();
    var dispo = res.headers.get('Content-Disposition') || '';
    var nameMatch = dispo.match(/filename="?([^";]+)"?/);
    var filename = (nameMatch && nameMatch[1]) ||
      ('contextbridge-all.' + (kind === 'md' ? 'md' : 'json'));

    var blobUrl = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(blobUrl);
    showToast('Exported ' + filename, 'success');
  } catch (err) {
    showToast('Export failed: ' + err.message, 'error');
  }
}

// ── Render ────────────────────────────────────────────────────────────────────

// Animated "bridge connecting" progress indicator — a bridge with a data
// pulse travelling across it, shown while a capture/transfer is in flight.
function bridgeConnectingSvg() {
  return '' +
    '<svg class="cb-connect-svg" viewBox="0 0 240 96" fill="none" aria-hidden="true">' +
      '<defs>' +
        '<linearGradient id="cbConnGrad" x1="20" y1="0" x2="220" y2="0" gradientUnits="userSpaceOnUse">' +
          '<stop offset="0" stop-color="#8B5CF6"/><stop offset="0.5" stop-color="#6366F1"/><stop offset="1" stop-color="#06B6D4"/>' +
        '</linearGradient>' +
      '</defs>' +
      // arch
      '<path d="M28 66 A 84 46 0 0 1 212 66" stroke="url(#cbConnGrad)" stroke-width="5" stroke-linecap="round" opacity="0.85"/>' +
      // cables
      '<g stroke="url(#cbConnGrad)" stroke-width="2.5" stroke-linecap="round" opacity="0.55">' +
        '<line x1="64" y1="38" x2="64" y2="68"/><line x1="120" y1="30" x2="120" y2="68"/><line x1="176" y1="38" x2="176" y2="68"/>' +
      '</g>' +
      // deck
      '<rect x="24" y="66" width="192" height="6" rx="3" fill="url(#cbConnGrad)" opacity="0.9"/>' +
      // animated flowing dashes along the deck
      '<line class="cb-flow" x1="30" y1="69" x2="210" y2="69" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="2 12" opacity="0.9"/>' +
      // endpoint nodes
      '<circle cx="24" cy="48" r="8" fill="#8B5CF6"/>' +
      '<circle cx="216" cy="48" r="8" fill="#06B6D4"/>' +
      // travelling pulse
      '<circle class="cb-pulse" r="4.5" fill="#fff">' +
        '<animateMotion dur="1.5s" repeatCount="indefinite" path="M24 48 C 24 60, 60 69, 120 69 S 216 60, 216 48"/>' +
        '<animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.15;0.85;1" dur="1.5s" repeatCount="indefinite"/>' +
      '</circle>' +
    '</svg>';
}

function showSpinner(msg) {
  $('status-area').innerHTML =
    '<div class="cb-connecting">' +
      bridgeConnectingSvg() +
      '<div class="cb-connect-msg">' + escHtml(msg) + '</div>' +
    '</div>';
}

// ── Privacy Shield ─────────────────────────────────────────────────────────────
// Renders the on-device redaction summary. This is the trust moment: it shows
// exactly what PII was stripped locally before anything reached the cloud.

function piiCategoryMeta(cat) {
  var c = String(cat || '').toLowerCase();
  if (c.includes('email')) return { icon: '✉️', label: 'email' };
  if (c.includes('phone')) return { icon: '📞', label: 'phone number' };
  if (c.includes('key') || c.includes('secret') || c.includes('token') || c.includes('credential')) return { icon: '🔑', label: 'API key' };
  if (c.includes('name')) return { icon: '👤', label: 'name' };
  if (c.includes('address')) return { icon: '📍', label: 'address' };
  if (c.includes('financ') || c.includes('account') || c.includes('card') || c.includes('bank')) return { icon: '💳', label: 'financial detail' };
  if (c.includes('health') || c.includes('medical')) return { icon: '🩺', label: 'health detail' };
  return { icon: '🔒', label: c || 'sensitive item' };
}

function pluralize(label, n) {
  if (n <= 1) return label;
  if (/(detail|address|key|number|name|email)$/.test(label)) return label + 's';
  return label + 's';
}

// Mask an original PII value for display in the un-redact list — enough to
// recognize it, not enough to fully expose it at a glance.
function maskValue(s) {
  s = String(s == null ? '' : s);
  if (s.length <= 2) return '••';
  if (s.length <= 5) return s[0] + '•••';
  return s.slice(0, 2) + '•••' + s.slice(-2);
}

// Apply user-selected un-redactions to outgoing text. Restores only the tokens
// the user explicitly chose to reveal; everything else stays redacted.
function applyRestorations(text, session) {
  if (typeof text !== 'string' || !session) return text;
  var map = session.redaction_map || {};
  var restored = session._restoredTokens || [];
  restored.forEach(function (token) {
    if (map[token]) text = text.split(token).join(map[token]);
  });
  return text;
}

// Wire the expand toggle + restore checkboxes after the shield HTML is in the DOM.
function wirePrivacyShield(result) {
  var shield = $('status-area').querySelector('.privacy-shield');
  if (!shield) return;
  if (!result._restoredTokens) result._restoredTokens = [];

  var toggle = shield.querySelector('.ps-detail-toggle');
  var detail = shield.querySelector('.ps-detail');
  if (toggle && detail) {
    toggle.addEventListener('click', function () {
      var open = detail.classList.toggle('open');
      toggle.classList.toggle('open', open);
    });
  }

  shield.querySelectorAll('.ps-restore-cb').forEach(function (cb) {
    cb.addEventListener('change', function () {
      var token = cb.dataset.token;
      var set = new Set(result._restoredTokens);
      if (cb.checked) set.add(token); else set.delete(token);
      result._restoredTokens = Array.from(set);
      // Reflect restore count in the warning line, if present.
      var warn = shield.querySelector('.ps-restore-warn');
      if (warn) {
        var n = result._restoredTokens.length;
        warn.style.display = n > 0 ? 'flex' : 'none';
        var cnt = warn.querySelector('.ps-restore-count');
        if (cnt) cnt.textContent = n;
      }
    });
  });
}

function renderPrivacyShieldHtml(result) {
  var flags = (result && result.pii_flags) || {};
  var handledLocally = !!(result && result.handled_locally);
  var total = Object.keys(flags).reduce(function (a, k) { return a + (Number(flags[k]) || 0); }, 0);

  var pills = Object.keys(flags).map(function (cat) {
    var n = Number(flags[cat]) || 0;
    if (n <= 0) return '';
    var m = piiCategoryMeta(cat);
    return '<span class="ps-pill"><span class="ps-pill-icon">' + m.icon + '</span>' +
      n + ' ' + escHtml(pluralize(m.label, n)) + '</span>';
  }).filter(Boolean).join('');

  var localBadge = handledLocally
    ? '<div class="ps-local-wrap"><span class="ps-local-badge" title="Answered by the on-device model — no cloud API credits were spent">&#9889; Handled locally · 0 cloud credits</span></div>'
    : '';

  // Build the per-item un-redact list from the transient redaction_map.
  var map = (result && result.redaction_map) || {};
  var tokens = Object.keys(map);
  var detailHtml = '';
  if (tokens.length > 0) {
    var restoredSet = new Set((result && result._restoredTokens) || []);
    var rows = tokens.map(function (token) {
      var m = piiCategoryMeta(token.replace(/[\[\]_0-9]/g, ' '));
      return '<label class="ps-detail-row">' +
        '<input type="checkbox" class="ps-restore-cb" data-token="' + escHtml(token) + '"' + (restoredSet.has(token) ? ' checked' : '') + ' />' +
        '<span class="ps-detail-token">' + escHtml(token) + '</span>' +
        '<span class="ps-detail-orig" title="Hidden for privacy — check the box to restore on transfer">' + escHtml(maskValue(map[token])) + '</span>' +
        '</label>';
    }).join('');
    detailHtml =
      '<button type="button" class="ps-detail-toggle"><span class="ps-detail-caret">&#9656;</span>Review &amp; un-redact ' + tokens.length + ' item' + (tokens.length > 1 ? 's' : '') + '</button>' +
      '<div class="ps-detail">' +
        '<div class="ps-detail-hint">Checked items will be <strong>restored</strong> in the transferred text. Leave unchecked to keep them redacted.</div>' +
        rows +
        '<div class="ps-restore-warn" style="display:' + (restoredSet.size > 0 ? 'flex' : 'none') + '"><span class="ps-warn-icon">&#9888;</span><span><strong class="ps-restore-count">' + restoredSet.size + '</strong> item(s) will be sent to the cloud un-redacted.</span></div>' +
      '</div>';
  }

  var headline, sub, cls;
  if (total > 0) {
    cls = 'ps-redacted';
    headline = '<span class="ps-shield-icon">🛡️</span>' + total + ' sensitive item' + (total > 1 ? 's' : '') + ' redacted on-device';
    sub = 'Stripped locally before anything was sent to the cloud.';
  } else {
    cls = 'ps-clean';
    headline = '<span class="ps-shield-icon">🛡️</span>Scanned on-device · no PII detected';
    sub = 'Checked locally before leaving your machine.';
  }

  return '<div class="privacy-shield ' + cls + '">' +
    '<div class="ps-head">' + headline + '</div>' +
    (pills ? '<div class="ps-pills">' + pills + '</div>' : '') +
    '<div class="ps-sub">' + sub + '</div>' +
    detailHtml +
    localBadge +
    '</div>';
}

function showSuccess(result) {
  var goalCount = (result.goals||[]).length;
  var decisionCount = (result.decisions||[]).length;
  var techCount = (result.tech_stack||[]).length;
  var firstGoal = result.goals?.[0]||'';

  $('status-area').innerHTML = `
    ${renderPrivacyShieldHtml(result)}
    <div class="success-card">
      <div class="success-header">
        <span class="success-check">&#10003;</span>
        <span class="session-title">${escHtml(result.title||'Untitled Session')}</span>
      </div>
      <div class="success-stats">
        <span><span class="stat-num">${goalCount}</span> goals</span>
        <span><span class="stat-num">${decisionCount}</span> decisions</span>
        ${techCount ? `<span><span class="stat-num">${techCount}</span> tech</span>` : ''}
      </div>
      ${firstGoal ? `<div class="first-goal">"${escHtml(firstGoal)}"</div>` : ''}
      <div class="success-actions">
        <button class="inject-btn" id="inject-btn">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>
          Transfer Context
        </button>
      </div>
    </div>`;
  $('inject-btn').addEventListener('click', () => showInjectModal(lastCaptureResult));
  wirePrivacyShield(result);
}

function showError(msg) {
  $('status-area').innerHTML = `
    <div class="error-card">
      <div class="error-header">
        <span class="error-icon">!</span>
        Capture Failed
      </div>
      <div class="error-msg">${escHtml(msg)}</div>
      <button class="retry-btn" id="retry-btn">Try Again</button>
    </div>`;
  $('retry-btn').addEventListener('click', handleCapture);
}

function clearStatus() {
  $('status-area').innerHTML = '';
  document.body.classList.remove('preview-mode');
}

function renderSessions() {
  loadSessions((allSessions) => {
    var list = $('sessions-list');
    var countEl = $('sessions-count');
    var heading = document.querySelector('.sessions-heading');

    // ── Heading toolbar ──────────────────────────────────────────────────────
    // Clear dynamic heading buttons, re-add fresh
    heading.querySelectorAll('.heading-btn').forEach((b) => b.remove());

    var activeMode = mergeMode ? 'merge' : bulkDeleteMode ? 'delete' : null;

    if (allSessions.length) {
      // Export all — JSON (full, server-side with structured_context)
      var exportJsonBtn = document.createElement('button');
      exportJsonBtn.className = 'merge-toggle-btn heading-btn';
      exportJsonBtn.title = 'Export all sessions as a single JSON file (full structured context)';
      exportJsonBtn.textContent = '⬇ JSON';
      exportJsonBtn.addEventListener('click', () => handleExportAllViaBackend('json'));
      heading.appendChild(exportJsonBtn);

      // Export all — Markdown (one concatenated .md knowledge file)
      var exportMdBtn = document.createElement('button');
      exportMdBtn.className = 'merge-toggle-btn heading-btn';
      exportMdBtn.title = 'Export all sessions as a single .md knowledge file — drop into Claude Projects / Custom GPT / Gemini Gems / NotebookLM';
      exportMdBtn.textContent = '⬇ MD';
      exportMdBtn.addEventListener('click', () => handleExportAllViaBackend('md'));
      heading.appendChild(exportMdBtn);

      if (allSessions.length >= 2) {
        // Bulk delete button
        var delBtn = document.createElement('button');
        delBtn.id = 'bulk-delete-toggle-btn';
        delBtn.className = 'merge-toggle-btn heading-btn' + (bulkDeleteMode ? ' active delete-active' : '');
        delBtn.textContent = bulkDeleteMode ? 'Cancel' : 'Select';
        delBtn.addEventListener('click', () => {
          bulkDeleteMode = !bulkDeleteMode;
          bulkDeleteSelected.clear();
          if (mergeMode) { mergeMode = false; mergeSelected.clear(); }
          renderSessions();
        });
        heading.appendChild(delBtn);

        // Merge button
        var mergeBtn = document.createElement('button');
        mergeBtn.id = 'merge-toggle-btn';
        mergeBtn.className = 'merge-toggle-btn heading-btn' + (mergeMode ? ' active' : '');
        mergeBtn.textContent = mergeMode ? 'Cancel' : 'Merge';
        mergeBtn.addEventListener('click', () => {
          mergeMode = !mergeMode;
          mergeSelected.clear();
          if (bulkDeleteMode) { bulkDeleteMode = false; bulkDeleteSelected.clear(); }
          renderSessions();
        });
        heading.appendChild(mergeBtn);
      }
    }

    // ── Search filter ────────────────────────────────────────────────────────
    var searchWrap = document.getElementById('session-search-wrap');
    if (allSessions.length && !searchWrap) {
      searchWrap = document.createElement('div');
      searchWrap.id = 'session-search-wrap';
      searchWrap.className = 'session-search-wrap';
      searchWrap.innerHTML = '<input id="session-search" class="session-search" type="text" placeholder="🔍 Search sessions…" value="' + escHtml(sessionFilter) + '">';
      heading.insertAdjacentElement('afterend', searchWrap);
      document.getElementById('session-search').addEventListener('input', (e) => {
        sessionFilter = e.target.value;
        renderSessions();
      });
    } else if (!allSessions.length && searchWrap) {
      searchWrap.remove();
    }

    // ── Apply filter + sort starred first ────────────────────────────────────
    var q = sessionFilter.trim().toLowerCase();
    var sessions = allSessions
      .map((s, i) => ({ ...s, _origIndex: i }))
      .filter((s) => !q || (s.title || '').toLowerCase().includes(q) || (s.source_model || '').toLowerCase().includes(q))
      .sort((a, b) => (b.starred ? 1 : 0) - (a.starred ? 1 : 0));

    if (!sessions.length) {
      list.innerHTML = allSessions.length
        ? '<p class="empty-state">No sessions match "' + escHtml(sessionFilter) + '"</p>'
        : '<div class="empty-state empty-state-rich">' +
            '<div class="empty-flow">' +
              '<span class="empty-flow-node">&#128172;</span>' +
              '<span class="empty-flow-arrow">&#8594;</span>' +
              '<span class="empty-flow-node empty-flow-x">&#10005;</span>' +
              '<span class="empty-flow-arrow">&#8594;</span>' +
              '<span class="empty-flow-node">&#10024;</span>' +
            '</div>' +
            '<div class="empty-state-title">No sessions yet</div>' +
            '<div class="empty-state-sub">Capture a ChatGPT or Claude conversation once — reuse it in any AI, forever.</div>' +
          '</div>';
      countEl.style.display = 'none';
      removeMergeBar(); removeBulkDeleteBar();
      return;
    }

    countEl.textContent = allSessions.length;
    countEl.style.display = 'inline';

    // ── Detect active tab for one-click inject ───────────────────────────────
    var tabUrl = currentTab?.url || '';
    var onChatGPT = tabUrl.includes('chatgpt.com');
    var onClaude  = tabUrl.includes('claude.ai');
    var onGemini  = tabUrl.includes('gemini.google.com');
    var onTarget  = onChatGPT || onClaude || onGemini;
    var oneClickTarget = onChatGPT ? 'chatgpt' : onGemini ? 'gemini' : 'claude';

    // ── Render cards ─────────────────────────────────────────────────────────
    list.innerHTML = sessions.slice(0, 10).map((s) => {
      var i = s._origIndex;
      var starIcon = s.starred ? '★' : '☆';
      var starClass = s.starred ? 'star-btn starred' : 'star-btn';

      if (mergeMode) {
        return `<div class="session-card merge-mode">
          <div class="sc-row">
            <input type="checkbox" class="merge-cb" data-index="${i}" ${mergeSelected.has(i) ? 'checked' : ''}>
            <div class="sc-info">
              <div class="sc-title">${escHtml(s.title||'Untitled')}</div>
              <div class="sc-meta"><span class="sc-model-badge">${escHtml(modelLabel(s.source_model))}</span>${timeAgo(s.created_at)}</div>
            </div>
          </div>
        </div>`;
      }

      if (bulkDeleteMode) {
        return `<div class="session-card merge-mode">
          <div class="sc-row">
            <input type="checkbox" class="bulk-del-cb" data-index="${i}" ${bulkDeleteSelected.has(i) ? 'checked' : ''}>
            <div class="sc-info">
              <div class="sc-title">${escHtml(s.title||'Untitled')}</div>
              <div class="sc-meta"><span class="sc-model-badge">${escHtml(modelLabel(s.source_model))}</span>${timeAgo(s.created_at)}</div>
            </div>
          </div>
        </div>`;
      }

      var injectBtn = onTarget
        ? `<button class="inject-now-btn" data-index="${i}" title="Inject directly into ${modelLabel(oneClickTarget)}">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>
            Inject Now
           </button>`
        : `<button class="inject-session-btn" data-index="${i}">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>
            Transfer
           </button>`;

      var folderChip = s.folder_name
        ? `<span class="sc-folder-chip" title="Folder: ${escHtml(s.folder_name)}">📁 ${escHtml(s.folder_name)}</span>`
        : '';
      return `<div class="session-card">
        <div class="sc-row">
          <div class="sc-info">
            <div class="sc-title">${s.starred ? '<span class="sc-star">★</span>' : ''}${escHtml(s.title||'Untitled')}</div>
            <div class="sc-meta"><span class="sc-model-badge">${escHtml(modelLabel(s.source_model))}</span>${sessionShieldBadge(s)}${folderChip}${timeAgo(s.created_at)}</div>
          </div>
          <div style="display:flex;gap:2px;align-items:center">
            <button class="${starClass}" data-index="${i}" title="${s.starred ? 'Unstar' : 'Star'}">${starIcon}</button>
            <button class="kebab-btn" data-index="${i}" title="More actions">⋮</button>
            <button class="delete-session-btn" data-index="${i}" title="Delete">&times;</button>
          </div>
        </div>
        <div class="sc-actions">
          ${injectBtn}
          <button class="download-session-btn" data-index="${i}">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            JSON
          </button>
        </div>
      </div>`;
    }).join('');

    // ── Wire events ──────────────────────────────────────────────────────────
    if (mergeMode) {
      list.querySelectorAll('.merge-cb').forEach((cb) => {
        cb.addEventListener('change', () => {
          var idx = Number(cb.dataset.index);
          if (cb.checked) mergeSelected.add(idx); else mergeSelected.delete(idx);
          updateMergeBar();
        });
      });
      updateMergeBar();
      return;
    }

    if (bulkDeleteMode) {
      list.querySelectorAll('.bulk-del-cb').forEach((cb) => {
        cb.addEventListener('change', () => {
          var idx = Number(cb.dataset.index);
          if (cb.checked) bulkDeleteSelected.add(idx); else bulkDeleteSelected.delete(idx);
          updateBulkDeleteBar();
        });
      });
      updateBulkDeleteBar();
      return;
    }

    removeMergeBar(); removeBulkDeleteBar();

    list.querySelectorAll('.star-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); toggleFavorite(Number(btn.dataset.index)); });
    });
    list.querySelectorAll('.inject-session-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); loadSessions((ss) => showInjectModal(ss[Number(btn.dataset.index)])); });
    });
    list.querySelectorAll('.inject-now-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        loadSessions((ss) => quickInject(ss[Number(btn.dataset.index)], oneClickTarget));
      });
    });
    list.querySelectorAll('.download-session-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); loadSessions((ss) => handleQuickDownload(ss[Number(btn.dataset.index)])); });
    });
    list.querySelectorAll('.delete-session-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm('Delete this session?')) handleSoftDelete(Number(btn.dataset.index));
      });
    });
    list.querySelectorAll('.kebab-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        loadSessions((ss) => openKebabMenu(btn, ss[Number(btn.dataset.index)], Number(btn.dataset.index)));
      });
    });
  });
}

// ── Bulk delete bar ───────────────────────────────────────────────────────────

function updateBulkDeleteBar() {
  removeBulkDeleteBar();
  if (bulkDeleteSelected.size === 0) return;
  var bar = document.createElement('div');
  bar.id = 'bulk-delete-bar';
  bar.className = 'merge-bar';
  bar.innerHTML =
    '<span class="merge-bar-text"><strong>' + bulkDeleteSelected.size + '</strong> selected</span>' +
    '<button class="merge-bar-btn delete-bar-btn" id="bulk-delete-execute-btn">Delete Selected</button>';
  document.querySelector('.container').appendChild(bar);
  document.getElementById('bulk-delete-execute-btn').addEventListener('click', () => {
    if (confirm('Delete ' + bulkDeleteSelected.size + ' session(s)? This cannot be undone.')) {
      deleteBulkSessions();
      showToast('Deleted ' + bulkDeleteSelected.size + ' session(s)', 'success');
    }
  });
}

function removeBulkDeleteBar() {
  var bar = document.getElementById('bulk-delete-bar');
  if (bar) bar.remove();
}

// ── One-click inject (no modal) ───────────────────────────────────────────────

async function quickInject(session, targetModel) {
  if (!session) return;
  try {
    showToast('Injecting…', '');
    var backendUrl = await getBackendUrl();
    var userId = await getUserId();
    var injectBody = { session_id: session.session_id, user_id: userId, target_model: targetModel };
    // Non-Claude targets get the portable markdown render — it injects
    // cleaner into chat inputs than adapter-specific dash headers.
    if (targetModel !== 'claude') injectBody.format = 'markdown';
    var res = await fetch(backendUrl + '/context/inject', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(injectBody),
    });
    if (!res.ok) throw new Error('Backend error ' + res.status);
    var data = await res.json();
    var text = data.formatted_prompt || '';
    var tokenCount = data.token_count || Math.ceil(text.length / 4);

    // Copy to clipboard as fallback regardless
    await navigator.clipboard.writeText(text);

    var hostMatch = MODEL_HOSTS[targetModel] || 'claude.ai';
    var allTabs = await chrome.tabs.query({});
    var targetTab = allTabs.find((t) => t.url && t.url.includes(hostMatch));

    if (window.CBTelemetry) window.CBTelemetry.trackEvent('inject_success', { target_model: targetModel, token_count: tokenCount });

    if (!targetTab) {
      showValueToast('Copied — ready to paste into ' + modelLabel(targetModel), '~' + tokenCount + ' tokens of context, zero re-explaining');
      return;
    }

    // Use the same proven injector functions as the modal inject
    var injectorFunc = injectorFor(targetModel);
    var injResult = await chrome.scripting.executeScript({
      target: { tabId: targetTab.id },
      func: injectorFunc,
      args: [text],
    });
    var r = injResult?.[0]?.result;

    await chrome.tabs.update(targetTab.id, { active: true });

    if (r && r.success) {
      showValueToast('Briefed ' + modelLabel(targetModel) + ' — no re-explaining needed', '~' + tokenCount + ' tokens of your context, injected instantly');
    } else {
      // Clipboard fallback already done above
      showValueToast('Copied — paste into ' + modelLabel(targetModel), '~' + tokenCount + ' tokens of context, zero re-explaining');
    }
  } catch (err) {
    showToast('Inject failed: ' + err.message, 'error');
  }
}

function toggleMergeMode() {
  mergeMode = !mergeMode;
  mergeSelected.clear();
  renderSessions();
}

function updateMergeBar() {
  removeMergeBar();
  if (mergeSelected.size === 0) return;

  var bar = document.createElement('div');
  bar.id = 'merge-bar';
  bar.className = 'merge-bar';
  bar.innerHTML =
    '<span class="merge-bar-text"><strong>' + mergeSelected.size + '</strong> selected</span>' +
    '<button class="merge-bar-btn" id="merge-execute-btn"' + (mergeSelected.size < 2 ? ' disabled' : '') + '>Merge Sessions</button>';
  document.querySelector('.container').appendChild(bar);

  document.getElementById('merge-execute-btn').addEventListener('click', executeMerge);
}

function removeMergeBar() {
  var bar = document.getElementById('merge-bar');
  if (bar) bar.remove();
}

function loadSessionsAsync() {
  return new Promise(function(resolve) {
    chrome.storage.local.get([SESSIONS_KEY], function(r) { resolve(r[SESSIONS_KEY] || []); });
  });
}

async function executeMerge() {
  var btn = document.getElementById('merge-execute-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Merging...'; }

  try {
    var backendUrl = await getBackendUrl();
    var userId = await getUserId();
    var sessions = await loadSessionsAsync();

    var sessionIds = [];
    mergeSelected.forEach(function(idx) {
      if (sessions[idx] && sessions[idx].session_id) sessionIds.push(sessions[idx].session_id);
    });

    if (sessionIds.length < 2) {
      showToast('Select at least 2 sessions to merge', 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Merge Sessions'; }
      return;
    }

    var res = await fetch(backendUrl + '/context/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_ids: sessionIds, user_id: userId }),
    });
    if (!res.ok) { var errData = await res.json().catch(function() { return {}; }); throw new Error(errData.error || 'Merge failed'); }

    var result = await res.json();
    persistSession({
      session_id: result.session_id,
      title: result.title,
      source_model: 'merged',
      goals: result.goals,
      decisions: result.decisions,
      tech_stack: result.tech_stack,
      created_at: new Date().toISOString(),
    });

    mergeMode = false;
    mergeSelected.clear();
    renderSessions();
    showToast('Sessions merged successfully!', 'success');
  } catch (err) {
    showToast('Merge failed: ' + err.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Merge Sessions'; }
  }
}

function showToast(msg, kind) {
  var existing = document.querySelector('.toast');
  if (existing) existing.remove();
  var toast = document.createElement('div');
  toast.className = 'toast' + (kind ? ' ' + kind : '');
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(function() { toast.classList.add('toast-out'); }, 2700);
  setTimeout(function() { toast.remove(); }, 3000);
}

// Grammarly/Honey-style "the moment of value" toast — shown on every
// successful inject so the win is attributed to ConteXetu, not silently
// absorbed into "the model was smart." Distinct from showToast: bigger,
// icon-led, longer dwell time, shows a concrete number.
function showValueToast(headline, statText) {
  var existing = document.querySelector('.value-toast');
  if (existing) existing.remove();
  var toast = document.createElement('div');
  toast.className = 'value-toast';
  toast.innerHTML =
    '<span class="value-toast-icon">🧠</span>' +
    '<div class="value-toast-body">' +
      '<div class="value-toast-headline">' + escHtml(headline) + '</div>' +
      (statText ? '<div class="value-toast-stat">' + escHtml(statText) + '</div>' : '') +
    '</div>';
  document.body.appendChild(toast);
  setTimeout(function() { toast.classList.add('value-toast-out'); }, 3700);
  setTimeout(function() { toast.remove(); }, 4000);
}

// ── Quick download from session card ─────────────────────────────────────────

async function handleQuickDownload(session) {
  try {
    var backendUrl = await getBackendUrl();
    var userId = await getUserId();
    var res = await fetch(backendUrl + '/context/inject', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: session.session_id, user_id: userId, target_model: 'claude', format: 'json' }),
    });
    if (!res.ok) throw new Error('Backend error');
    var data = await res.json();

    var slug = (session.title || 'context').toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40);
    var ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    var blob = new Blob([JSON.stringify(data.json_context, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'context_' + slug + '_' + ts + '.json';
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    showToast('Download failed: ' + err.message, 'error');
  }
}

// ── Tab detection ─────────────────────────────────────────────────────────────

function captureBtnLabel(text) {
  var btn = $('capture-btn');
  if (!btn) return;
  // Preserve the leading icon <svg>, just swap the trailing text node.
  var svg = btn.querySelector('svg');
  btn.textContent = text;
  if (svg) btn.insertBefore(svg, btn.firstChild);
}

async function detectActiveTab() {
  var [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;
  var url = tab?.url || '';
  if (url.includes('chatgpt.com')) {
    currentSourceModel = 'chatgpt';
    captureBtnLabel('Capture Context');
    $('badge-text').textContent = 'ChatGPT detected';
    $('badge-dot').classList.add('active');
    $('capture-btn').style.display = 'flex';
    $('capture-btn').disabled = false;
  } else if (url.includes('claude.ai')) {
    currentSourceModel = 'claude';
    $('badge-text').textContent = 'Claude detected — paste mode';
    $('badge-dot').classList.add('active');
    $('capture-btn').style.display = 'none';
    $('paste-section').style.display = 'block';
  } else if (url.includes('gemini.google.com')) {
    currentSourceModel = 'gemini';
    captureBtnLabel('Capture Context');
    $('badge-text').textContent = 'Gemini detected';
    $('badge-dot').classList.add('active');
    $('capture-btn').style.display = 'flex';
    $('capture-btn').disabled = false;
  } else if (/docs\.google\.com\/document\/d\//.test(url)) {
    currentSourceModel = 'gdoc';
    captureBtnLabel('Capture Google Doc');
    $('badge-text').textContent = 'Google Doc detected';
    $('badge-dot').classList.add('active');
    $('capture-btn').style.display = 'flex';
    $('capture-btn').disabled = false;
  } else if (/docs\.google\.com\/presentation\/d\//.test(url)) {
    currentSourceModel = 'gslides';
    captureBtnLabel('Capture Google Slides');
    $('badge-text').textContent = 'Google Slides detected';
    $('badge-dot').classList.add('active');
    $('capture-btn').style.display = 'flex';
    $('capture-btn').disabled = false;
  } else {
    currentSourceModel = null;
    $('badge-text').textContent = 'No AI tab — paste mode available';
    $('badge-dot').classList.remove('active');
    $('capture-btn').style.display = 'none';
    $('paste-section').style.display = 'block';
  }
}

// ── Health check ──────────────────────────────────────────────────────────────

async function checkHealth() {
  try {
    var url = await getBackendUrl();
    var res = await fetch(url + '/health', { signal: AbortSignal.timeout(3000) });
    var data = await res.json();
    if (data.status === 'ok') { $('conn-dot').className = 'conn-dot connected'; $('conn-status').textContent = 'Backend connected'; }
    else throw 0;
    updateOnboarding(true);
  } catch {
    $('conn-dot').className = 'conn-dot error';
    $('conn-status').textContent = 'Backend unreachable';
    updateOnboarding(false);
  }
}

// ── Onboarding card ───────────────────────────────────────────────────────────
// Shown when the backend is unreachable, or on first run (no captures yet).
// Dismiss persists via chrome.storage.local so it never nags again.

var ONBOARDED_KEY = 'cb_onboarding_dismissed';

function updateOnboarding(backendOk) {
  var card = $('onboarding-card');
  if (!card) return;
  chrome.storage.local.get([ONBOARDED_KEY], (r) => {
    if (r[ONBOARDED_KEY]) { card.style.display = 'none'; return; }
    if (!backendOk) { card.style.display = 'flex'; return; }
    loadSessions((ss) => {
      card.style.display = ss.length === 0 ? 'flex' : 'none';
      // A successful first capture counts as onboarded.
      if (ss.length > 0) chrome.storage.local.set({ [ONBOARDED_KEY]: true });
    });
  });
}

(function initOnboardingDismiss() {
  var btn = $('onboarding-dismiss');
  if (!btn) return;
  btn.addEventListener('click', () => {
    chrome.storage.local.set({ [ONBOARDED_KEY]: true });
    var card = $('onboarding-card');
    if (card) card.style.display = 'none';
  });
})();

// ── Capture — 100% in popup, ZERO message passing ─────────────────────────────

async function handleCapture() {
  if (!currentTab || !currentSourceModel) return;
  clearStatus();
  $('capture-btn').disabled = true;

  if (currentSourceModel === 'gdoc' || currentSourceModel === 'gslides') {
    try {
      await handleGoogleExportCapture(currentSourceModel);
    } finally {
      $('capture-btn').disabled = !currentSourceModel;
    }
    return;
  }

  showSpinner('Scraping conversation...');

  try {
    var SCRAPERS = { chatgpt: chatgptScraper, gemini: geminiScraper };
    var func = SCRAPERS[currentSourceModel];
    if (!func) {
      throw new Error('Use paste mode for ' + (currentSourceModel || 'this site'));
    }
    var results = await chrome.scripting.executeScript({
      target: { tabId: currentTab.id },
      func: func,
    });

    var scraped = results?.[0]?.result;
    if (!scraped || scraped.error) {
      var errMsg = 'Scrape failed';
      if (scraped?.error === 'NO_MESSAGES') {
        errMsg = 'No messages found on this page.';
        if (scraped?.debug) {
          errMsg += ' DEBUG — testIds: [' + (scraped.debug.testIds||[]).join(', ') + '] | classes: [' + (scraped.debug.messageClasses||[]).join(', ') + ']';
        }
      }
      throw new Error(errMsg);
    }
    if (!Array.isArray(scraped) || scraped.length === 0) {
      throw new Error('No messages found. Start a conversation first.');
    }

    showSpinner('Structuring context with AI...');
    var backendUrl = await getBackendUrl();
    var userId = await getUserId();

    var res = await fetch(backendUrl + '/context/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_model: currentSourceModel, messages: scraped, user_id: userId }),
    });
    if (!res.ok) { var err = await res.json().catch(() => ({})); throw new Error(err.error || 'Backend error ' + res.status); }

    var result = await res.json();
    lastCaptureResult = result;
    persistSession({ session_id: result.session_id, title: result.title, source_model: currentSourceModel, goals: result.goals, decisions: result.decisions, tech_stack: result.tech_stack, pii_flags: result.pii_flags, handled_locally: result.handled_locally, created_at: new Date().toISOString() });
    showPreview(result);
    renderSessions();

  } catch (err) {
    showError(err.message);
  } finally {
    $('capture-btn').disabled = !currentSourceModel;
  }
}

// ── Preview/Edit screen ──────────────────────────────────────────────────

const PREVIEW_CATEGORIES = [
  { key: 'goals', label: 'Goals' },
  { key: 'decisions', label: 'Decisions' },
  { key: 'constraints', label: 'Constraints' },
  { key: 'tech_stack', label: 'Tech Stack' },
  { key: 'architecture', label: 'Architecture' },
  { key: 'assumptions', label: 'Assumptions' },
  { key: 'open_questions', label: 'Open Questions' },
  { key: 'key_entities', label: 'Key Entities' },
  { key: 'timeline', label: 'Timeline' },
];

function showPreview(result) {
  // Build state: track which items are included and their editable text
  var previewState = {
    result: result,
    items: {}, // key -> [{text, importance, included}]
  };

  PREVIEW_CATEGORIES.forEach(function(cat) {
    var arr = result[cat.key];
    if (!arr || !Array.isArray(arr) || arr.length === 0) return;
    previewState.items[cat.key] = arr.map(function(item) {
      var text = typeof item === 'string' ? item : (item.text || String(item));
      var importance = typeof item === 'object' ? (item.importance || 3) : 3;
      return { text: text, importance: importance, included: true };
    });
  });

  var catKeys = Object.keys(previewState.items);
  if (catKeys.length === 0) {
    showSuccess(result);
    return;
  }

  // Build HTML
  var catsHtml = catKeys.map(function(key) {
    var catInfo = PREVIEW_CATEGORIES.find(function(c) { return c.key === key; });
    var items = previewState.items[key];
    var collapsed = items.length > 5;

    var itemsHtml = items.map(function(item, idx) {
      var badge = '';
      if (item.importance >= 5) badge = '<span class="importance-badge critical">CRITICAL</span>';
      else if (item.importance <= 2) badge = '<span class="importance-badge low">low</span>';
      return '<div class="preview-item">' +
        '<input type="checkbox" checked data-cat="' + key + '" data-idx="' + idx + '" class="preview-item-cb">' +
        badge +
        '<span class="preview-item-text" contenteditable="true" data-cat="' + key + '" data-idx="' + idx + '">' + escHtml(item.text) + '</span>' +
        '</div>';
    }).join('');

    return '<div class="preview-category" data-cat="' + key + '">' +
      '<div class="preview-cat-header" data-cat="' + key + '">' +
        '<span class="preview-cat-toggle ' + (collapsed ? '' : 'open') + '">&#9654;</span>' +
        '<input type="checkbox" checked class="preview-cat-checkbox" data-cat="' + key + '">' +
        '<span>' + catInfo.label + '</span>' +
        '<span class="preview-cat-count">' + items.length + '</span>' +
      '</div>' +
      '<div class="preview-cat-items ' + (collapsed ? 'collapsed' : '') + '" data-cat="' + key + '">' +
        itemsHtml +
      '</div>' +
    '</div>';
  }).join('');

  var sourceLabel = modelLabel(result.source_model || currentSourceModel || 'unknown');

  document.body.classList.add('preview-mode');

  $('status-area').innerHTML =
    '<div class="preview-screen">' +
      '<div class="preview-header">' +
        '<button class="preview-back-btn" id="preview-back">&#8592;</button>' +
        '<span class="preview-title-text">' + escHtml(result.title || 'Untitled Session') + '</span>' +
      '</div>' +
      '<div class="preview-meta">' +
        '<span class="sc-model-badge">' + escHtml(sourceLabel) + '</span>' +
        formatDate(new Date().toISOString()) +
      '</div>' +
      renderPrivacyShieldHtml(result) +
      '<div class="preview-categories">' + catsHtml + '</div>' +
      '<div class="preview-actions">' +
        '<button class="preview-transfer-btn" id="preview-transfer">' +
          '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>' +
          'Transfer Selected Context' +
        '</button>' +
        '<button class="preview-save-btn" id="preview-save">Save</button>' +
      '</div>' +
    '</div>';

  // Wire up event handlers

  // Wire the privacy shield (expand + un-redact toggles)
  wirePrivacyShield(result);

  // Back button — return to main view
  $('preview-back').addEventListener('click', function() {
    clearStatus();
  });

  // Category header toggle (collapse/expand)
  $('status-area').querySelectorAll('.preview-cat-header').forEach(function(header) {
    header.addEventListener('click', function(e) {
      if (e.target.tagName === 'INPUT') return; // don't toggle when clicking checkbox
      var cat = header.dataset.cat;
      var itemsEl = $('status-area').querySelector('.preview-cat-items[data-cat="' + cat + '"]');
      var toggleEl = header.querySelector('.preview-cat-toggle');
      itemsEl.classList.toggle('collapsed');
      toggleEl.classList.toggle('open');
    });
  });

  // Category-level checkbox — toggle all items
  $('status-area').querySelectorAll('.preview-cat-checkbox').forEach(function(cb) {
    cb.addEventListener('change', function() {
      var cat = cb.dataset.cat;
      var checked = cb.checked;
      previewState.items[cat].forEach(function(item) { item.included = checked; });
      $('status-area').querySelectorAll('.preview-item-cb[data-cat="' + cat + '"]').forEach(function(itemCb) {
        itemCb.checked = checked;
      });
    });
  });

  // Individual item checkboxes
  $('status-area').querySelectorAll('.preview-item-cb').forEach(function(cb) {
    cb.addEventListener('change', function() {
      var cat = cb.dataset.cat;
      var idx = Number(cb.dataset.idx);
      previewState.items[cat][idx].included = cb.checked;
      // Update category checkbox
      var allChecked = previewState.items[cat].every(function(item) { return item.included; });
      var catCb = $('status-area').querySelector('.preview-cat-checkbox[data-cat="' + cat + '"]');
      if (catCb) catCb.checked = allChecked;
    });
  });

  // Inline edit — update text on blur
  $('status-area').querySelectorAll('.preview-item-text').forEach(function(el) {
    el.addEventListener('blur', function() {
      var cat = el.dataset.cat;
      var idx = Number(el.dataset.idx);
      previewState.items[cat][idx].text = el.textContent.trim();
    });
    el.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
    });
  });

  // Transfer button — build filtered result and show inject modal
  $('preview-transfer').addEventListener('click', function() {
    var filtered = buildFilteredResult(result, previewState);
    lastCaptureResult = filtered;
    showInjectModal(filtered);
  });

  // Save button — just close preview
  $('preview-save').addEventListener('click', function() {
    clearStatus();
    showSuccess(result);
  });
}

function buildFilteredResult(original, previewState) {
  var filtered = Object.assign({}, original);
  PREVIEW_CATEGORIES.forEach(function(cat) {
    var items = previewState.items[cat.key];
    if (!items) return;
    filtered[cat.key] = items
      .filter(function(item) { return item.included; })
      .map(function(item) {
        if (typeof original[cat.key]?.[0] === 'object') {
          return { text: item.text, importance: item.importance };
        }
        return item.text;
      });
  });
  return filtered;
}

// ── Inject modal ──────────────────────────────────────────────────────────────

function showInjectModal(session) {
  if (!session) return;
  var existing = document.getElementById('inject-modal');
  if (existing) existing.remove();

  var modal = document.createElement('div');
  modal.id = 'inject-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-box">
      <div class="modal-header">
        <div class="modal-title">Transfer Context</div>
        <button class="modal-close-btn" id="inject-cancel">&times;</button>
      </div>
      <div class="modal-session-name">${escHtml(session.title||'Untitled')}</div>
      <div class="modal-section-label">Target</div>
      <div class="target-options">
        <label class="target-option">
          <input type="radio" name="target" value="claude" checked />
          <span class="target-label">Claude</span>
        </label>
        <label class="target-option">
          <input type="radio" name="target" value="chatgpt" />
          <span class="target-label">ChatGPT</span>
        </label>
        <label class="target-option">
          <input type="radio" name="target" value="gemini" />
          <span class="target-label">Gemini</span>
        </label>
        <label class="target-option">
          <input type="radio" name="target" value="ollama" />
          <span class="target-label">Ollama</span>
        </label>
      </div>
      <div class="modal-tabs">
        <button class="modal-tab active" data-tab="inject">Inject</button>
        <button class="modal-tab" data-tab="preview">Preview format</button>
      </div>
      <div class="modal-tab-content" id="modal-tab-inject">
        <div class="modal-actions">
          <button class="inject-confirm-btn" id="inject-confirm">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>
            Inject into Chat
          </button>
          <button class="copy-json-btn" id="paste-json">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>
            Copy JSON
          </button>
          <button class="download-json-btn" id="download-json">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Download
          </button>
          <button class="download-json-btn" id="export-md">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            Export .md
          </button>
          <button class="modal-cancel-btn" id="modal-cancel-bottom">Cancel</button>
        </div>
      </div>
      <div class="modal-tab-content hidden" id="modal-tab-preview">
        <div class="adapter-preview-wrap">
          <div class="adapter-preview-loading" id="adapter-preview-loading">
            <div class="spinner"></div><span>Loading preview…</span>
          </div>
          <pre class="adapter-preview-text" id="adapter-preview-text" style="display:none"></pre>
          <button class="copy-json-btn" id="copy-preview-btn" style="display:none;margin-top:8px;width:100%">
            Copy to clipboard
          </button>
        </div>
      </div>
      <div class="inject-status" id="inject-status"></div>
    </div>`;
  document.body.appendChild(modal);

  // Close on overlay click
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  $('inject-cancel').addEventListener('click', () => modal.remove());
  $('modal-cancel-bottom').addEventListener('click', () => modal.remove());

  // ── Tab switching + adapter preview ────────────────────────────────────────
  var previewLoaded = false;
  modal.querySelectorAll('.modal-tab').forEach((tab) => {
    tab.addEventListener('click', async () => {
      modal.querySelectorAll('.modal-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      var name = tab.dataset.tab;
      $('modal-tab-inject').classList.toggle('hidden', name !== 'inject');
      $('modal-tab-preview').classList.toggle('hidden', name !== 'preview');

      if (name === 'preview' && !previewLoaded) {
        previewLoaded = true;
        try {
          var targetModel = modal.querySelector('input[name="target"]:checked')?.value || 'claude';
          var backendUrl = await getBackendUrl();
          var userId = await getUserId();
          var previewBody = { session_id: session.session_id, user_id: userId, target_model: targetModel, format: 'prompt' };
          // Mirror quickInject: non-Claude targets preview the markdown render
          // so the preview matches what will actually be injected.
          if (targetModel !== 'claude') previewBody.format = 'markdown';
          var res = await fetch(backendUrl + '/context/inject', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(previewBody),
          });
          if (!res.ok) throw new Error('Backend error ' + res.status);
          var data = await res.json();
          var text = data.formatted_prompt || '(empty)';
          $('adapter-preview-loading').style.display = 'none';
          $('adapter-preview-text').textContent = text;
          $('adapter-preview-text').style.display = 'block';
          $('copy-preview-btn').style.display = 'block';
          $('copy-preview-btn').addEventListener('click', () => {
            navigator.clipboard.writeText(text).then(() => showToast('Copied!', 'success'));
          });
        } catch (err) {
          $('adapter-preview-loading').innerHTML = '<span style="color:#ef4444">Failed: ' + escHtml(err.message) + '</span>';
        }
      }

      // Reload preview if target model changed
      if (name === 'preview' && previewLoaded) {
        // allow re-fetch when switching target model
      }
    });
  });

  // Reset preview when target changes so it reloads on next tab switch
  modal.querySelectorAll('input[name="target"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      previewLoaded = false;
      $('adapter-preview-loading').style.display = 'flex';
      $('adapter-preview-text').style.display = 'none';
      $('copy-preview-btn').style.display = 'none';
      $('adapter-preview-loading').innerHTML = '<div class="spinner"></div><span>Loading preview…</span>';
    });
  });

  $('paste-json').addEventListener('click', async () => {
    var pasteBtn = $('paste-json');
    var statusEl = $('inject-status');
    pasteBtn.disabled = true;

    try {
      var targetModel = modal.querySelector('input[name="target"]:checked')?.value || 'claude';
      var backendUrl = await getBackendUrl();
      var userId = await getUserId();

      statusEl.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div><span>Pasting JSON...</span></div>`;

      var res = await fetch(backendUrl + '/context/inject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: session.session_id, user_id: userId, target_model: targetModel, format: 'json' }),
      });
      if (!res.ok) { var err = await res.json().catch(() => ({})); throw new Error(err.error || 'Backend error'); }
      var data = await res.json();
      var jsonText = applyRestorations(JSON.stringify(data.json_context, null, 2), session);

      // Try to paste directly into target tab
      var hostMatch = MODEL_HOSTS[targetModel] || 'claude.ai';
      var allTabs = await chrome.tabs.query({});
      var targetTab = allTabs.find(function(t) { return t.url && t.url.includes(hostMatch); });

      if (targetTab) {
        var injectorFunc = injectorFor(targetModel);
        var injResult = await chrome.scripting.executeScript({
          target: { tabId: targetTab.id },
          func: injectorFunc,
          args: [jsonText],
        });
        var r = injResult?.[0]?.result;
        if (r && r.success) {
          await chrome.tabs.update(targetTab.id, { active: true });
          statusEl.innerHTML = `<span class="inject-success">&#10003; JSON pasted into ${modelLabel(targetModel)}!</span>`;
          setTimeout(() => modal.remove(), 1500);
          return;
        }
      }

      // Fallback: copy to clipboard and open/focus the tab
      await navigator.clipboard.writeText(jsonText);
      var newUrl = MODEL_NEW_URLS[targetModel] || 'https://claude.ai/new';
      if (targetTab) {
        await chrome.tabs.update(targetTab.id, { active: true });
      } else {
        await chrome.tabs.create({ url: newUrl });
      }
      statusEl.innerHTML = `<span class="inject-success">&#10003; JSON copied! Paste in ${modelLabel(targetModel)}.</span>`;
      setTimeout(() => modal.remove(), 2500);
    } catch (err) {
      statusEl.innerHTML = '<span class="inject-error">' + escHtml(err.message) + '</span>';
      pasteBtn.disabled = false;
    }
  });

  $('download-json').addEventListener('click', async () => {
    var dlBtn = $('download-json');
    var statusEl = $('inject-status');
    dlBtn.disabled = true;

    try {
      var targetModel = modal.querySelector('input[name="target"]:checked')?.value || 'claude';
      var backendUrl = await getBackendUrl();
      var userId = await getUserId();

      var res = await fetch(backendUrl + '/context/inject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: session.session_id, user_id: userId, target_model: targetModel, format: 'json' }),
      });
      if (!res.ok) { var err = await res.json().catch(() => ({})); throw new Error(err.error || 'Backend error'); }
      var data = await res.json();

      var slug = (session.title || 'context').toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40);
      var ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      var filename = 'context_' + slug + '_' + ts + '.json';
      var blob = new Blob([JSON.stringify(data.json_context, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);

      statusEl.innerHTML = '<span class="inject-success">&#10003; JSON downloaded! Drag it into any LLM chat.</span>';
      setTimeout(() => modal.remove(), 2200);
    } catch (err) {
      statusEl.innerHTML = '<span class="inject-error">' + escHtml(err.message) + '</span>';
      dlBtn.disabled = false;
    }
  });

  // Export as .md — portable knowledge file for Claude Projects / Custom GPTs /
  // Gemini Gems / NotebookLM. Uses the backend GET /context/:id/export.md route
  // so the browser handles the file download natively.
  $('export-md').addEventListener('click', async () => {
    var mdBtn = $('export-md');
    var statusEl = $('inject-status');
    mdBtn.disabled = true;
    try {
      var backendUrl = await getBackendUrl();
      var userId = await getUserId();
      var url = backendUrl + '/context/' + encodeURIComponent(session.session_id) +
                '/export.md?user_id=' + encodeURIComponent(userId);

      // Fetch the blob ourselves so we respect the same error-handling path as
      // other buttons (and so extension popups don't lose focus to a new tab).
      var res = await fetch(url);
      if (!res.ok) { var err = await res.json().catch(() => ({})); throw new Error(err.error || 'Backend error ' + res.status); }
      var blob = await res.blob();
      var dispo = res.headers.get('Content-Disposition') || '';
      var nameMatch = dispo.match(/filename="?([^";]+)"?/);
      var filename = (nameMatch && nameMatch[1]) || 'context.md';

      var blobUrl = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(blobUrl);

      statusEl.innerHTML = '<span class="inject-success">&#10003; ' + escHtml(filename) + ' downloaded — drop into any LLM as knowledge.</span>';
      setTimeout(() => modal.remove(), 2500);
    } catch (err) {
      statusEl.innerHTML = '<span class="inject-error">' + escHtml(err.message) + '</span>';
      mdBtn.disabled = false;
    }
  });

  $('inject-confirm').addEventListener('click', async () => {
    var targetModel = modal.querySelector('input[name="target"]:checked')?.value;
    if (!targetModel) return;
    var confirmBtn = $('inject-confirm');
    var statusEl = $('inject-status');
    confirmBtn.disabled = true;

    try {
      statusEl.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div><span>Injecting...</span></div>`;
      var backendUrl = await getBackendUrl();
      var userId = await getUserId();

      var confirmBody = { session_id: session.session_id, user_id: userId, target_model: targetModel };
      if (targetModel !== 'claude') confirmBody.format = 'markdown';
      var res = await fetch(backendUrl + '/context/inject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(confirmBody),
      });
      if (!res.ok) { var err = await res.json().catch(() => ({})); throw new Error(err.error || 'Backend error'); }
      var data = await res.json();
      var tokenCount = data.token_count || Math.ceil((data.formatted_prompt || '').length / 4);

      // Restore only the PII items the user explicitly chose to un-redact.
      var outText = applyRestorations(data.formatted_prompt, session);

      await navigator.clipboard.writeText(outText);

      var hostMatch = MODEL_HOSTS[targetModel] || 'claude.ai';
      var allTabs = await chrome.tabs.query({});
      var targetTab = allTabs.find(function(t) { return t.url && t.url.includes(hostMatch); });

      if (window.CBTelemetry) window.CBTelemetry.trackEvent('inject_success', { target_model: targetModel, token_count: tokenCount });

      if (targetTab) {
        var injectorFunc = injectorFor(targetModel);
        var injResult = await chrome.scripting.executeScript({
          target: { tabId: targetTab.id },
          func: injectorFunc,
          args: [outText],
        });
        var r = injResult?.[0]?.result;
        if (r && r.success) {
          await chrome.tabs.update(targetTab.id, { active: true });
          statusEl.innerHTML = `<span class="inject-success">&#10003; Injected into ${modelLabel(targetModel)}!</span>`;
          setTimeout(() => { modal.remove(); showValueToast('Briefed ' + modelLabel(targetModel) + ' — no re-explaining needed', '~' + tokenCount + ' tokens of your context, injected instantly'); }, 1500);
          return;
        }
        // Injection failed but tab exists — clipboard fallback
        if (r && r.fallback === 'clipboard') {
          await chrome.tabs.update(targetTab.id, { active: true });
          statusEl.innerHTML = `<span class="inject-success">&#10003; Copied to clipboard — paste into ${modelLabel(targetModel)} manually.</span>`;
          setTimeout(() => modal.remove(), 2500);
          return;
        }
      }

      var newUrl = MODEL_NEW_URLS[targetModel] || 'https://claude.ai/new';
      if (targetTab) {
        await chrome.tabs.update(targetTab.id, { active: true });
      } else {
        await chrome.tabs.create({ url: newUrl });
      }
      statusEl.innerHTML = `<span class="inject-success">&#10003; Copied to clipboard! Paste in ${modelLabel(targetModel)}.</span>`;
      setTimeout(() => modal.remove(), 2500);

    } catch (err) {
      statusEl.innerHTML = `<span class="inject-error">${escHtml(err.message)}</span>`;
      confirmBtn.disabled = false;
    }
  });
}

// ── Injector functions (executed in the target page via executeScript) ─────────

// Shared target-model → host/URL/injector maps, used by every inject path
// (modal paste, JSON paste, quick inject, Smart Slice).
var MODEL_HOSTS = { chatgpt: 'chatgpt.com', claude: 'claude.ai', gemini: 'gemini.google.com' };
var MODEL_NEW_URLS = { chatgpt: 'https://chatgpt.com/', claude: 'https://claude.ai/new', gemini: 'https://gemini.google.com/app' };

function injectorFor(targetModel) {
  if (targetModel === 'chatgpt') return chatgptInjector;
  if (targetModel === 'gemini') return geminiInjector;
  return claudeInjector;
}

function chatgptInjector(text) {
  var sels = ['#prompt-textarea','div[contenteditable="true"][id="prompt-textarea"]','div[contenteditable="true"]'];
  var input = null;
  for (var i = 0; i < sels.length; i++) { try { input = document.querySelector(sels[i]); if (input) break; } catch(e){} }
  if (!input) return { error: 'INPUT_NOT_FOUND' };
  input.focus();

  var injected = false;

  // Primary: InputEvent with insertText (modern, works with React/ProseMirror)
  if (!injected) {
    try {
      if (input.tagName === 'TEXTAREA') {
        var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        injected = true;
      } else {
        input.innerHTML = '';
        var ev = new InputEvent('beforeinput', { inputType: 'insertText', data: text, bubbles: true, cancelable: true, composed: true });
        input.dispatchEvent(ev);
        if (input.textContent.length >= text.length * 0.5) {
          injected = true;
        }
      }
    } catch(e) {}
  }

  // Fallback 1: execCommand (deprecated but still widely supported)
  if (!injected) {
    try {
      if (input.tagName !== 'TEXTAREA') {
        input.innerHTML = '';
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, text);
        if (input.textContent.length >= text.length * 0.5) injected = true;
      }
    } catch(e) {}
  }

  // Fallback 2: Direct innerHTML set + synthetic events
  if (!injected) {
    try {
      if (input.tagName === 'TEXTAREA') {
        input.value = text;
      } else {
        input.innerHTML = '<p>' + text.replace(/\n/g, '</p><p>') + '</p>';
      }
      input.dispatchEvent(new Event('input', { bubbles: true }));
      injected = true;
    } catch(e) {}
  }

  if (!injected) return { success: false, fallback: 'clipboard' };

  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));

  // Verify injection
  var len = input.tagName === 'TEXTAREA' ? input.value.length : input.textContent.length;
  if (len < text.length * 0.3) return { success: false, fallback: 'clipboard' };

  return { success: true };
}

function claudeInjector(text) {
  var sels = ['div.ProseMirror[contenteditable="true"]','div[contenteditable="true"]'];
  var input = null;
  for (var i = 0; i < sels.length; i++) { try { input = document.querySelector(sels[i]); if (input) break; } catch(e){} }
  if (!input) return { error: 'INPUT_NOT_FOUND' };
  input.focus();

  var injected = false;

  // Primary: InputEvent with insertText (ProseMirror compatible)
  if (!injected) {
    try {
      input.innerHTML = '';
      var ev = new InputEvent('beforeinput', { inputType: 'insertText', data: text, bubbles: true, cancelable: true, composed: true });
      input.dispatchEvent(ev);
      if (input.textContent.length >= text.length * 0.5) injected = true;
    } catch(e) {}
  }

  // Fallback 1: execCommand
  if (!injected) {
    try {
      input.innerHTML = '';
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
      if (input.textContent.length >= text.length * 0.5) injected = true;
    } catch(e) {}
  }

  // Fallback 2: Direct innerHTML
  if (!injected) {
    try {
      input.innerHTML = '<p>' + text.replace(/\n/g, '</p><p>') + '</p>';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      injected = true;
    } catch(e) {}
  }

  if (!injected) return { success: false, fallback: 'clipboard' };

  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));

  // Verify
  if (input.textContent.length < text.length * 0.3) return { success: false, fallback: 'clipboard' };

  return { success: true };
}

// Gemini's prompt box is a Quill rich-text editor (div.ql-editor).
function geminiInjector(text) {
  var sels = [
    'div.ql-editor[contenteditable="true"]',
    'rich-textarea div[contenteditable="true"]',
    'div[contenteditable="true"][aria-label]',
    'div[contenteditable="true"]',
  ];
  var input = null;
  for (var i = 0; i < sels.length; i++) { try { input = document.querySelector(sels[i]); if (input) break; } catch(e){} }
  if (!input) return { error: 'INPUT_NOT_FOUND' };
  input.focus();

  var injected = false;

  // Primary: InputEvent with insertText (Quill listens to beforeinput)
  if (!injected) {
    try {
      input.innerHTML = '';
      var ev = new InputEvent('beforeinput', { inputType: 'insertText', data: text, bubbles: true, cancelable: true, composed: true });
      input.dispatchEvent(ev);
      if (input.textContent.length >= text.length * 0.5) injected = true;
    } catch(e) {}
  }

  // Fallback 1: execCommand
  if (!injected) {
    try {
      input.innerHTML = '';
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
      if (input.textContent.length >= text.length * 0.5) injected = true;
    } catch(e) {}
  }

  // Fallback 2: direct paragraph injection + synthetic events (Quill keeps
  // one <p> per line)
  if (!injected) {
    try {
      input.innerHTML = '<p>' + text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '</p><p>') + '</p>';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      injected = true;
    } catch(e) {}
  }

  if (!injected) return { success: false, fallback: 'clipboard' };

  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));

  // Verify
  if (input.textContent.length < text.length * 0.3) return { success: false, fallback: 'clipboard' };

  return { success: true };
}

// ── Document capture (.docx / .pptx upload) ───────────────────────────────────

var DOC_MAX_BYTES = 15 * 1024 * 1024; // matches backend multer limit

function isSupportedDocFile(file) {
  if (!file) return false;
  var name = (file.name || '').toLowerCase();
  return name.endsWith('.docx') || name.endsWith('.pptx');
}

// Shared upload — POSTs a File/Blob to /context/capture-file and renders the
// same preview/session-list flow as chat capture. Used by both the manual
// file picker and the Google Docs/Slides export flow below.
async function uploadDocumentFile(file, sourceLabel) {
  try {
    var backendUrl = await getBackendUrl();
    var userId = await getUserId();

    var form = new FormData();
    form.append('user_id', userId);
    form.append('file', file, file.name);

    showSpinner('Redacting on-device, then structuring context…');
    var res = await fetch(backendUrl + '/context/capture-file', {
      method: 'POST',
      body: form,
    });
    if (!res.ok) { var err = await res.json().catch(() => ({})); throw new Error(err.error || 'Backend error ' + res.status); }

    var result = await res.json();
    lastCaptureResult = result;
    persistSession({
      session_id: result.session_id,
      title: result.title,
      source_model: sourceLabel || (result.source_filename && result.source_filename.toLowerCase().endsWith('.pptx') ? 'pptx' : 'docx'),
      goals: result.goals,
      decisions: result.decisions,
      tech_stack: result.tech_stack,
      pii_flags: result.pii_flags,
      handled_locally: result.handled_locally,
      created_at: new Date().toISOString(),
    });
    showPreview(result);
    renderSessions();
  } catch (err) {
    showError(err.message);
  }
}

async function handleDocumentCapture(file) {
  if (!file) return;
  if (!isSupportedDocFile(file)) {
    showError('Only .docx and .pptx files are supported.');
    return;
  }
  if (file.size > DOC_MAX_BYTES) {
    showError('File is too large (max 15MB).');
    return;
  }

  clearStatus();
  showSpinner('Extracting text from ' + file.name + '…');
  await uploadDocumentFile(file);

  var dz = $('doc-dropzone-text');
  if (dz) dz.textContent = 'Drop a .docx or .pptx, or click to browse';
}

// ── Google Docs / Slides capture (via export, not DOM scraping) ──────────────
// Google Docs renders its body to canvas, not selectable DOM text, so live
// scraping is unreliable. Instead we fetch the doc's own .docx/.pptx export
// and run it through the same capture-file pipeline as a manual upload.
//
// IMPORTANT: the export fetch must run from the POPUP's own context, not
// from a function injected into the docs.google.com page. Chrome subjects
// content-script network calls to the host PAGE's CSP, and Google's CSP on
// docs.google.com blocks fetch() from that injected context ("Failed to
// fetch"). The popup is an extension page — it isn't bound by the page's
// CSP — and `host_permissions` for docs.google.com lets it fetch
// cross-origin with the user's existing cookies via credentials: 'include'.
// So the injected function below only does a synchronous, no-network read
// (doc ID + title from location/document) — nothing CSP can block — and the
// actual export fetch happens here in popup.js.

// Injected into the docs.google.com tab via chrome.scripting.executeScript.
// Must be self-contained (no closures over popup.js scope). No network call.
function googleDocMetaScraper() {
  var docMatch = location.href.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (docMatch) {
    var title = document.title.replace(/\s*-\s*Google Docs\s*$/i, '').trim() || 'document';
    return { kind: 'gdoc', id: docMatch[1], title: title };
  }
  var slidesMatch = location.href.match(/\/presentation\/d\/([a-zA-Z0-9_-]+)/);
  if (slidesMatch) {
    var stitle = document.title.replace(/\s*-\s*Google Slides\s*$/i, '').trim() || 'presentation';
    return { kind: 'gslides', id: slidesMatch[1], title: stitle };
  }
  return { error: 'NOT_A_DOC_OR_PRESENTATION' };
}

async function handleGoogleExportCapture(kind) {
  var isSlides = kind === 'gslides';
  var label = isSlides ? 'Google Slides' : 'Google Doc';

  showSpinner('Reading ' + label + ' info…');

  var results = await chrome.scripting.executeScript({
    target: { tabId: currentTab.id },
    func: googleDocMetaScraper,
  });
  var meta = results && results[0] && results[0].result;

  if (!meta || meta.error) {
    showError('This tab is not a ' + label + ' page.');
    return;
  }

  var exportUrl = isSlides
    ? 'https://docs.google.com/presentation/d/' + meta.id + '/export/pptx'
    : 'https://docs.google.com/document/d/' + meta.id + '/export?format=docx';
  var ext = isSlides ? '.pptx' : '.docx';
  // Docs/Slides created by uploading a .docx/.pptx file keep the original
  // extension in their title — strip it so we don't end up with "name.pptx.pptx".
  var baseTitle = meta.title.replace(/\.(docx|pptx|doc|ppt)$/i, '');
  var filename = baseTitle + ext;

  showSpinner('Exporting ' + label + '…');

  // There is no direct-fetch path here, deliberately: Google's export
  // endpoint redirects from docs.google.com to a signed googleusercontent.com
  // URL that responds with Access-Control-Allow-Origin: *. The Fetch spec
  // unconditionally forbids combining a wildcard ACAO with a credentialed
  // request (credentials: 'include', required for the first hop to prove
  // you're signed in), and fetch() applies the same credentials mode across
  // the whole redirect chain with no way to drop it only for the second hop
  // — confirmed via the exact CORS error this produced in testing. No
  // fetch() configuration can satisfy both hops, so chrome.downloads (which
  // isn't subject to CORS at all) is the only viable mechanism.
  await fallbackToDownloadAndUpload(exportUrl, filename, label);
}

// Triggers the browser's native download (uses the real browsing context —
// not subject to CORS, page CSP, or SameSite cookie restrictions the way a
// page-initiated fetch is) and points the user at the upload dropzone to
// finish. There is no automatic-read path here, deliberately: confirmed in
// real testing that Chrome blocks ANY extension-page script (popup,
// background, offscreen document) from reading file:// content via
// XHR/fetch with "Not allowed to load local resource" — regardless of the
// "Allow access to file URLs" toggle, which grants a different, narrower
// capability (content scripts running on file:// pages), not blanket file
// content reading. The manual drop-in-the-dropzone step is the only way to
// finish capturing a Google Doc/Slides export.
async function fallbackToDownloadAndUpload(exportUrl, filename, label) {
  try {
    await new Promise(function (resolve, reject) {
      chrome.downloads.download({ url: exportUrl, filename: filename, saveAs: false }, function (id) {
        if (chrome.runtime.lastError || !id) {
          reject(new Error((chrome.runtime.lastError && chrome.runtime.lastError.message) || 'Download failed to start'));
        } else {
          resolve(id);
        }
      });
    });
  } catch (err) {
    showError('Could not export ' + label + ' (' + err.message + '). Use File → Download in ' + label + ' instead, then drop the file into the box below.');
    return;
  }

  // Expand the doc upload section and point the user at it — the download
  // is already in their Downloads folder by the time this renders.
  var body = $('doc-body');
  var caret = $('doc-toggle-caret');
  if (body && body.classList.contains('hidden')) {
    body.classList.remove('hidden');
    if (caret) caret.textContent = '↑';
  }
  var dz = $('doc-dropzone-text');
  if (dz) dz.textContent = '✓ Downloaded "' + filename + '" — drop it here (or click to browse) to finish';

  $('status-area').innerHTML =
    '<div class="error-card" style="border-color:#bbf7d0;border-left-color:#10b981">' +
    '<div class="error-header" style="color:#16a34a"><span class="success-check" style="background:#10b981">&#10003;</span>Downloaded ' + escHtml(label) + '</div>' +
    '<div class="error-msg" style="color:#065f46">Drop "' + escHtml(filename) + '" into the box below to finish capturing it.</div>' +
    '</div>';
}

function initDocumentCapture() {
  var toggle = $('doc-toggle');
  var body = $('doc-body');
  var caret = $('doc-toggle-caret');
  var dropzone = $('doc-dropzone');
  var fileInput = $('doc-file-input');
  if (!toggle || !body || !fileInput) return;

  toggle.addEventListener('click', function () {
    var hidden = body.classList.toggle('hidden');
    if (caret) caret.textContent = hidden ? '↓' : '↑';
  });

  fileInput.addEventListener('change', function () {
    var file = fileInput.files && fileInput.files[0];
    if (file) handleDocumentCapture(file);
    fileInput.value = '';
  });

  // Drag & drop support on the dropzone label.
  ['dragenter', 'dragover'].forEach(function (evt) {
    dropzone.addEventListener(evt, function (e) {
      e.preventDefault();
      dropzone.classList.add('doc-dropzone-active');
    });
  });
  ['dragleave', 'drop'].forEach(function (evt) {
    dropzone.addEventListener(evt, function (e) {
      e.preventDefault();
      dropzone.classList.remove('doc-dropzone-active');
    });
  });
  dropzone.addEventListener('drop', function (e) {
    var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleDocumentCapture(file);
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────

// ── Paste-based capture (Claude and other non-ChatGPT sites) ─────────────────

async function handlePasteCapture() {
  var text = $('paste-input').value.trim();
  if (!text) {
    $('status-area').innerHTML = '<div class="error-card"><div class="error-msg">Paste your conversation first.</div></div>';
    return;
  }

  var messages = parseConversationText(text);
  if (!messages || messages.length === 0) {
    $('status-area').innerHTML = '<div class="error-card"><div class="error-msg">Could not parse any messages. Use "Human:" / "Assistant:" labels or separate messages with blank lines.</div></div>';
    return;
  }

  clearStatus();
  showSpinner('Structuring context with AI...');
  $('paste-capture-btn').disabled = true;

  try {
    var backendUrl = await getBackendUrl();
    var userId = await getUserId();
    var sourceModel = currentSourceModel || 'claude';

    var res = await fetch(backendUrl + '/context/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_model: sourceModel, messages: messages, user_id: userId }),
    });
    if (!res.ok) { var err = await res.json().catch(() => ({})); throw new Error(err.error || 'Backend error ' + res.status); }

    var result = await res.json();
    lastCaptureResult = result;
    persistSession({ session_id: result.session_id, title: result.title, source_model: sourceModel, goals: result.goals, decisions: result.decisions, tech_stack: result.tech_stack, pii_flags: result.pii_flags, handled_locally: result.handled_locally, created_at: new Date().toISOString() });
    showPreview(result);
    renderSessions();
    $('paste-input').value = '';
  } catch (err) {
    showError(err.message);
  } finally {
    $('paste-capture-btn').disabled = false;
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

// ── Theme (auto / light / dark cycle) ────────────────────────────────────────

var THEME_KEY = 'cb_theme';
var THEME_CYCLE = ['auto', 'light', 'dark'];
var themeChoice = 'auto';

// Resolve 'auto' to a concrete light/dark class here rather than relying on
// body.theme-auto + @media CSS — several later style blocks pair theme-auto
// with theme-dark unconditionally, which leaked dark styles into light mode.
function applyTheme(theme) {
  themeChoice = theme;
  var effective = theme === 'auto'
    ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : theme;
  document.body.classList.remove('theme-auto', 'theme-light', 'theme-dark');
  document.body.classList.add('theme-' + effective);
  var icon = document.getElementById('theme-icon');
  if (icon) {
    if (theme === 'dark') {
      icon.innerHTML = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';
    } else if (theme === 'light') {
      icon.innerHTML = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>';
    } else {
      // auto — half-circle
      icon.innerHTML = '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor"/>';
    }
  }
  var btn = document.getElementById('theme-toggle');
  if (btn) btn.title = 'Theme: ' + theme + ' (click to change)';
}

async function initTheme() {
  var stored = await new Promise(function(r) {
    chrome.storage.local.get([THEME_KEY], function(res) { r(res[THEME_KEY] || 'auto'); });
  });
  applyTheme(stored);
  // Follow OS theme changes live while in auto mode.
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function() {
      if (themeChoice === 'auto') applyTheme('auto');
    });
  }
  var btn = document.getElementById('theme-toggle');
  if (btn) {
    btn.addEventListener('click', function() {
      var next = THEME_CYCLE[(THEME_CYCLE.indexOf(themeChoice) + 1) % THEME_CYCLE.length];
      applyTheme(next);
      chrome.storage.local.set({ [THEME_KEY]: next });
      showToast('Theme: ' + next, 'success');
    });
  }
}

// ── Live parse preview ────────────────────────────────────────────────────────

function updateParsePreview() {
  var preview = $('parse-preview');
  var text = $('paste-input').value.trim();
  if (!text) { preview.style.display = 'none'; return; }

  var messages = parseConversationText(text);
  if (!messages || messages.length === 0) {
    preview.className = 'parse-preview parse-warn';
    preview.style.display = 'flex';
    preview.innerHTML = '<span class="pp-count">⚠ Could not detect message boundaries — will use blank-line splitting</span>';
    return;
  }

  var userCount = messages.filter(function(m) { return m.role === 'user'; }).length;
  var asstCount = messages.filter(function(m) { return m.role === 'assistant'; }).length;
  var totalChars = messages.reduce(function(a, m) { return a + m.content.length; }, 0);

  preview.className = 'parse-preview';
  preview.style.display = 'flex';
  preview.innerHTML =
    '<span class="pp-count">' +
    '✓ ' + messages.length + ' message' + (messages.length !== 1 ? 's' : '') + ' detected &nbsp;' +
    '<span class="pp-pill user">You &times;' + userCount + '</span>' +
    '<span class="pp-pill asst">AI &times;' + asstCount + '</span>' +
    '</span>' +
    '<span style="font-size:10px;opacity:0.7">' + (totalChars / 1000).toFixed(1) + 'k chars</span>';
}

// ── Smart Slice ──────────────────────────────────────────────────────────────
// Query-aware inject: user types their next question, backend returns a
// focused 500-800 token slice across all their sessions. Savings tracked
// in chrome.storage.local.cb_savings.

const SLICE_DRAFT_KEY = 'cb_slice_draft';
const SAVINGS_KEY = 'cb_savings';

function currentMonthKey() {
  var d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function readSavings() {
  return new Promise((resolve) => {
    chrome.storage.local.get([SAVINGS_KEY], (r) => {
      var s = r[SAVINGS_KEY];
      var mo = currentMonthKey();
      if (!s || s.month !== mo) s = { month: mo, tokens_saved: 0 };
      resolve(s);
    });
  });
}

async function addSavings(tokens) {
  if (!tokens || tokens <= 0) return;
  var s = await readSavings();
  s.tokens_saved += Math.max(0, Math.round(tokens));
  await new Promise((r) => chrome.storage.local.set({ [SAVINGS_KEY]: s }, r));
  renderSavingsChip(s);
}

function formatTokenCount(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'K';
  return String(n);
}

async function renderSavingsChip(s) {
  s = s || (await readSavings());
  var chip = $('savings-chip');
  var txt = $('savings-chip-text');
  if (!chip || !txt) return;
  if (s.tokens_saved <= 0) { chip.style.display = 'none'; return; }
  chip.style.display = 'inline-flex';
  txt.textContent = formatTokenCount(s.tokens_saved) + ' saved';
}

// ── Pro paywall — fake-door demand test ──────────────────────────────────────
// Shown contextually once the user has demonstrated real usage (savings > 0
// or 3+ captures), never on first open. Measures paywall_view / paywall_click
// / waitlist join rate — the CTR signal for the 30-day consumer-demand test.

const PAYWALL_SEEN_KEY = 'cb_paywall_seen_this_session';

async function initProPaywall() {
  var banner = $('pro-banner');
  var copyEl = $('pro-banner-copy');
  var btn = $('pro-banner-btn');
  if (!banner || !btn) return;

  var savings = await readSavings();
  var sessionCount = await new Promise((r) => loadSessions((ss) => r(ss.length)));

  var shouldShow = savings.tokens_saved > 0 || sessionCount >= 3;
  if (!shouldShow) return;

  if (savings.tokens_saved > 0) {
    copyEl.textContent = 'You’ve saved ' + formatTokenCount(savings.tokens_saved) + ' tokens this month — go unlimited with Pro';
  } else {
    copyEl.textContent = 'Upgrade to Pro for unlimited Smart Slice + priority support';
  }
  banner.style.display = 'flex';

  // Fire paywall_view once per popup session, not on every render.
  if (!window.__cbPaywallViewed) {
    window.__cbPaywallViewed = true;
    if (window.CBTelemetry) window.CBTelemetry.trackEvent('paywall_view', { trigger: savings.tokens_saved > 0 ? 'savings' : 'session_count' });
  }

  btn.addEventListener('click', () => {
    if (window.CBTelemetry) window.CBTelemetry.trackEvent('paywall_click');
    showProWaitlistModal();
  });
}

function showProWaitlistModal() {
  var existing = document.getElementById('pro-modal');
  if (existing) existing.remove();
  var modal = document.createElement('div');
  modal.id = 'pro-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-box pro-modal-box">
      <div class="modal-header">
        <div class="modal-title">ConteXetu Pro</div>
        <button class="modal-close-btn" id="pro-modal-close">&times;</button>
      </div>
      <div class="pro-modal-body">
        <p class="pro-modal-lead">Pro is almost ready. Join the waitlist and we'll email you the moment it opens — early joiners get founder pricing.</p>
        <ul class="pro-feature-list">
          <li>Unlimited Smart Slice queries</li>
          <li>Priority model support (GPT-5, Gemini 3)</li>
          <li>Team-shared memory (coming soon)</li>
        </ul>
        <input type="email" id="pro-waitlist-email" class="pro-waitlist-input" placeholder="you@email.com" />
        <button class="capture-btn" id="pro-waitlist-submit" style="width:100%">Join waitlist</button>
        <div class="pro-modal-status" id="pro-modal-status"></div>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  $('pro-modal-close').addEventListener('click', () => modal.remove());

  $('pro-waitlist-submit').addEventListener('click', async () => {
    var emailInput = $('pro-waitlist-email');
    var statusEl = $('pro-modal-status');
    var email = emailInput.value.trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      statusEl.innerHTML = '<span class="inject-error">Enter a valid email, or leave blank to just register interest.</span>';
      return;
    }
    try {
      var backendUrl = await getBackendUrl();
      var userId = await getUserId();
      await fetch(backendUrl + '/events/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, email: email || null, source: 'popup_banner' }),
      });
      statusEl.innerHTML = '<span class="inject-success">&#10003; You\'re on the list. We\'ll be in touch.</span>';
      setTimeout(() => modal.remove(), 1800);
    } catch (err) {
      statusEl.innerHTML = '<span class="inject-error">Couldn\'t join right now — try again shortly.</span>';
    }
  });
}

function initSliceComposer() {
  var toggle = $('slice-toggle');
  var body = $('slice-body');
  var caret = $('slice-toggle-caret');
  var query = $('slice-query');
  var runBtn = $('slice-run');
  var hint = $('slice-hint');
  if (!toggle || !body) return;

  toggle.addEventListener('click', () => {
    var hidden = body.classList.toggle('hidden');
    if (caret) caret.textContent = hidden ? '\u2193' : '\u2191';
    if (!hidden) { try { query.focus(); } catch (e) {} }
  });

  // Restore draft
  try {
    chrome.storage.session.get([SLICE_DRAFT_KEY], (r) => {
      if (r && r[SLICE_DRAFT_KEY]) {
        query.value = r[SLICE_DRAFT_KEY];
        runBtn.disabled = query.value.trim().length < 3;
      }
    });
  } catch (e) {}

  query.addEventListener('input', () => {
    runBtn.disabled = query.value.trim().length < 3;
    try { chrome.storage.session.set({ [SLICE_DRAFT_KEY]: query.value }); } catch (e) {}
  });

  // Enter = slice, Shift+Enter = newline
  query.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !runBtn.disabled) {
      e.preventDefault();
      runBtn.click();
    }
  });

  runBtn.addEventListener('click', async () => {
    var q = query.value.trim();
    if (q.length < 3) return;
    var target = $('slice-target').value || 'claude';
    runBtn.disabled = true;
    runBtn.textContent = 'Slicing…';
    hint.textContent = '';
    try {
      await runSmartSlice(q, target);
    } catch (err) {
      hint.textContent = 'Slice failed: ' + err.message;
      hint.className = 'slice-hint slice-hint-error';
    } finally {
      runBtn.disabled = false;
      runBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> Smart Slice';
    }
  });
}

async function runSmartSlice(query, targetModel) {
  var backendUrl = await getBackendUrl();
  var userId = await getUserId();
  var body = { user_id: userId, query: query, target_model: targetModel };
  if (targetModel !== 'claude' && targetModel !== 'markdown') body.format = 'markdown';

  var res = await fetch(backendUrl + '/context/slice', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    var err = await res.json().catch(() => ({}));
    throw new Error(err.error || ('Backend error ' + res.status));
  }
  var data = await res.json();

  if (data.empty) {
    var hint = $('slice-hint');
    if (hint) {
      hint.className = 'slice-hint slice-hint-warn';
      hint.textContent = data.reason === 'no_items_indexed'
        ? 'No indexed items yet. Capture a session first.'
        : 'Nothing to slice.';
    }
    return;
  }

  if (window.CBTelemetry) {
    window.CBTelemetry.trackEvent('slice_run', {
      target_model: targetModel,
      token_count: data.token_count,
      savings_pct: (data.slice_meta || {}).savings_pct,
    });
  }

  showSlicePreviewModal({ query: query, targetModel: targetModel, result: data });
}

function showSlicePreviewModal(opts) {
  var query = opts.query;
  var targetModel = opts.targetModel;
  var data = opts.result;
  var meta = data.slice_meta || {};
  var picked = meta.picked || [];
  var formatted = data.formatted_prompt || '';
  var tokenCount = data.token_count || 0;
  var fullEst = meta.full_token_estimate || 0;
  var savingsTokens = Math.max(0, fullEst - tokenCount);
  var savingsPct = meta.savings_pct || 0;
  var lowConf = !!meta.low_confidence;

  var existing = document.getElementById('slice-modal');
  if (existing) existing.remove();

  var modal = document.createElement('div');
  modal.id = 'slice-modal';
  modal.className = 'modal-overlay';

  // Group picked items by session
  var bySession = new Map();
  picked.forEach(function(p, idx) {
    if (!bySession.has(p.session_id)) {
      bySession.set(p.session_id, { title: p.session_title || 'Untitled', source: p.source_model || '', items: [] });
    }
    bySession.get(p.session_id).items.push({ ...p, _idx: idx });
  });

  var maxScore = picked.reduce(function(m, p) { return Math.max(m, p.score || 0); }, 0.0001);

  // Compact similarity pill — relevance class instead of a decimal.
  function relevancePill(sim) {
    if (sim >= 0.55) return { label: 'strong match', cls: 'slice-rel-strong' };
    if (sim >= 0.35) return { label: 'good match', cls: 'slice-rel-good' };
    if (sim >= 0.2) return { label: 'loose', cls: 'slice-rel-loose' };
    return { label: 'weak', cls: 'slice-rel-weak' };
  }
  // Importance dots instead of CRITICAL spam (structurer marks everything 5).
  function impDots(n) {
    n = Math.max(1, Math.min(5, Number(n) || 3));
    return '<span class="slice-imp-dots" title="importance ' + n + '/5">' +
      '&#9679;'.repeat(n) + '<span class="slice-imp-dim">' + '&#9679;'.repeat(5 - n) + '</span>' +
      '</span>';
  }

  var sessionHtml = '';
  bySession.forEach(function(sess, sid) {
    sessionHtml += '<div class="slice-session-group">';
    sessionHtml += '<div class="slice-session-head" data-sid="' + escHtml(sid) + '">' +
      '<span class="slice-session-caret">&#9662;</span>' +
      '<span class="slice-session-title">' + escHtml(sess.title) + '</span>' +
      '<span class="slice-session-pill">' + sess.items.length + '</span>' +
      '<span class="slice-session-meta">' + escHtml(sess.source) + '</span>' +
      '</div>';
    sessionHtml += '<ul class="slice-item-list">';
    sess.items.forEach(function(it) {
      var pct = Math.round((it.score / maxScore) * 100);
      var pill = relevancePill(it.similarity || 0);
      sessionHtml += '<li class="slice-item" data-idx="' + it._idx + '">' +
        '<label class="slice-item-label">' +
        '<input type="checkbox" class="slice-item-check" data-idx="' + it._idx + '" checked />' +
        '<div class="slice-item-body">' +
        '<div class="slice-item-meta">' +
        '<span class="slice-item-cat">' + escHtml(it.category) + '</span>' +
        impDots(it.importance) +
        '<span class="slice-rel-pill ' + pill.cls + '">' + pill.label + '</span>' +
        '</div>' +
        '<div class="slice-item-text">' + escHtml(it.text) + '</div>' +
        '<div class="slice-score-bar"><div class="slice-score-bar-fill" style="width:' + pct + '%"></div></div>' +
        '</div>' +
        '</label>' +
        '</li>';
    });
    sessionHtml += '</ul></div>';
  });

  var warnBanner = lowConf
    ? '<div class="low-confidence-banner">' +
        '<span class="lcb-icon">&#9888;</span>' +
        '<div class="lcb-text"><strong>Loose match.</strong> Your question doesn\'t strongly overlap with saved context. ' +
        'Slice quality may be poor — consider rewording or skipping the slice.</div>' +
        '<button class="lcb-skip-btn" id="slice-skip-to-full" type="button">Use full session instead</button>' +
      '</div>'
    : '';

  var savingsChip = savingsPct > 0
    ? '<span class="slice-stat-chip slice-savings" title="Full inject would have been ~' + fullEst + ' tokens">' +
        '&#9889; ' + savingsPct + '% smaller &middot; ' + tokenCount + ' tokens</span>'
    : '<span class="slice-stat-chip">' + tokenCount + ' tokens</span>';

  modal.innerHTML =
    '<div class="modal-box slice-modal-box">' +
      '<div class="modal-header">' +
        '<div class="modal-title">Slice Preview</div>' +
        '<button class="modal-close-btn" id="slice-modal-close">&times;</button>' +
      '</div>' +
      '<div class="slice-query-display">' +
        '<span class="slice-query-label">Query:</span> ' + escHtml(query) +
      '</div>' +
      '<div class="slice-stats">' +
        savingsChip +
        '<span class="slice-stat-chip">' + picked.length + ' items picked</span>' +
        '<span class="slice-stat-chip">' + (meta.excluded_count || 0) + ' excluded</span>' +
      '</div>' +
      warnBanner +
      '<div class="slice-items-scroll">' + (sessionHtml || '<div class="empty-state">No items selected.</div>') + '</div>' +
      '<div class="slice-modal-actions">' +
        '<button class="inject-confirm-btn" id="slice-inject-btn">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>' +
        ' Inject slice</button>' +
        '<button class="copy-json-btn" id="slice-copy-btn">Copy</button>' +
        '<button class="modal-cancel-btn" id="slice-cancel-btn">Cancel</button>' +
      '</div>' +
      '<div class="inject-status" id="slice-status"></div>' +
    '</div>';

  document.body.appendChild(modal);

  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  $('slice-modal-close').addEventListener('click', () => modal.remove());
  $('slice-cancel-btn').addEventListener('click', () => modal.remove());

  // Collapse/expand session groups on header click.
  modal.querySelectorAll('.slice-session-head').forEach((head) => {
    head.addEventListener('click', () => {
      var group = head.parentElement;
      group.classList.toggle('collapsed');
    });
  });

  // Escape hatch on low-confidence — dismiss modal, prompt user to pick a session.
  var skipBtn = document.getElementById('slice-skip-to-full');
  if (skipBtn) {
    skipBtn.addEventListener('click', () => {
      modal.remove();
      showToast('Pick a session below and click Inject for full context', 'success');
      try { document.getElementById('sessions-list')?.scrollIntoView({ behavior: 'smooth' }); } catch (e) {}
    });
  }

  // Copy button — copies the current (possibly checkbox-filtered) prompt.
  $('slice-copy-btn').addEventListener('click', async () => {
    var text = buildFilteredSliceText(formatted, picked, modal);
    try {
      await navigator.clipboard.writeText(text);
      $('slice-status').innerHTML = '<span class="inject-success">&#10003; Copied to clipboard.</span>';
    } catch (err) {
      $('slice-status').innerHTML = '<span class="inject-error">Copy failed: ' + escHtml(err.message) + '</span>';
    }
  });

  $('slice-inject-btn').addEventListener('click', async () => {
    var btn = $('slice-inject-btn');
    var statusEl = $('slice-status');
    btn.disabled = true;
    try {
      var text = buildFilteredSliceText(formatted, picked, modal);
      await navigator.clipboard.writeText(text);

      // Clear query draft — the question's been used.
      try { chrome.storage.session.remove([SLICE_DRAFT_KEY]); } catch (e) {}

      // Track savings on successful inject
      addSavings(savingsTokens);
      if (window.CBTelemetry) window.CBTelemetry.trackEvent('inject_success', { target_model: targetModel, token_count: tokenCount, via: 'smart_slice' });

      var valueHeadline = savingsPct > 0
        ? 'Briefed ' + modelLabel(targetModel) + ' — ' + savingsPct + '% leaner'
        : 'Briefed ' + modelLabel(targetModel) + ' — no re-explaining needed';
      var valueStat = '~' + tokenCount + ' tokens' + (savingsPct > 0 ? ', ' + savingsTokens + ' saved vs. full context' : ' of your context, injected instantly');

      if (targetModel === 'markdown') {
        statusEl.innerHTML = '<span class="inject-success">&#10003; Markdown copied — paste anywhere.</span>';
        setTimeout(() => { modal.remove(); showValueToast(valueHeadline, valueStat); }, 1500);
        return;
      }

      var hostMatch = MODEL_HOSTS[targetModel] || null;
      var allTabs = await chrome.tabs.query({});
      var targetTab = hostMatch ? allTabs.find((t) => t.url && t.url.includes(hostMatch)) : null;

      if (targetTab && MODEL_HOSTS[targetModel]) {
        var injectorFunc = injectorFor(targetModel);
        var injResult = await chrome.scripting.executeScript({
          target: { tabId: targetTab.id },
          func: injectorFunc,
          args: [text],
        });
        var r = injResult?.[0]?.result;
        await chrome.tabs.update(targetTab.id, { active: true });
        if (r && r.success) {
          statusEl.innerHTML = '<span class="inject-success">&#10003; Injected into ' + modelLabel(targetModel) + '.</span>';
          setTimeout(() => { modal.remove(); showValueToast(valueHeadline, valueStat); }, 1500);
          return;
        }
      }
      statusEl.innerHTML = '<span class="inject-success">&#10003; Copied — paste into ' + modelLabel(targetModel) + '.</span>';
      setTimeout(() => { modal.remove(); showValueToast(valueHeadline, valueStat); }, 2200);
    } catch (err) {
      statusEl.innerHTML = '<span class="inject-error">' + escHtml(err.message) + '</span>';
      btn.disabled = false;
    }
  });
}

// If user unchecked some items, produce a text variant that excludes them.
// For simplicity we do line-level exclusion — works against all adapter outputs
// since item text appears verbatim in each format.
function buildFilteredSliceText(originalFormatted, picked, modal) {
  var unchecked = [];
  modal.querySelectorAll('.slice-item-check').forEach((cb) => {
    if (!cb.checked) {
      var idx = Number(cb.dataset.idx);
      if (picked[idx] && picked[idx].text) unchecked.push(picked[idx].text);
    }
  });
  if (unchecked.length === 0) return originalFormatted;
  var out = originalFormatted;
  unchecked.forEach((t) => {
    // Remove any line containing the excluded item text
    var lines = out.split('\n').filter((line) => line.indexOf(t) === -1);
    out = lines.join('\n');
  });
  return out;
}

// ── Folders + org (rename, move, trash, version history) ─────────────────────
// Folders live on the server (source of truth). We cache the list in
// chrome.storage.local for snappy chip rendering and reload on any mutation.

const FOLDERS_KEY = 'cb_folders';
// currentFolderFilter: null = all, 'inbox' = un-foldered, 'trash' = trash view,
// or a folder UUID string.
let currentFolderFilter = null;

function readFoldersCache() {
  return new Promise((r) => chrome.storage.local.get([FOLDERS_KEY], (v) => r(v[FOLDERS_KEY] || [])));
}
function writeFoldersCache(folders) {
  return new Promise((r) => chrome.storage.local.set({ [FOLDERS_KEY]: folders }, r));
}

async function apiListFolders() {
  var backend = await getBackendUrl();
  var userId = await getUserId();
  var res = await fetch(backend + '/folders?user_id=' + encodeURIComponent(userId));
  if (!res.ok) throw new Error('Failed to load folders');
  var data = await res.json();
  return data.folders || [];
}

async function apiCreateFolder(name) {
  var backend = await getBackendUrl();
  var userId = await getUserId();
  var res = await fetch(backend + '/folders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId, name }),
  });
  if (!res.ok) { var err = await res.json().catch(() => ({})); throw new Error(err.error || 'Create failed'); }
  return res.json();
}

async function apiRenameFolder(folderId, name) {
  var backend = await getBackendUrl();
  var userId = await getUserId();
  var res = await fetch(backend + '/folders/' + folderId, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId, name }),
  });
  if (!res.ok) { var err = await res.json().catch(() => ({})); throw new Error(err.error || 'Rename failed'); }
  return res.json();
}

async function apiDeleteFolder(folderId) {
  var backend = await getBackendUrl();
  var userId = await getUserId();
  var res = await fetch(backend + '/folders/' + folderId + '?user_id=' + encodeURIComponent(userId), { method: 'DELETE' });
  if (!res.ok) { var err = await res.json().catch(() => ({})); throw new Error(err.error || 'Delete failed'); }
  return true;
}

async function apiPatchSession(sessionId, patch) {
  var backend = await getBackendUrl();
  var userId = await getUserId();
  var res = await fetch(backend + '/context/' + sessionId, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId, ...patch }),
  });
  if (!res.ok) { var err = await res.json().catch(() => ({})); throw new Error(err.error || 'Update failed'); }
  return res.json();
}

async function apiSoftDeleteSession(sessionId) {
  var backend = await getBackendUrl();
  var userId = await getUserId();
  var res = await fetch(backend + '/context/' + sessionId + '?user_id=' + encodeURIComponent(userId), { method: 'DELETE' });
  if (!res.ok) { var err = await res.json().catch(() => ({})); throw new Error(err.error || 'Delete failed'); }
  return true;
}

async function apiRestoreSession(sessionId) {
  var backend = await getBackendUrl();
  var userId = await getUserId();
  var res = await fetch(backend + '/context/' + sessionId + '/restore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId }),
  });
  if (!res.ok) { var err = await res.json().catch(() => ({})); throw new Error(err.error || 'Restore failed'); }
  return true;
}

async function apiPurgeSession(sessionId) {
  var backend = await getBackendUrl();
  var userId = await getUserId();
  var res = await fetch(backend + '/context/' + sessionId + '/purge?user_id=' + encodeURIComponent(userId), { method: 'DELETE' });
  if (!res.ok) { var err = await res.json().catch(() => ({})); throw new Error(err.error || 'Purge failed'); }
  return true;
}

async function apiListTrash() {
  var backend = await getBackendUrl();
  var userId = await getUserId();
  var res = await fetch(backend + '/context/trash?user_id=' + encodeURIComponent(userId));
  if (!res.ok) throw new Error('Failed to load trash');
  var data = await res.json();
  return data.sessions || [];
}

async function apiListVersions(sessionId) {
  var backend = await getBackendUrl();
  var userId = await getUserId();
  var res = await fetch(backend + '/context/' + sessionId + '/versions?user_id=' + encodeURIComponent(userId));
  if (!res.ok) throw new Error('Failed to load versions');
  var data = await res.json();
  return data.versions || [];
}

async function apiRestoreVersion(sessionId, version) {
  var backend = await getBackendUrl();
  var userId = await getUserId();
  var res = await fetch(backend + '/context/' + sessionId + '/versions/' + version + '/restore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId }),
  });
  if (!res.ok) { var err = await res.json().catch(() => ({})); throw new Error(err.error || 'Restore failed'); }
  return true;
}

// ── Folder rail rendering ────────────────────────────────────────────────────

async function refreshFolders() {
  try {
    var folders = await apiListFolders();
    await writeFoldersCache(folders);
    renderFolderRail(folders);
  } catch (err) {
    console.warn('[folders] refresh failed:', err.message);
    // Render whatever we have cached so the UI isn't blank.
    var cached = await readFoldersCache();
    renderFolderRail(cached);
  }
}

function renderFolderRail(folders) {
  var rail = $('folder-rail');
  if (!rail) return;
  var chips = [];
  var activeAll = currentFolderFilter === null ? ' active' : '';
  var activeInbox = currentFolderFilter === 'inbox' ? ' active' : '';
  var activeTrash = currentFolderFilter === 'trash' ? ' active' : '';
  chips.push(`<button class="folder-chip${activeAll}" data-fid="all">All</button>`);
  chips.push(`<button class="folder-chip${activeInbox}" data-fid="inbox">📥 Inbox</button>`);
  folders.forEach((f) => {
    var active = currentFolderFilter === f.id ? ' active' : '';
    chips.push(`<button class="folder-chip${active}" data-fid="${escHtml(f.id)}" title="Rename or delete: right-click">📁 ${escHtml(f.name)} <span class="folder-count">${f.session_count}</span></button>`);
  });
  chips.push(`<button class="folder-chip folder-chip-new" data-fid="new">＋</button>`);
  chips.push(`<button class="folder-chip folder-chip-trash${activeTrash}" data-fid="trash">🗑</button>`);
  rail.innerHTML = chips.join('');

  rail.querySelectorAll('.folder-chip').forEach((chip) => {
    chip.addEventListener('click', async () => {
      var fid = chip.dataset.fid;
      if (fid === 'new') return handleCreateFolder();
      currentFolderFilter = fid === 'all' ? null : fid;
      renderFolderRail(folders);
      renderSessions();
    });
    // Right-click on a real folder chip = rename/delete
    if (chip.dataset.fid && chip.dataset.fid !== 'all' && chip.dataset.fid !== 'inbox'
        && chip.dataset.fid !== 'new' && chip.dataset.fid !== 'trash') {
      chip.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        var f = folders.find((x) => x.id === chip.dataset.fid);
        if (f) openFolderContextMenu(chip, f);
      });
    }
  });
}

async function handleCreateFolder() {
  var name = prompt('New folder name:');
  if (!name || !name.trim()) return;
  try {
    await apiCreateFolder(name.trim());
    showToast('Folder created', 'success');
    await refreshFolders();
  } catch (err) {
    showToast('Create failed: ' + err.message, 'error');
  }
}

function openFolderContextMenu(anchor, folder) {
  closeAnyKebab();
  var rect = anchor.getBoundingClientRect();
  var menu = document.createElement('div');
  menu.className = 'kebab-menu';
  menu.style.top = (rect.bottom + 4) + 'px';
  menu.style.left = rect.left + 'px';
  menu.innerHTML =
    '<button class="kebab-item" data-act="rename">✏️ Rename</button>' +
    '<button class="kebab-item" data-act="delete">🗑 Delete folder</button>';
  document.body.appendChild(menu);
  menu.querySelector('[data-act="rename"]').addEventListener('click', async () => {
    closeAnyKebab();
    var name = prompt('Rename folder:', folder.name);
    if (!name || !name.trim() || name === folder.name) return;
    try { await apiRenameFolder(folder.id, name.trim()); showToast('Renamed', 'success'); await refreshFolders(); }
    catch (err) { showToast('Rename failed: ' + err.message, 'error'); }
  });
  menu.querySelector('[data-act="delete"]').addEventListener('click', async () => {
    closeAnyKebab();
    if (!confirm(`Delete folder "${folder.name}"? Sessions inside will move to Inbox.`)) return;
    try {
      await apiDeleteFolder(folder.id);
      if (currentFolderFilter === folder.id) currentFolderFilter = null;
      showToast('Folder deleted', 'success');
      await refreshFolders();
      renderSessions();
    } catch (err) { showToast('Delete failed: ' + err.message, 'error'); }
  });
  setTimeout(() => document.addEventListener('click', closeAnyKebab, { once: true }), 0);
}

// ── Session card kebab menu ──────────────────────────────────────────────────

function closeAnyKebab() {
  document.querySelectorAll('.kebab-menu').forEach((el) => el.remove());
}

async function openKebabMenu(anchor, session, cardIndex) {
  if (!session) return;
  closeAnyKebab();
  var folders = await readFoldersCache();
  var rect = anchor.getBoundingClientRect();
  var menu = document.createElement('div');
  menu.className = 'kebab-menu';
  menu.style.top = (rect.bottom + 4) + 'px';
  // Right-align to the button so it doesn't overflow the popup
  menu.style.right = (window.innerWidth - rect.right) + 'px';
  var folderOpts = ['<div class="kebab-sub-label">Move to</div>',
    '<button class="kebab-item" data-move="inbox">📥 Inbox</button>'];
  folders.forEach((f) => {
    folderOpts.push('<button class="kebab-item" data-move="' + escHtml(f.id) + '">📁 ' + escHtml(f.name) + '</button>');
  });
  folderOpts.push('<button class="kebab-item kebab-item-secondary" data-move="new">＋ New folder…</button>');
  menu.innerHTML =
    '<button class="kebab-item" data-act="rename">✏️ Rename</button>' +
    '<button class="kebab-item" data-act="history">🕒 Version history</button>' +
    '<div class="kebab-divider"></div>' +
    folderOpts.join('') +
    '<div class="kebab-divider"></div>' +
    '<button class="kebab-item kebab-item-danger" data-act="delete">🗑 Delete</button>';
  document.body.appendChild(menu);

  menu.querySelector('[data-act="rename"]').addEventListener('click', () => {
    closeAnyKebab();
    handleRenameSession(session, cardIndex);
  });
  menu.querySelector('[data-act="history"]').addEventListener('click', () => {
    closeAnyKebab();
    showVersionHistoryModal(session);
  });
  menu.querySelector('[data-act="delete"]').addEventListener('click', async () => {
    closeAnyKebab();
    if (!confirm('Move this session to Trash?')) return;
    handleSoftDelete(cardIndex);
  });
  menu.querySelectorAll('[data-move]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      closeAnyKebab();
      var to = btn.dataset.move;
      if (to === 'new') {
        var name = prompt('New folder name:');
        if (!name || !name.trim()) return;
        try {
          var f = await apiCreateFolder(name.trim());
          await refreshFolders();
          await handleMoveToFolder(session, cardIndex, f.id);
        } catch (err) { showToast('Create failed: ' + err.message, 'error'); }
        return;
      }
      handleMoveToFolder(session, cardIndex, to === 'inbox' ? null : to);
    });
  });

  setTimeout(() => document.addEventListener('click', closeAnyKebab, { once: true }), 0);
}

async function handleRenameSession(session, index) {
  var newTitle = prompt('Rename session:', session.title || '');
  if (!newTitle || !newTitle.trim() || newTitle === session.title) return;
  try {
    var updated = await apiPatchSession(session.session_id, { title: newTitle.trim() });
    // Update local cache
    loadSessions((ss) => {
      if (ss[index] && ss[index].session_id === session.session_id) ss[index].title = updated.title;
      chrome.storage.local.set({ [SESSIONS_KEY]: ss }, () => renderSessions());
    });
    showToast('Renamed', 'success');
  } catch (err) {
    showToast('Rename failed: ' + err.message, 'error');
  }
}

async function handleMoveToFolder(session, index, folderId) {
  try {
    var updated = await apiPatchSession(session.session_id, { folder_id: folderId });
    var folders = await readFoldersCache();
    var folderName = folderId ? (folders.find((f) => f.id === folderId) || {}).name : null;
    loadSessions((ss) => {
      if (ss[index] && ss[index].session_id === session.session_id) {
        ss[index].folder_id = updated.folder_id;
        ss[index].folder_name = folderName;
      }
      chrome.storage.local.set({ [SESSIONS_KEY]: ss }, () => renderSessions());
    });
    showToast(folderId ? 'Moved to ' + folderName : 'Moved to Inbox', 'success');
    refreshFolders(); // counts changed
  } catch (err) {
    showToast('Move failed: ' + err.message, 'error');
  }
}

async function handleSoftDelete(index) {
  loadSessions(async (ss) => {
    var s = ss[index];
    if (!s) return;
    try {
      if (s.session_id) await apiSoftDeleteSession(s.session_id);
      ss.splice(index, 1);
      chrome.storage.local.set({ [SESSIONS_KEY]: ss }, () => {
        renderSessions();
        refreshFolders();
      });
      showToast('Moved to Trash', 'success');
    } catch (err) {
      showToast('Delete failed: ' + err.message, 'error');
    }
  });
}

// ── Trash view ──────────────────────────────────────────────────────────────

async function renderTrashView() {
  var list = $('sessions-list');
  if (!list) return;
  list.innerHTML = '<p class="empty-state">Loading trash…</p>';
  try {
    var items = await apiListTrash();
    if (items.length === 0) {
      list.innerHTML = '<p class="empty-state">Trash is empty.</p>';
      return;
    }
    list.innerHTML = items.map((s, i) => {
      return `<div class="session-card">
        <div class="sc-row">
          <div class="sc-info">
            <div class="sc-title">${escHtml(s.title || 'Untitled')}</div>
            <div class="sc-meta"><span class="sc-model-badge">${escHtml(modelLabel(s.source_model))}</span>Deleted ${timeAgo(s.deleted_at || s.created_at)}</div>
          </div>
        </div>
        <div class="sc-actions">
          <button class="inject-session-btn" data-act="restore" data-id="${escHtml(s.id)}">Restore</button>
          <button class="delete-session-btn trash-purge-btn" data-act="purge" data-id="${escHtml(s.id)}" title="Delete forever">Delete forever</button>
        </div>
      </div>`;
    }).join('');

    list.querySelectorAll('[data-act="restore"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await apiRestoreSession(btn.dataset.id);
          showToast('Restored', 'success');
          renderTrashView();
          refreshFolders();
        } catch (err) { showToast('Restore failed: ' + err.message, 'error'); }
      });
    });
    list.querySelectorAll('[data-act="purge"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Permanently delete this session? This cannot be undone.')) return;
        try {
          await apiPurgeSession(btn.dataset.id);
          showToast('Deleted forever', 'success');
          renderTrashView();
        } catch (err) { showToast('Purge failed: ' + err.message, 'error'); }
      });
    });
  } catch (err) {
    list.innerHTML = '<p class="empty-state">Failed to load trash: ' + escHtml(err.message) + '</p>';
  }
}

// ── Version history modal ───────────────────────────────────────────────────

async function showVersionHistoryModal(session) {
  var existing = document.getElementById('vh-modal');
  if (existing) existing.remove();
  var modal = document.createElement('div');
  modal.id = 'vh-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-box">
      <div class="modal-header">
        <div class="modal-title">Version History</div>
        <button class="modal-close-btn" id="vh-close">&times;</button>
      </div>
      <div class="modal-session-name">${escHtml(session.title || 'Untitled')}</div>
      <div class="vh-list" id="vh-list"><p class="empty-state">Loading…</p></div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  $('vh-close').addEventListener('click', () => modal.remove());

  try {
    var versions = await apiListVersions(session.session_id);
    if (!versions.length) {
      $('vh-list').innerHTML = '<p class="empty-state">No history yet. Versions are recorded when the context changes (e.g. after a merge or restore).</p>';
      return;
    }
    // Newest first
    versions.sort((a, b) => Number(b.version_number) - Number(a.version_number));
    $('vh-list').innerHTML = versions.map((v) => {
      var ts = v.created_at ? new Date(v.created_at).toLocaleString() : '';
      var goalsN = Array.isArray(v.structured_context?.goals) ? v.structured_context.goals.length : 0;
      var decN = Array.isArray(v.structured_context?.decisions) ? v.structured_context.decisions.length : 0;
      return `<div class="vh-row">
        <div class="vh-meta">
          <div class="vh-ver">v${v.version_number}</div>
          <div class="vh-when">${escHtml(ts)}</div>
          <div class="vh-counts">${goalsN} goals · ${decN} decisions</div>
        </div>
        <button class="vh-restore-btn" data-v="${v.version_number}">Restore</button>
      </div>`;
    }).join('');
    $('vh-list').querySelectorAll('.vh-restore-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Restore this version? Current state will be snapshotted first.')) return;
        btn.disabled = true;
        try {
          await apiRestoreVersion(session.session_id, btn.dataset.v);
          showToast('Restored to v' + btn.dataset.v, 'success');
          modal.remove();
        } catch (err) {
          showToast('Restore failed: ' + err.message, 'error');
          btn.disabled = false;
        }
      });
    });
  } catch (err) {
    $('vh-list').innerHTML = '<p class="empty-state">Failed: ' + escHtml(err.message) + '</p>';
  }
}

// ── Filter session list by current folder ────────────────────────────────────
// Wrap the existing renderSessions in a pre-check for trash + folder filter.

const _origRenderSessions = renderSessions;
renderSessions = function() {
  if (currentFolderFilter === 'trash') {
    renderTrashView();
    return;
  }
  loadSessions((ss) => {
    var filtered = ss;
    if (currentFolderFilter === 'inbox') {
      filtered = ss.filter((s) => !s.folder_id);
    } else if (currentFolderFilter && currentFolderFilter !== null) {
      filtered = ss.filter((s) => s.folder_id === currentFolderFilter);
    }
    // Swap in filtered array temporarily
    chrome.storage.local.set({ __cb_sessions_view: filtered }, () => {
      // Redirect loadSessions to filtered view for this render
      var origLoad = loadSessions;
      loadSessions = function(cb) { cb(filtered); };
      try { _origRenderSessions(); } finally { loadSessions = origLoad; }
    });
  });
};

document.addEventListener('DOMContentLoaded', async () => {
  await initTheme();
  await detectActiveTab();
  checkHealth();
  refreshFolders(); // fire-and-forget; renders when ready
  renderSessions();
  $('capture-btn').addEventListener('click', handleCapture);
  $('paste-capture-btn').addEventListener('click', handlePasteCapture);
  $('paste-input').addEventListener('input', updateParsePreview);
  initSliceComposer();
  initDocumentCapture();
  renderSavingsChip();
  if (window.CBTelemetry) window.CBTelemetry.trackPopupOpen();
  initProPaywall();
});
