// Popup controller — calls chrome.scripting.executeScript directly. Zero message passing for capture.

const MAX_SESSIONS = 20;
const SESSIONS_KEY = 'cb_sessions';
const $ = (id) => document.getElementById(id);

let currentTab = null;
let currentSourceModel = null;
let lastCaptureResult = null;

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

function claudeScraper() {
  var MAX_CHARS = 15000;

  var debugTestIds = [];
  var debugClasses = [];
  document.querySelectorAll('[data-testid]').forEach(function(el) {
    var tid = el.getAttribute('data-testid');
    if (debugTestIds.indexOf(tid) === -1) debugTestIds.push(tid);
  });
  var kwds = ['message','turn','human','user','assistant','claude','chat','response','prose'];
  document.querySelectorAll('*').forEach(function(el) {
    if (el.classList) el.classList.forEach(function(cls) {
      for (var k = 0; k < kwds.length; k++) {
        if (cls.toLowerCase().indexOf(kwds[k]) !== -1 && debugClasses.indexOf(cls) === -1) debugClasses.push(cls);
      }
    });
  });

  var ASSISTANT_SELS = [
    '.font-claude-message',
    '[data-testid="assistant-message"]',
    '[data-testid="chat-message-text"]',
    '[data-testid="assistant-turn"]',
    'div[class*="claude-message"]',
    'div[class*="AssistantMessage"]',
    'div[class*="assistant-"]',
    'div[class*="response-"]',
    '.prose',
  ];
  var USER_SELS = [
    '[data-testid="user-human-turn"]',
    '[data-testid="human-turn"]',
    '[data-testid="user-message"]',
    '.human-turn',
    'div[class*="human-turn"]',
    'div[class*="HumanTurn"]',
    'div[class*="user-turn"]',
    'div[class*="UserMessage"]',
  ];

  function queryAll(sels) {
    for (var i = 0; i < sels.length; i++) {
      try { var r = document.querySelectorAll(sels[i]); if (r.length) return { els: Array.from(r), sel: sels[i] }; } catch(e){}
    }
    return { els: [], sel: null };
  }

  var aResult = queryAll(ASSISTANT_SELS);
  var uResult = queryAll(USER_SELS);
  var aEls = aResult.els;
  var uEls = uResult.els;

  if (aEls.length === 0 && uEls.length === 0) {
    return {
      error: 'NO_MESSAGES',
      debug: {
        testIds: debugTestIds,
        messageClasses: debugClasses,
        assistantSel: aResult.sel,
        userSel: uResult.sel,
        url: window.location.href,
      }
    };
  }

  var tagged = [];
  for (var i = 0; i < aEls.length; i++) tagged.push({ el: aEls[i], role: 'assistant' });
  for (var i = 0; i < uEls.length; i++) tagged.push({ el: uEls[i], role: 'user' });

  tagged.sort(function(a, b) {
    var p = a.el.compareDocumentPosition(b.el);
    return (p & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : (p & Node.DOCUMENT_POSITION_PRECEDING) ? 1 : 0;
  });

  var messages = [];
  var totalLength = 0;
  for (var i = 0; i < tagged.length; i++) {
    var content = tagged[i].el.innerText.trim();
    if (!content) continue;
    if (totalLength + content.length > MAX_CHARS) {
      var rem = MAX_CHARS - totalLength;
      if (rem > 0) messages.push({ role: tagged[i].role, content: content.slice(0, rem) });
      break;
    }
    messages.push({ role: tagged[i].role, content: content });
    totalLength += content.length;
  }
  return messages.length === 0 ? { error: 'NO_MESSAGES', debug: { testIds: debugTestIds, messageClasses: debugClasses } } : messages;
}

// ── HTML helpers ──────────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function modelLabel(m) { return m === 'chatgpt' ? 'ChatGPT' : m === 'claude' ? 'Claude' : m; }
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
}
function deleteSession(index) {
  loadSessions((ss) => {
    ss.splice(index, 1);
    chrome.storage.local.set({ [SESSIONS_KEY]: ss }, () => renderSessions());
  });
}

