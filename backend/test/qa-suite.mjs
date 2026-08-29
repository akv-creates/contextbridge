// ContextBridge QA suite — exercises the real backend + extension logic.
// Run: node test/qa-suite.mjs   (from backend/, with the backend running)
import fs from 'fs';
import vm from 'vm';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = 'http://localhost:3001';
const EXT_DIR = path.resolve(__dirname, '../../extension');
const ENGINE_DIR = path.resolve(__dirname, '../engine');
const ROUTES_DIR = path.resolve(__dirname, '../routes');
const results = [];

function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log((pass ? '✓ PASS' : '✗ FAIL') + ' — ' + name + (detail ? '\n      ' + detail : ''));
}

async function jpost(path, body) {
  const res = await fetch(BACKEND + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
async function jget(path) {
  const res = await fetch(BACKEND + path);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const userId = 'qa-suite-' + Date.now();

// ── 1. Health ────────────────────────────────────────────────────────────
async function testHealth() {
  const { status, data } = await jget('/health');
  record('Backend /health responds 200 with db connected', status === 200 && data.db === 'connected', JSON.stringify(data));
}

// ── 2. Chat capture — clean text ────────────────────────────────────────
async function testCaptureClean() {
  const { status, data } = await jpost('/context/capture', {
    source_model: 'chatgpt', user_id: userId,
    messages: [
      { role: 'user', content: 'We decided to use Redis for caching because it has the lowest latency option available.' },
      { role: 'assistant', content: 'Good choice — Redis is well suited for that.' },
    ],
  });
  const ok = status === 201 && !!data.session_id && Array.isArray(data.decisions) && data.decisions.length > 0;
  record('Capture clean chat text → 201 with session_id + decisions extracted', ok, JSON.stringify({ status, decisions: data.decisions, pii_flags: data.pii_flags }));
  return data.session_id;
}

// ── 3. Chat capture — PII redaction ─────────────────────────────────────
async function testCapturePII() {
  const { status, data } = await jpost('/context/capture', {
    source_model: 'chatgpt', user_id: userId,
    messages: [
      { role: 'user', content: 'Contact sarah.qa@example.com or call 415-555-0199. We use PostgreSQL for storage.' },
      { role: 'assistant', content: 'Noted, PostgreSQL it is.' },
    ],
  });
  const flagsOk = data.pii_flags && (data.pii_flags.email >= 1) && (data.pii_flags.phone >= 1);
  const mapOk = data.redaction_map && Object.values(data.redaction_map).some((v) => v.includes('sarah.qa@example.com'));
  record('Capture with PII → redacted, pii_flags + redaction_map correct', status === 201 && flagsOk && mapOk,
    JSON.stringify({ pii_flags: data.pii_flags, redaction_map: data.redaction_map }));
  return data.session_id;
}

// ── 4. Trivial capture skips cloud structuring ──────────────────────────
async function testTrivial() {
  const { status, data } = await jpost('/context/capture', {
    source_model: 'chatgpt', user_id: userId,
    messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }],
  });
  record('Trivial capture → handled_locally true (Groq skipped)', status === 201 && data.handled_locally === true, JSON.stringify({ handled_locally: data.handled_locally }));
}

// ── 4b. REGRESSION: small local model lazily marking real content trivial
// must not silently destroy it. Found via QA: phi3 flagged a genuine
// architecture decision as trivial with an empty summary, dropping it
// entirely. local-gate.js must force full Groq structuring whenever the
// input is substantive (not just a few words) even if the model claims
// trivial — see the trivialSummaryIsUsable guard in localGate().
async function testTrivialDoesNotEatRealContent() {
  const { status, data } = await jpost('/context/capture', {
    source_model: 'chatgpt', user_id: userId,
    messages: [
      { role: 'user', content: 'We decided to use Redis for caching because it has the lowest latency option available.' },
      { role: 'assistant', content: 'Good choice — Redis is well suited for that.' },
    ],
  });
  const ok = status === 201 && data.handled_locally === false && Array.isArray(data.decisions) && data.decisions.length > 0 && data.summary.trim().length > 0;
  record('REGRESSION: substantive decision is never silently dropped as "trivial"', ok,
    JSON.stringify({ handled_locally: data.handled_locally, decisions: data.decisions, summary: data.summary }));
}

// ── 5. Validation errors ────────────────────────────────────────────────
async function testValidation() {
  const r1 = await jpost('/context/capture', { user_id: userId, messages: [] });
  const r2 = await jpost('/context/capture', { source_model: 'chatgpt', messages: [{ role: 'user', content: 'x' }] });
  record('Missing source_model → 400', r1.status === 400, JSON.stringify(r1.data));
  record('Missing user_id → 400', r2.status === 400, JSON.stringify(r2.data));
}

// ── 6. Inject ────────────────────────────────────────────────────────────
async function testInject(sessionId) {
  const { status, data } = await jpost('/context/inject', { session_id: sessionId, user_id: userId, target_model: 'claude' });
  const ok = status === 200 && typeof data.formatted_prompt === 'string' && data.formatted_prompt.includes('context_bridge');
  record('Inject session → Claude-formatted prompt returned', ok, 'adapter_used=' + data.adapter_used);
}

// ── 7. Sessions list ─────────────────────────────────────────────────────
async function testSessions() {
  const { status, data } = await jget('/context/sessions?user_id=' + userId);
  const ok = status === 200 && Array.isArray(data.sessions) && data.sessions.length >= 2;
  record('Sessions list returns captured sessions for user', ok, 'count=' + (data.sessions && data.sessions.length));
}

// Builds a minimal valid .docx in memory via JSZip (already a backend
// dependency) — self-contained, no fixture files to keep in sync.
async function buildTestDocx() {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  zip.file('[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>');
  zip.file('_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>');
  zip.file('word/document.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    '<w:p><w:r><w:t>QA Suite Test Doc</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>We decided to use gRPC for service communication because of its low latency.</w:t></w:r></w:p>' +
    '</w:body></w:document>');
  return zip.generateAsync({ type: 'nodebuffer' });
}

// ── 8. Document upload (.docx) ──────────────────────────────────────────
async function testDocxUpload() {
  const buf = await buildTestDocx();
  const form = new FormData();
  form.append('user_id', userId);
  form.append('file', new Blob([buf]), 'qa-test.docx');
  const res = await fetch(BACKEND + '/context/capture-file', { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  const ok = res.status === 201 && !!data.session_id && data.source_filename === 'qa-test.docx';
  record('Upload .docx → captured with structured context', ok, JSON.stringify({ status: res.status, decisions: data.decisions }));
}

// ── 9. Bad file type rejected ────────────────────────────────────────────
async function testBadFileType() {
  const form = new FormData();
  form.append('user_id', userId);
  form.append('file', new Blob(['plain text']), 'notes.txt');
  const res = await fetch(BACKEND + '/context/capture-file', { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  record('Upload .txt → rejected with 400', res.status === 400 && /Unsupported file type/.test(data.error || ''), JSON.stringify(data));
}

// ── 10. Extension: extractDocsApiText / extractSlidesApiText ────────────
async function testGoogleApiParsers() {
  const code = fs.readFileSync(EXT_DIR + '/background.js', 'utf8');
  const sb = { console: { log() {}, error() {} }, chrome: { runtime: { onMessage: { addListener() {} } }, storage: { local: { get() {} } }, downloads: {}, notifications: { create() {} }, commands: { onCommand: { addListener() {} } }, tabs: { query: async () => [] }, scripting: {}, identity: {} } };
  vm.createContext(sb); vm.runInContext(code, sb);

  const doc = { body: { content: [
    { paragraph: { elements: [{ textRun: { content: 'Decision: use gRPC.\n' } }] } },
    { table: { tableRows: [{ tableCells: [{ content: [{ paragraph: { elements: [{ textRun: { content: 'Cell text\n' } }] } }] }] }] } },
  ] } };
  const docText = sb.extractDocsApiText(doc);
  record('extractDocsApiText parses paragraphs + table cells', docText === 'Decision: use gRPC.\nCell text', JSON.stringify(docText));

  const pres = { slides: [
    { pageElements: [{ shape: { text: { textElements: [{ textRun: { content: 'Slide one text' } }] } } }] },
    { pageElements: [] }, // empty slide should be skipped, not crash
  ] };
  const slidesText = sb.extractSlidesApiText(pres);
  record('extractSlidesApiText parses slides, skips empty ones', slidesText === '--- Slide 1 ---\nSlide one text', JSON.stringify(slidesText));
}

// ── 11. Extension: local-gate regex PII patterns (backend-side, real module) ─
async function testRegexPII() {
  const code = fs.readFileSync(path.join(ENGINE_DIR, 'local-gate.js'), 'utf8');
  // Extract just the regex patterns via static import isn't trivial from CJS vm here;
  // instead verify behavior through the real capture endpoint (already covered by
  // testCapturePII above) — this test asserts the patterns array exists in source.
  const ok = /REGEX_PII_PATTERNS/.test(code) && /email/.test(code) && /phone/.test(code);
  record('local-gate.js defines regex PII pattern table', ok, '');
}

// ── 12. Manifest sanity ──────────────────────────────────────────────────
async function testManifest() {
  const m = JSON.parse(fs.readFileSync(EXT_DIR + '/manifest.json', 'utf8'));
  const checks = [
    ['identity permission present', m.permissions.includes('identity')],
    ['downloads permission present', m.permissions.includes('downloads')],
    ['oauth2 client_id is not placeholder', m.oauth2 && !m.oauth2.client_id.startsWith('REPLACE_WITH')],
    ['oauth2 scopes include documents.readonly', m.oauth2 && m.oauth2.scopes.some((s) => s.includes('documents.readonly'))],
    ['oauth2 scopes include presentations.readonly', m.oauth2 && m.oauth2.scopes.some((s) => s.includes('presentations.readonly'))],
    ['host_permissions include docs.googleapis.com', m.host_permissions.includes('https://docs.googleapis.com/*')],
    ['host_permissions include slides.googleapis.com', m.host_permissions.includes('https://slides.googleapis.com/*')],
  ];
  for (const [name, ok] of checks) record('manifest.json: ' + name, ok, '');
}

// ── 13. Syntax check all extension/backend JS ───────────────────────────
async function testSyntax() {
  const { execSync } = await import('child_process');
  const files = [
    EXT_DIR + '/background.js',
    EXT_DIR + '/content/floating-bridge.js',
    EXT_DIR + '/popup/popup.js',
    path.join(ENGINE_DIR, 'local-gate.js'),
    path.join(ENGINE_DIR, 'capture-flow.js'),
    path.join(ENGINE_DIR, 'document-extractor.js'),
    path.join(ROUTES_DIR, 'document.js'),
    path.join(ROUTES_DIR, 'context.js'),
  ];
  for (const f of files) {
    try {
      execSync(`node --check "${f}"`, { stdio: 'pipe' });
      record('Syntax valid: ' + f.split('/').pop(), true, '');
    } catch (e) {
      record('Syntax valid: ' + f.split('/').pop(), false, e.stderr ? e.stderr.toString() : e.message);
    }
  }
}

(async () => {
  await testHealth();
  const cleanSession = await testCaptureClean();
  await testCapturePII();
  await testTrivial();
  await testTrivialDoesNotEatRealContent();
  await testValidation();
  if (cleanSession) await testInject(cleanSession);
  await testSessions();
  await testDocxUpload();
  await testBadFileType();
  await testGoogleApiParsers();
  await testRegexPII();
  await testManifest();
  await testSyntax();

  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass);
  console.log('\n=== SUMMARY: ' + passed + '/' + results.length + ' passed ===');
  if (failed.length) {
    console.log('FAILED:');
    failed.forEach((f) => console.log('  - ' + f.name));
    process.exit(1);
  }
})();
