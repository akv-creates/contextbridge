// ConteXetu floating bridge — injects a floating action button + slide-in
// panel on supported sites (ChatGPT, Claude, Google Docs/Slides). Uses a Shadow
// DOM root so the host page's CSS can't bleed in and ours can't leak out, and
// so strict page CSPs (Google, ChatGPT) don't interfere — no iframe, no
// external resources, everything inline.

(function () {
  if (window.__contextBridgeFab) return;
  window.__contextBridgeFab = true;

  try {
    mount();
    console.log('[ConteXetu] floating bridge mounted on', location.host);
  } catch (err) {
    console.error('[ConteXetu] floating bridge failed to mount:', err);
  }

  function mount() {

  // Sites like ChatGPT and Google enforce a "Trusted Types" CSP, which
  // blocks any `el.innerHTML = htmlString` assignment outright (throws a
  // TypeError) — even on elements inside a Shadow DOM, even from a content
  // script. DOMParser.parseFromString() is explicitly NOT a Trusted Types
  // sink (it builds an inert, disconnected document — nothing in it ever
  // executes), so we parse markup there and move the resulting real DOM
  // nodes into place with appendChild, which is also unrestricted.
  function setHtml(el, html) {
    while (el.firstChild) el.removeChild(el.firstChild);
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var nodes = Array.prototype.slice.call(doc.head ? doc.head.childNodes : []).concat(
      Array.prototype.slice.call(doc.body ? doc.body.childNodes : [])
    );
    nodes.forEach(function (n) { el.appendChild(n); });
  }

  var host = location.host;
  var SITE =
    host.indexOf('chatgpt.com') !== -1 ? 'chatgpt' :
    host.indexOf('claude.ai') !== -1 ? 'claude' :
    host.indexOf('gemini.google.com') !== -1 ? 'gemini' :
    host.indexOf('docs.google.com') !== -1
      ? (location.pathname.indexOf('/presentation/') !== -1 ? 'gslides' : 'gdoc')
      : 'other';

  var SITE_LABEL = {
    chatgpt: 'ChatGPT chat', claude: 'Claude chat', gemini: 'Gemini chat', gdoc: 'Google Doc', gslides: 'Google Slides', other: 'page',
  }[SITE];

  // ── Shadow root + styles ─────────────────────────────────────────────────
  var hostEl = document.createElement('div');
  hostEl.id = 'contextbridge-fab-host';
  hostEl.style.cssText = 'all: initial; position: fixed; z-index: 2147483647;';
  (document.body || document.documentElement).appendChild(hostEl);
  var root = hostEl.attachShadow({ mode: 'open' });

  var BRIDGE_WHITE =
    '<svg width="26" height="26" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">' +
      '<defs>' +
        '<linearGradient id="fbArcTop" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="#a855f7"/><stop offset="100%" stop-color="#38bdf8"/></linearGradient>' +
        '<linearGradient id="fbArcBottom" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="#ec4899"/><stop offset="100%" stop-color="#2563eb"/></linearGradient>' +
        '<linearGradient id="fbXGrad" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#d946ef"/><stop offset="50%" stop-color="#a855f7"/><stop offset="100%" stop-color="#38bdf8"/></linearGradient>' +
      '</defs>' +
      '<g fill="none" stroke-linecap="round">' +
        '<path d="M 40 22 A 42 42 0 0 1 88 22" stroke="url(#fbArcTop)" stroke-width="11"/>' +
        '<path d="M 40 106 A 42 42 0 0 1 25 78" stroke="url(#fbArcBottom)" stroke-width="11"/>' +
        '<path d="M 88 106 A 42 42 0 0 0 103 78" stroke="url(#fbArcBottom)" stroke-width="11"/>' +
      '</g>' +
      '<g stroke="url(#fbXGrad)" stroke-width="15" stroke-linecap="round">' +
        '<line x1="46" y1="46" x2="82" y2="82"/><line x1="82" y1="46" x2="46" y2="82"/>' +
      '</g>' +
    '</svg>';

  function bridgeConnectingSvg() {
    return '' +
      '<svg width="200" height="80" viewBox="0 0 240 96" fill="none">' +
        '<defs><linearGradient id="cbg" x1="20" y1="0" x2="220" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#8B5CF6"/><stop offset="0.5" stop-color="#6366F1"/><stop offset="1" stop-color="#06B6D4"/></linearGradient></defs>' +
        '<path d="M28 66 A 84 46 0 0 1 212 66" stroke="url(#cbg)" stroke-width="5" stroke-linecap="round" opacity="0.85"/>' +
        '<g stroke="url(#cbg)" stroke-width="2.5" stroke-linecap="round" opacity="0.55"><line x1="64" y1="38" x2="64" y2="68"/><line x1="120" y1="30" x2="120" y2="68"/><line x1="176" y1="38" x2="176" y2="68"/></g>' +
        '<rect x="24" y="66" width="192" height="6" rx="3" fill="url(#cbg)" opacity="0.9"/>' +
        '<line class="cb-flow" x1="30" y1="69" x2="210" y2="69" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="2 12" opacity="0.9"/>' +
        '<circle cx="24" cy="48" r="8" fill="#8B5CF6"/><circle cx="216" cy="48" r="8" fill="#06B6D4"/>' +
        '<circle r="4.5" fill="#fff"><animateMotion dur="1.5s" repeatCount="indefinite" path="M24 48 C 24 60, 60 69, 120 69 S 216 60, 216 48"/><animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.15;0.85;1" dur="1.5s" repeatCount="indefinite"/></circle>' +
      '</svg>';
  }

  var styles =
    ':host { all: initial; }' +
    '* { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }' +
    '.fab { position: fixed; bottom: 22px; right: 22px; width: 52px; height: 52px; border-radius: 50%;' +
      'background: linear-gradient(135deg, #6D28D9 0%, #4F46E5 50%, #0891B2 100%); border: none; cursor: pointer;' +
      'display: flex; align-items: center; justify-content: center; box-shadow: 0 6px 20px rgba(79,70,229,0.45);' +
      'transition: transform 0.18s ease, box-shadow 0.18s ease; }' +
    '.fab:hover { transform: translateY(-2px) scale(1.05); box-shadow: 0 10px 28px rgba(79,70,229,0.55); }' +
    '.fab::after { content: ""; position: absolute; inset: -4px; border-radius: 50%; border: 2px solid rgba(124,123,252,0.5); animation: cbPing 2.4s ease-out infinite; }' +
    '@keyframes cbPing { 0% { transform: scale(0.9); opacity: 0.7; } 100% { transform: scale(1.45); opacity: 0; } }' +
    '.panel { position: fixed; bottom: 22px; right: 22px; width: 320px; max-height: 78vh; overflow-y: auto;' +
      'background: #14141f; border: 1px solid #2c2c4e; border-radius: 16px; box-shadow: 0 16px 48px rgba(0,0,0,0.45);' +
      'transform: translateX(140%); opacity: 0; transition: transform 0.28s cubic-bezier(0.22,1,0.36,1), opacity 0.2s; }' +
    '.panel.open { transform: translateX(0); opacity: 1; }' +
    '.phead { display: flex; align-items: center; gap: 10px; padding: 14px 16px;' +
      'background: linear-gradient(135deg, #6D28D9 0%, #4F46E5 50%, #0891B2 100%); border-radius: 16px 16px 0 0; }' +
    '.phead .ttl { flex: 1; font-size: 15px; font-weight: 600; color: #fff; letter-spacing: -0.3px; }' +
    '.pclose { background: rgba(255,255,255,0.18); border: none; color: #fff; width: 26px; height: 26px; border-radius: 7px;' +
      'cursor: pointer; font-size: 15px; line-height: 1; display: flex; align-items: center; justify-content: center; }' +
    '.pclose:hover { background: rgba(255,255,255,0.32); }' +
    '.pbody { padding: 16px; display: flex; flex-direction: column; gap: 12px; }' +
    '.connect-wrap { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 14px 8px;' +
      'background: linear-gradient(135deg, #1a1a2e 0%, #1e1e3a 100%); border: 1px solid #2c2c4e; border-radius: 12px; }' +
    '.connect-msg { font-size: 12.5px; font-weight: 600; color: #a5a4fc; text-align: center; }' +
    '.cb-flow { animation: cbFlow 1.5s linear infinite; }' +
    '@keyframes cbFlow { to { stroke-dashoffset: -14; } }' +
    '.tagline { font-size: 12.5px; color: #b6bac6; line-height: 1.5; text-align: center; }' +
    '.cta { width: 100%; padding: 11px; border: none; border-radius: 10px; cursor: pointer; font-size: 13px; font-weight: 600;' +
      'color: #fff; background: linear-gradient(135deg, #4F46E5 0%, #6D5CE8 100%); box-shadow: 0 2px 8px rgba(79,70,229,0.3); }' +
    '.cta:hover { transform: translateY(-1px); }' +
    '.cta:disabled { opacity: 0.5; cursor: not-allowed; }' +
    '.note { font-size: 11.5px; color: #8b8fa3; line-height: 1.5; text-align: center; }' +
    '.result { background: linear-gradient(135deg, #1e1b3a 0%, #1e1e3e 100%); border: 1px solid #3730a3; border-radius: 10px; padding: 12px; }' +
    '.result .rt { font-size: 13px; font-weight: 700; color: #fff; margin-bottom: 6px; }' +
    '.result .rs { font-size: 12px; color: #c7d2fe; line-height: 1.5; }' +
    '.pill { display: inline-block; margin: 4px 4px 0 0; padding: 2px 8px; border-radius: 10px; font-size: 10.5px; font-weight: 700;' +
      'background: rgba(124,123,252,0.2); color: #c7d2fe; }' +
    '.err { color: #fca5a5; font-size: 12px; line-height: 1.5; }';

  setHtml(root,
    '<style>' + styles + '</style>' +
    '<button class="fab" title="ConteXetu" aria-label="Open ConteXetu">' + BRIDGE_WHITE + '</button>' +
    '<div class="panel" role="dialog" aria-label="ConteXetu">' +
      '<div class="phead">' + BRIDGE_WHITE.replace('width="26" height="26"', 'width="22" height="22"') +
        '<span class="ttl">ConteXetu</span>' +
        '<button class="pclose" aria-label="Close">&times;</button>' +
      '</div>' +
      '<div class="pbody" id="cb-pbody"></div>' +
    '</div>'
  );

  // Reloading the extension (e.g. picking up an update) tears down the old
  // background/runtime instance. A content script already injected into an
  // already-open tab still holds a reference to that now-dead instance, so
  // calling chrome.runtime.sendMessage from it throws "Extension context
  // invalidated" — not a bug in the message itself, just a stale page that
  // needs a refresh to get the new content script. We detect this up front
  // (chrome.runtime.id disappears when invalidated) and show a clear
  // message instead of letting an uncaught error escape.
  function isContextValid() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  var STALE_CONTEXT_MSG = 'ConteXetu was updated — refresh this page (Cmd/Ctrl+R) to reconnect.';
  // Capture runs a local Ollama PII pass (CPU-bound, scales with
  // conversation length — measured 65s+ for a long real Gemini thread on
  // phi3) plus a cloud structuring call and embeddings. A shorter timeout
  // here cuts the panel off before the backend finishes, which reads as a
  // false failure even though the session saves successfully moments later.
  var TIMEOUT_MSG = 'Still working — long conversations can take a couple of minutes through the local privacy check. Try again shortly; it may already be saved.';

  // Chrome's internal messaging plumbing can fail ASYNCHRONOUSLY when the
  // extension context is invalidated — after chrome.runtime.sendMessage
  // already returned normally — which a synchronous try/catch around the
  // call cannot catch (confirmed: it still surfaced as an uncaught error in
  // testing despite the try/catch below). Two independent safety nets close
  // that gap regardless of how/when Chrome actually throws it:
  //  1. A global error/rejection listener watching for this exact message.
  //  2. A timeout — if no response arrives at all within 3 minutes, treat it
  //     as failed rather than leaving the panel stuck on a spinner forever.
  var pendingCallback = null;

  function isInvalidatedContextError(err) {
    var text = (err && (err.message || err.reason || String(err))) || '';
    return /Extension context invalidated/i.test(text);
  }

  window.addEventListener('error', function (e) {
    if (pendingCallback && isInvalidatedContextError(e.error || e)) {
      var cb = pendingCallback; pendingCallback = null;
      e.preventDefault();
      cb(null, STALE_CONTEXT_MSG);
    }
  });
  window.addEventListener('unhandledrejection', function (e) {
    if (pendingCallback && isInvalidatedContextError(e.reason)) {
      var cb = pendingCallback; pendingCallback = null;
      e.preventDefault();
      cb(null, STALE_CONTEXT_MSG);
    }
  });

  function safeSendMessage(msg, cb) {
    if (!isContextValid()) {
      cb(null, STALE_CONTEXT_MSG);
      return;
    }

    var done = false;
    var settle = function (resp, err) {
      if (done) return;
      done = true;
      pendingCallback = null;
      cb(resp, err);
    };

    pendingCallback = settle;
    setTimeout(function () {
      if (!done) settle(null, TIMEOUT_MSG);
    }, 180000);

    try {
      chrome.runtime.sendMessage(msg, function (resp) {
        if (chrome.runtime.lastError) {
          settle(null, chrome.runtime.lastError.message);
        } else {
          settle(resp, null);
        }
      });
    } catch (err) {
      settle(null, STALE_CONTEXT_MSG);
    }
  }

  var fab = root.querySelector('.fab');
  var panel = root.querySelector('.panel');
  var pbody = root.querySelector('#cb-pbody');
  var lastSessionId = null;
  root.querySelector('.pclose').addEventListener('click', function () { panel.classList.remove('open'); });

  // Clicking the bridge itself performs the action directly — no second
  // "Capture" button click — wherever automatic capture is actually possible
  // (ChatGPT/Gemini scraping, Google Docs/Slides export). Claude has no DOM
  // scraper (see content/claude.js) so there's nothing to auto-capture there;
  // the panel explains that honestly instead of pretending it can.
  fab.addEventListener('click', function () {
    panel.classList.add('open');
    if (!isContextValid()) {
      setHtml(pbody,
        '<div class="connect-wrap" style="background:#2a1818;border-color:#5b2020"><div class="err">ConteXetu was updated — refresh this page to reconnect.</div></div>'
      );
      return;
    }
    if (SITE === 'chatgpt' || SITE === 'gemini') {
      runChatGptCapture();
    } else if (SITE === 'gdoc' || SITE === 'gslides') {
      runGoogleCapture();
    } else {
      renderIdle();
    }
  });

  function renderIdle() {
    setHtml(pbody,
      '<div class="connect-wrap">' + bridgeConnectingSvg() + '<div class="connect-msg">Bridge ready</div></div>' +
      '<div class="tagline">Capturing ' + SITE_LABEL + ' runs through the toolbar popup.</div>' +
      '<div class="note">Click the ConteXetu icon in your browser toolbar to paste this conversation.</div>'
    );
  }

  function runChatGptCapture() {
    setHtml(pbody,
      '<div class="connect-wrap">' + bridgeConnectingSvg() + '<div class="connect-msg">Redacting on-device, then structuring…</div>' +
      '<div class="note">Longer conversations can take a minute or two — the privacy check runs locally.</div></div>'
    );

    safeSendMessage({ type: 'CB_CAPTURE_ACTIVE_TAB' }, function (resp, transportErr) {
      if (transportErr) {
        renderError(transportErr, runChatGptCapture);
        return;
      }
      if (!resp || resp.error) {
        renderError((resp && resp.error) || 'Capture failed', runChatGptCapture);
        return;
      }
      renderResult(resp);
    });
  }

  // Google Docs/Slides: tries the Docs/Slides REST API first (genuinely
  // automatic — Google's API returns proper CORS headers for OAuth
  // bearer-token requests, unlike the export endpoint's cross-origin
  // redirect). This only works once manifest.json's oauth2.client_id is
  // configured with a real Google Cloud Console client; until then
  // getAuthToken fails and we transparently fall back to the
  // export+download flow, which always works regardless of OAuth setup.
  function runGoogleCapture() {
    setHtml(pbody,
      '<div class="connect-wrap">' + bridgeConnectingSvg() + '<div class="connect-msg">Connecting to Google…</div></div>'
    );

    var docMatch = location.href.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
    var slidesMatch = location.href.match(/\/presentation\/d\/([a-zA-Z0-9_-]+)/);
    var isSlides = SITE === 'gslides';
    var id = isSlides ? (slidesMatch && slidesMatch[1]) : (docMatch && docMatch[1]);
    if (!id) {
      renderError('Could not find a document ID on this page.', runGoogleCapture);
      return;
    }

    safeSendMessage({ type: 'CB_CAPTURE_GOOGLE_API', kind: SITE, id: id }, function (resp, transportErr) {
      if (!transportErr && resp && !resp.error) {
        // Fully automatic — same result shape as ChatGPT capture, so it
        // gets the reward animation + transfer button for free, and no
        // download or manual step happened at all.
        renderResult(resp);
        return;
      }
      runGoogleExportFallback(id, isSlides);
    });
  }

  // export+download via chrome.downloads (immune to CORS/CSP, unlike fetch
  // — Google's export endpoint redirects cross-origin to a
  // googleusercontent.com URL with a wildcard CORS header that the Fetch
  // spec forbids combining with credentials). Finishing requires dropping
  // the downloaded file into the popup's upload box — Chrome doesn't let
  // any extension-page script read file:// content back automatically.
  function runGoogleExportFallback(id, isSlides) {
    setHtml(pbody,
      '<div class="connect-wrap">' + bridgeConnectingSvg() + '<div class="connect-msg">Exporting ' + escapeHtml(SITE_LABEL) + '…</div></div>'
    );

    var title = document.title.replace(/\s*-\s*Google (Docs|Slides)\s*$/i, '').trim() || 'document';
    var baseTitle = title.replace(/\.(docx|pptx|doc|ppt)$/i, '');
    var ext = isSlides ? '.pptx' : '.docx';
    var filename = baseTitle + ext;
    var exportUrl = isSlides
      ? 'https://docs.google.com/presentation/d/' + id + '/export/pptx'
      : 'https://docs.google.com/document/d/' + id + '/export?format=docx';

    safeSendMessage({ type: 'CB_CAPTURE_GOOGLE_EXPORT', exportUrl: exportUrl, filename: filename }, function (resp, transportErr) {
      if (transportErr) {
        renderError(transportErr, runGoogleCapture);
        return;
      }
      if (!resp) {
        renderError('No response from extension background.', runGoogleCapture);
        return;
      }
      if (resp.error) {
        renderError(resp.error, runGoogleCapture);
        return;
      }
      setHtml(pbody,
        '<div class="connect-wrap" style="background:#0f2318;border-color:#134e3a"><div class="connect-msg" style="color:#34d399">✓ Downloaded "' + escapeHtml(resp.filename) + '"</div></div>' +
        '<div class="tagline">Open the ConteXetu toolbar popup and drop that file into the upload box to finish capturing it.</div>'
      );
    });
  }

  function renderResult(data) {
    lastSessionId = data.session_id || null;
    var flags = data.pii_flags || {};
    var pills = Object.keys(flags).map(function (k) {
      return '<span class="pill">' + flags[k] + ' ' + k + (flags[k] > 1 ? 's' : '') + ' redacted</span>';
    }).join('');
    var shield = pills
      ? '<div style="margin-top:8px">🛡️ ' + pills + '</div>'
      : '<div style="margin-top:8px" class="pill">🛡️ Scanned on-device · no PII</div>';
    setHtml(pbody,
      '<div class="result">' +
        '<div class="rt">✓ Captured: ' + escapeHtml(data.title || 'Session') + '</div>' +
        '<div class="rs">' + ((data.goals || []).length) + ' goals · ' + ((data.decisions || []).length) + ' decisions · ' + ((data.tech_stack || []).length) + ' tech' + shield + '</div>' +
      '</div>' +
      (lastSessionId
        ? '<button class="cta" id="cb-transfer">🌉 Complete the bridge — copy for transfer</button>' +
          '<div class="note">Copies the structured context to your clipboard, ready to paste into another AI.</div>'
        : '')
    );

    var t = root.querySelector('#cb-transfer');
    if (t) t.addEventListener('click', runTransfer);

    playRewardAnimation('capture');
  }

  function runTransfer() {
    var t = root.querySelector('#cb-transfer');
    if (t) { t.disabled = true; t.textContent = 'Preparing…'; }

    safeSendMessage({ type: 'CB_INJECT_FORMATTED', sessionId: lastSessionId, targetModel: 'markdown' }, function (resp, transportErr) {
      if (transportErr || !resp || resp.error) {
        if (t) { t.disabled = false; t.textContent = '🌉 Complete the bridge — copy for transfer'; }
        renderTransferNote('Transfer failed: ' + (transportErr || (resp && resp.error) || 'unknown error'), true);
        return;
      }
      navigator.clipboard.writeText(resp.formatted_prompt || '').then(function () {
        renderTransferNote('Copied! Paste it into your target AI to complete the bridge.', false);
        playRewardAnimation('transfer');
      }, function (err) {
        renderTransferNote('Clipboard write failed: ' + err.message, true);
      });
    });
  }

  function renderTransferNote(text, isError) {
    var existing = root.querySelector('#cb-transfer-note');
    if (existing) existing.parentNode.removeChild(existing);
    var note = document.createElement('div');
    note.id = 'cb-transfer-note';
    note.className = isError ? 'err' : 'note';
    note.style.marginTop = '4px';
    note.textContent = text;
    pbody.appendChild(note);
  }

  function renderError(msg, retryFn) {
    setHtml(pbody,
      '<div class="connect-wrap" style="background:#2a1818;border-color:#5b2020"><div class="err">' + escapeHtml(msg) + '</div></div>' +
      '<button class="cta" id="cb-retry">Try again</button>'
    );
    var r = root.querySelector('#cb-retry');
    if (r) r.addEventListener('click', retryFn || renderIdle);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── Full-screen reward animation ────────────────────────────────────────
  // 'capture': a pulse travels from off-screen into the near side of a large
  // bridge — "your data just crossed onto the bridge".
  // 'transfer': the pulse travels the FULL arc, side to side — "the cycle
  // completed, context delivered". This is a SEPARATE shadow host (its own
  // fixed inset:0 layer covering the entire viewport) so it can render over
  // the whole page, not just within the small panel.
  function playRewardAnimation(kind) {
    var overlayHost = document.createElement('div');
    overlayHost.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;';
    (document.body || document.documentElement).appendChild(overlayHost);
    var oroot = overlayHost.attachShadow({ mode: 'open' });

    var isTransfer = kind === 'transfer';
    var motionPath = isTransfer
      ? 'M60 340 C 60 200, 260 120, 480 120 S 900 200, 900 340'
      : 'M-40 340 C 120 280, 300 150, 480 120 S 900 200, 900 340';
    var label = isTransfer ? 'Bridge cycle complete' : 'Captured — crossing the bridge';

    var css =
      ':host{all:initial}' +
      '*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}' +
      '.backdrop{position:fixed;inset:0;background:rgba(10,10,20,0);display:flex;align-items:center;justify-content:center;animation:cbFadeBg 1.8s ease forwards}' +
      '@keyframes cbFadeBg{0%{background:rgba(10,10,20,0)}15%{background:rgba(10,10,20,0.35)}75%{background:rgba(10,10,20,0.35)}100%{background:rgba(10,10,20,0)}}' +
      '.scene{width:100%;max-width:960px;padding:0 24px;opacity:0;transform:scale(0.92);animation:cbSceneIn 1.8s ease forwards}' +
      '@keyframes cbSceneIn{0%{opacity:0;transform:scale(0.92)}12%{opacity:1;transform:scale(1)}78%{opacity:1;transform:scale(1)}100%{opacity:0;transform:scale(1.02)}}' +
      '.label{text-align:center;margin-top:14px;font-size:18px;font-weight:700;color:#fff;letter-spacing:-0.2px;text-shadow:0 2px 12px rgba(0,0,0,0.5)}' +
      '.flowbig{animation:cbFlowBig 1.8s linear forwards}' +
      '@keyframes cbFlowBig{to{stroke-dashoffset:-32}}';

    setHtml(oroot,
      '<style>' + css + '</style>' +
      '<div class="backdrop"><div class="scene">' +
        '<svg viewBox="0 0 960 380" width="100%" fill="none">' +
          '<defs><linearGradient id="rg" x1="60" y1="0" x2="900" y2="0" gradientUnits="userSpaceOnUse">' +
            '<stop offset="0" stop-color="#8B5CF6"/><stop offset="0.5" stop-color="#6366F1"/><stop offset="1" stop-color="#06B6D4"/>' +
          '</linearGradient></defs>' +
          '<path d="M60 340 A 420 220 0 0 1 900 340" stroke="url(#rg)" stroke-width="10" stroke-linecap="round" opacity="0.9"/>' +
          '<g stroke="url(#rg)" stroke-width="5" stroke-linecap="round" opacity="0.55">' +
            '<line x1="260" y1="160" x2="260" y2="335"/><line x1="480" y1="120" x2="480" y2="335"/><line x1="700" y1="160" x2="700" y2="335"/>' +
          '</g>' +
          '<rect x="50" y="338" width="860" height="14" rx="7" fill="url(#rg)" opacity="0.95"/>' +
          '<line class="flowbig" x1="65" y1="345" x2="895" y2="345" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-dasharray="4 24" opacity="0.9"/>' +
          '<circle cx="60" cy="296" r="16" fill="#8B5CF6"/><circle cx="900" cy="296" r="16" fill="#06B6D4"/>' +
          '<circle r="11" fill="#fff" style="filter:drop-shadow(0 0 10px rgba(124,123,252,0.95))">' +
            '<animateMotion dur="1.8s" fill="freeze" path="' + motionPath + '"/>' +
          '</circle>' +
        '</svg>' +
        '<div class="label">' + escapeHtml(label) + '</div>' +
      '</div></div>'
    );

    setTimeout(function () {
      if (overlayHost.parentNode) overlayHost.parentNode.removeChild(overlayHost);
    }, 1900);
  }

  } // end mount()
})();