// ── Render ────────────────────────────────────────────────────────────────────

function showSpinner(msg) {
  $('status-area').innerHTML = `<div class="spinner-wrap"><div class="spinner"></div><span>${escHtml(msg)}</span></div>`;
}

function showSuccess(result) {
  var goalCount = (result.goals||[]).length;
  var decisionCount = (result.decisions||[]).length;
  var techCount = (result.tech_stack||[]).length;
  var firstGoal = result.goals?.[0]||'';

  $('status-area').innerHTML = `
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

function clearStatus() { $('status-area').innerHTML = ''; }

function renderSessions() {
  loadSessions((sessions) => {
    var list = $('sessions-list');
    var countEl = $('sessions-count');

    if (!sessions.length) {
      list.innerHTML = '<p class="empty-state"><span class="empty-state-icon">&#128203;</span>No sessions yet. Capture a conversation to get started.</p>';
      countEl.style.display = 'none';
      return;
    }

    countEl.textContent = sessions.length;
    countEl.style.display = 'inline';

    list.innerHTML = sessions.slice(0,5).map((s,i) => `
      <div class="session-card">
        <div class="sc-row">
          <div class="sc-info">
            <div class="sc-title">${escHtml(s.title||'Untitled')}</div>
            <div class="sc-meta">
              <span class="sc-model-badge">${escHtml(modelLabel(s.source_model))}</span>
              ${timeAgo(s.created_at)}
            </div>
          </div>
          <button class="delete-session-btn" data-index="${i}" title="Delete session">&times;</button>
        </div>
        <div class="sc-actions">
          <button class="inject-session-btn" data-index="${i}">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>
            Transfer
          </button>
          <button class="download-session-btn" data-index="${i}">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            JSON
          </button>
        </div>
      </div>`).join('');

    list.querySelectorAll('.inject-session-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); loadSessions((ss) => showInjectModal(ss[Number(btn.dataset.index)])); });
    });
    list.querySelectorAll('.download-session-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        loadSessions((ss) => handleQuickDownload(ss[Number(btn.dataset.index)]));
      });
    });
    list.querySelectorAll('.delete-session-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm('Delete this session?')) deleteSession(Number(btn.dataset.index));
      });
    });
  });
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
    alert('Download failed: ' + err.message);
  }
}

// ── Tab detection ─────────────────────────────────────────────────────────────

async function detectActiveTab() {
  var [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;
  var url = tab?.url || '';
  if (url.includes('chatgpt.com')) {
    currentSourceModel = 'chatgpt';
    $('badge-text').textContent = 'ChatGPT detected';
    $('badge-dot').classList.add('active');
    $('capture-btn').disabled = false;
  } else if (url.includes('claude.ai')) {
    currentSourceModel = 'claude';
    $('badge-text').textContent = 'Claude detected';
    $('badge-dot').classList.add('active');
    $('capture-btn').disabled = false;
  } else {
    currentSourceModel = null;
    $('badge-text').textContent = 'No AI tab detected';
    $('badge-dot').classList.remove('active');
    $('capture-btn').disabled = true;
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
  } catch { $('conn-dot').className = 'conn-dot error'; $('conn-status').textContent = 'Backend unreachable'; }
}

// ── Capture — 100% in popup, ZERO message passing ─────────────────────────────

async function handleCapture() {
  if (!currentTab || !currentSourceModel) return;
  clearStatus();
  showSpinner('Scraping conversation...');
  $('capture-btn').disabled = true;

  try {
    var func = currentSourceModel === 'chatgpt' ? chatgptScraper : claudeScraper;
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
    persistSession({ session_id: result.session_id, title: result.title, source_model: currentSourceModel, goals: result.goals, decisions: result.decisions, tech_stack: result.tech_stack, created_at: new Date().toISOString() });
    showSuccess(result);
    renderSessions();

  } catch (err) {
    showError(err.message);
  } finally {
    $('capture-btn').disabled = !currentSourceModel;
  }
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
      </div>
      <div class="modal-actions">
        <button class="inject-confirm-btn" id="inject-confirm">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>
          Inject into Chat
        </button>
        <button class="copy-json-btn" id="paste-json">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>
          Paste JSON
        </button>
        <button class="download-json-btn" id="download-json">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Download
        </button>
        <button class="modal-cancel-btn" id="modal-cancel-bottom">Cancel</button>
      </div>
      <div class="inject-status" id="inject-status"></div>
    </div>`;
  document.body.appendChild(modal);

  // Close on overlay click
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  $('inject-cancel').addEventListener('click', () => modal.remove());
  $('modal-cancel-bottom').addEventListener('click', () => modal.remove());

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
      var jsonText = JSON.stringify(data.json_context, null, 2);

      // Try to paste directly into target tab
      var hostMatch = targetModel === 'chatgpt' ? 'chatgpt.com' : 'claude.ai';
      var allTabs = await chrome.tabs.query({});
      var targetTab = allTabs.find(function(t) { return t.url && t.url.includes(hostMatch); });

      if (targetTab) {
        var injectorFunc = targetModel === 'chatgpt' ? chatgptInjector : claudeInjector;
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
      var newUrl = targetModel === 'chatgpt' ? 'https://chatgpt.com/' : 'https://claude.ai/new';
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

      var res = await fetch(backendUrl + '/context/inject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: session.session_id, user_id: userId, target_model: targetModel, include: { goals: true, constraints: true, decisions: true } }),
      });
      if (!res.ok) { var err = await res.json().catch(() => ({})); throw new Error(err.error || 'Backend error'); }
      var data = await res.json();

      await navigator.clipboard.writeText(data.formatted_prompt);

      var hostMatch = targetModel === 'chatgpt' ? 'chatgpt.com' : 'claude.ai';
      var allTabs = await chrome.tabs.query({});
      var targetTab = allTabs.find(function(t) { return t.url && t.url.includes(hostMatch); });

      if (targetTab) {
        var injectorFunc = targetModel === 'chatgpt' ? chatgptInjector : claudeInjector;
        var injResult = await chrome.scripting.executeScript({
          target: { tabId: targetTab.id },
          func: injectorFunc,
          args: [data.formatted_prompt],
        });
        var r = injResult?.[0]?.result;
        if (r && r.success) {
          await chrome.tabs.update(targetTab.id, { active: true });
          statusEl.innerHTML = `<span class="inject-success">&#10003; Injected into ${modelLabel(targetModel)}!</span>`;
          setTimeout(() => modal.remove(), 1500);
          return;
        }
      }

      var newUrl = targetModel === 'chatgpt' ? 'https://chatgpt.com/' : 'https://claude.ai/new';
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

function chatgptInjector(text) {
  var sels = ['#prompt-textarea','div[contenteditable="true"][id="prompt-textarea"]','div[contenteditable="true"]'];
  var input = null;
  for (var i = 0; i < sels.length; i++) { try { input = document.querySelector(sels[i]); if (input) break; } catch(e){} }
  if (!input) return { error: 'INPUT_NOT_FOUND' };
  input.focus();
  if (input.tagName === 'TEXTAREA') {
    var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(input, text);
  } else {
    input.innerHTML = '';
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, text);
  }
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return { success: true };
}

function claudeInjector(text) {
  var sels = ['div.ProseMirror[contenteditable="true"]','div[contenteditable="true"]'];
  var input = null;
  for (var i = 0; i < sels.length; i++) { try { input = document.querySelector(sels[i]); if (input) break; } catch(e){} }
  if (!input) return { error: 'INPUT_NOT_FOUND' };
  input.focus();
  input.innerHTML = '';
  document.execCommand('selectAll', false, null);
  document.execCommand('insertText', false, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return { success: true };
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  await detectActiveTab();
  checkHealth();
  renderSessions();
  $('capture-btn').addEventListener('click', handleCapture);
});
