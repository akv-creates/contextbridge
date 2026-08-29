// Anonymous, opt-out product telemetry — fire-and-forget, never blocks a
// user-facing flow, never sends message content. Shared by popup.js and
// background.js (loaded as a plain script in both contexts).
//
// Storage keys used:
//   cb_telemetry_enabled  — boolean, default true, toggle lives in settings
//   cb_first_open_at      — ISO timestamp of first popup open, for W2 calc
//   cb_w1_fired / cb_w2_fired — one-shot guards so retention events fire once

(function (root) {
  function getStorage(keys) {
    return new Promise((r) => chrome.storage.local.get(keys, r));
  }
  function setStorage(obj) {
    return new Promise((r) => chrome.storage.local.set(obj, r));
  }

  async function isTelemetryEnabled() {
    const s = await getStorage(['cb_telemetry_enabled']);
    return s.cb_telemetry_enabled !== false; // default ON, matches settings toggle default
  }

  async function getBackendUrl() {
    const s = await getStorage(['BACKEND_URL']);
    return s.BACKEND_URL || 'http://localhost:3001';
  }

  async function getUserId() {
    const s = await getStorage(['userId']);
    if (s.userId) return s.userId;
    const id = crypto.randomUUID();
    await setStorage({ userId: id });
    return id;
  }

  // Fire-and-forget: swallow all errors, never throws, never awaited by callers.
  async function trackEvent(eventType, metadata) {
    try {
      if (!(await isTelemetryEnabled())) return;
      const backendUrl = await getBackendUrl();
      const userId = await getUserId();
      fetch(backendUrl + '/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, event_type: eventType, metadata: metadata || {} }),
      }).catch(() => {}); // network failure is fine, telemetry is best-effort
    } catch (e) { /* never let telemetry break the real flow */ }
  }

  // Call on every popup open. Fires 'popup_open' always, plus one-shot
  // 'w1_active' (any open within days 1-6) and 'w2_retained' (any open on
  // day 7+) signals used for the activation/retention experiment.
  async function trackPopupOpen() {
    trackEvent('popup_open');
    try {
      const s = await getStorage(['cb_first_open_at', 'cb_w1_fired', 'cb_w2_fired']);
      const now = Date.now();
      if (!s.cb_first_open_at) {
        await setStorage({ cb_first_open_at: new Date(now).toISOString() });
        return; // first-ever open — nothing to compare against yet
      }
      const daysSince = (now - new Date(s.cb_first_open_at).getTime()) / 86400000;
      if (!s.cb_w1_fired && daysSince >= 1 && daysSince < 7) {
        trackEvent('w1_active');
        await setStorage({ cb_w1_fired: true });
      }
      if (!s.cb_w2_fired && daysSince >= 7) {
        trackEvent('w2_retained');
        await setStorage({ cb_w2_fired: true });
      }
    } catch (e) { /* best-effort */ }
  }

  root.CBTelemetry = { trackEvent, trackPopupOpen, isTelemetryEnabled, setStorage };
})(typeof window !== 'undefined' ? window : self);
