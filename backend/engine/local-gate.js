// Local privacy/cost gate — runs before structureContext() (Groq). Redacts
// PII and short-circuits trivially simple captures before anything reaches
// the cloud. Two modes (PII_GATE_MODE):
//   'script' (default) — deterministic regex/heuristic redaction only.
//     Near-instant, no local model dependency.
//   'llm' — additionally runs a local Ollama model for PII categories regex
//     can't reliably catch (names without a self-intro, addresses in
//     unusual formats, health/financial context) at the cost of latency
//     (measured 15-20s on a base M1 with phi3).

// Read lazily (not as module-level consts) — ESM hoists `import` statements
// above all other code, so index.js's dotenv.config() hasn't run yet at the
// time this module is first evaluated despite being textually positioned
// after the dotenv import there.
function ollamaBaseUrl() { return process.env.OLLAMA_BASE_URL || 'http://localhost:11434'; }
function ollamaModel() { return process.env.OLLAMA_MODEL || 'llama3.2:3b'; }
function ollamaFallbackMode() { return process.env.OLLAMA_FALLBACK_MODE || 'block'; }
// 'script' (default) — deterministic regex/heuristic redaction only, no local
// model call, near-instant. 'llm' — also runs the Ollama pass below for
// names/addresses/health/financial context an LLM catches that regex can't;
// slower (measured 15-20s on a base M1 with phi3) but higher recall.
function piiGateMode() { return (process.env.PII_GATE_MODE || 'script').toLowerCase(); }

// Deterministic, high-confidence PII patterns. These run unconditionally —
// in 'script' mode they're the *only* redaction pass, in 'llm' mode they run
// before the model ever sees the text as defense in depth.
const REGEX_PII_PATTERNS = [
  { category: 'email', re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
  { category: 'phone', re: /(?<!\d)(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}(?!\d)/g },
  // Common API key / secret token prefixes (OpenAI, AWS, GitHub, Google, Slack, Stripe).
  { category: 'api key', re: /\b(sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|gho_[A-Za-z0-9]{36}|AIza[0-9A-Za-z\-_]{35}|xox[baprs]-[A-Za-z0-9-]{10,}|sk_live_[A-Za-z0-9]{16,}|sk_test_[A-Za-z0-9]{16,})\b/g },
  { category: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  // Street address: house number + 1-3 capitalized words + a street-type suffix.
  { category: 'address', re: /\b\d{1,5}\s+(?:[A-Z][a-zA-Z]*\s){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Terrace|Ter|Circle|Cir)\b\.?/g },
];

// Credit-card-shaped digit runs need a Luhn check before redacting — a plain
// 13-19 digit regex would false-positive on order IDs, phone extensions, etc.
// Handled separately from REGEX_PII_PATTERNS since the match must be
// conditionally accepted, not unconditionally replaced.
const CREDIT_CARD_CANDIDATE = /\b(?:\d[ -]?){13,19}\b/g;
function luhnValid(digitsOnly) {
  let sum = 0;
  let alt = false;
  for (let i = digitsOnly.length - 1; i >= 0; i--) {
    let d = Number(digitsOnly[i]);
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    alt = !alt;
  }
  return digitsOnly.length >= 13 && sum % 10 === 0;
}

// Name heuristic: trigger phrase + 1-3 capitalized words. Weaker precision
// than an LLM (misses names with no self-introduction, over-matches proper
// nouns after "this is" in some phrasing) but zero latency and no network
// dependency. Only the name portion is redacted — the trigger phrase stays.
// Trigger phrase matches regardless of capitalization (users don't always
// capitalize "My name is") via an explicit first-letter alternation — NOT
// a global `i` flag, because that would also relax the name-capture group's
// `[A-Z]` requirement, letting it greedily swallow trailing lowercase words
// ("Sarah Chen and ...") instead of stopping at the name boundary. The name
// group stays strictly capitalized: that's what keeps "this is great" from
// matching "great" as a name.
const NAME_TRIGGER_RE = /\b([Mm]y name is|[Ii]'m|[Ii] am|[Tt]his is|[Cc]all me)\s+([A-Z][a-zA-Z'-]+(?:\s[A-Z][a-zA-Z'-]+){0,2})\b/g;

// Runs the regex + heuristic patterns over every message and replaces
// matches with sequential tokens. Order matters: full-match categories first,
// then the group-based name heuristic (which must not clobber tokens already
// inserted by the categories above), then the Luhn-gated card check.
function scriptRedact(messages) {
  const redaction_map = {};
  const pii_flags = {};
  const counters = {};

  function nextToken(category) {
    counters[category] = (counters[category] || 0) + 1;
    return `[${category.toUpperCase().replace(/\s+/g, '_')}_${counters[category]}]`;
  }

  const sanitized = messages.map((m) => {
    if (typeof m.content !== 'string') return { ...m };
    let content = m.content;

    for (const { category, re } of REGEX_PII_PATTERNS) {
      content = content.replace(re, (match) => {
        const token = nextToken(category);
        redaction_map[token] = match;
        pii_flags[category] = (pii_flags[category] || 0) + 1;
        return token;
      });
    }

    content = content.replace(NAME_TRIGGER_RE, (match, trigger, name) => {
      const token = nextToken('name');
      redaction_map[token] = name;
      pii_flags.name = (pii_flags.name || 0) + 1;
      return `${trigger} ${token}`;
    });

    content = content.replace(CREDIT_CARD_CANDIDATE, (match) => {
      const digitsOnly = match.replace(/[ -]/g, '');
      if (!luhnValid(digitsOnly)) return match; // not card-shaped enough — leave alone
      const token = nextToken('card');
      redaction_map[token] = match;
      pii_flags.card = (pii_flags.card || 0) + 1;
      return token;
    });

    return { ...m, content };
  });

  return { sanitized, redaction_map, pii_flags };
}

// Kept as an alias — regexRedact is the historical name and is still used as
// the pre-LLM defense-in-depth pass in 'llm' mode (email/phone/keys only,
// via REGEX_PII_PATTERNS' first three entries handled inline there).
const regexRedact = scriptRedact;

const GATE_SYSTEM_PROMPT = `You are a local privacy and triage gate for a conversation. The text has already been pre-scanned for emails, phone numbers, and API keys, which appear as tokens like [EMAIL_1] — leave those tokens exactly as-is, do not try to redact them again. Given the conversation, do two things:

1. Identify any REMAINING PII that pre-scanning would miss: full names, home addresses, financial account numbers, or health information. For each occurrence, choose a placeholder token like [NAME_1], [ADDRESS_1], [FINANCIAL_1], [HEALTH_1] (number sequentially per category).
2. Decide if this conversation is trivial enough to summarize yourself, without deeper analysis — trivial means short, no real technical decisions/architecture/constraints worth extracting.

Output ONLY raw JSON, nothing else — no markdown, no prose, no explanation before or after. Keep it short. Match exactly this shape:
{
  "redactions": [ { "token": "[NAME_1]", "original": "actual text found", "category": "name" } ],
  "is_trivial": false,
  "trivial_summary": ""
}
If no PII found, "redactions" must be an empty array. If not trivial, "is_trivial" is false and "trivial_summary" is "".`;

const STRICT_RETRY_PROMPT = `Your previous response was not valid JSON. Output ONLY a single raw JSON object with these exact keys: redactions (array of {token, original, category}), is_trivial (boolean), trivial_summary (string). No markdown, no prose, no text before or after the JSON object.`;

function buildUserMessage(messages) {
  const formatted = messages
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n\n');
  return `Here is the conversation to analyse:\n\n${formatted}`;
}

// Hard timeout per Ollama call. Without this, a hung/overloaded local model
// blocks the whole capture indefinitely — measured one real capture that took
// 277s (4.6 min) before finally failing. Two attempts max (see callOllama
// call sites) at this timeout means worst case is bounded at ~50s instead of
// unbounded.
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || 25000);

async function callOllama(systemPrompt, userContent) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);
  try {
    const res = await fetch(`${ollamaBaseUrl()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: ollamaModel(),
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        stream: false,
        // format: 'json' — Ollama's grammar-constrained decoding forces valid
        // JSON output. Small models (phi3, etc.) routinely ignore "output
        // ONLY JSON" as a plain instruction and add prose/comments/trailing
        // commas, which is what was triggering the retry path on nearly
        // every capture. This eliminates that failure mode at the source
        // instead of trying to parse around it.
        format: 'json',
        // keep_alive: Ollama's default unloads a model from memory after 5m
        // idle, so most captures were paying a ~10s cold-load tax before any
        // actual inference started (measured directly: 9.8s load_duration on
        // a cold call vs 0.1s warm). Keep it resident for an hour so back-to-
        // back captures during a normal work session stay warm.
        keep_alive: '60m',
        options: {
          temperature: 0.1,
          // Expected output is a handful of short redaction entries plus a
          // boolean + short summary — realistically well under 150 tokens.
          // Lowered from 400 to bound worst-case generation time now that
          // format:'json' keeps output on-shape (previously needed slack
          // for rambling small-model output).
          num_predict: 200,
        },
      }),
    });
    if (!res.ok) {
      throw new Error(`Ollama request failed: ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    return data?.message?.content || '';
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Ollama request timed out after ${OLLAMA_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Health check is called on every capture. Cache the result briefly so a
// run of back-to-back captures doesn't pay a network round-trip each time —
// Ollama being up/down doesn't change second-to-second.
let healthCache = { ok: false, checkedAt: 0 };
const HEALTH_CACHE_MS = 15000;

export function getPiiGateMode() { return piiGateMode(); }

export async function checkOllamaHealth() {
  const now = Date.now();
  if (now - healthCache.checkedAt < HEALTH_CACHE_MS) return healthCache.ok;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${ollamaBaseUrl()}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    healthCache = { ok: res.ok, checkedAt: now };
    return res.ok;
  } catch {
    healthCache = { ok: false, checkedAt: now };
    return false;
  }
}

// Extract the first balanced {...} object from text. Smaller/local models
// (phi3, etc.) often append trailing prose after the JSON ("Note: ...") which
// breaks a naive JSON.parse on the whole string.
function extractJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) throw new Error('No JSON object found in response');
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error('Unbalanced JSON object in response');
}

// Smaller local models (phi3, etc.) sometimes ignore "output ONLY JSON" and
// emit JS-style `//` or `/* */` comments inside the object, which breaks
// JSON.parse even after extractJsonObject finds balanced braces. Strip them
// out char-by-char, respecting string literals, so a `//` inside an actual
// string value (e.g. a redacted "https://..." original) is left alone.
function stripJsonComments(text) {
  let out = '';
  let inString = false;
  let stringQuote = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inString) {
      out += ch;
      if (ch === '\\') { out += next; i++; continue; }
      if (ch === stringQuote) inString = false;
      continue;
    }

    if (ch === '"' || ch === "'") { inString = true; stringQuote = ch; out += ch; continue; }

    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++; // skip closing '/'
      continue;
    }

    out += ch;
  }
  return out;
}

// Trailing commas before a closing } or ] are another common small-model
// mistake ("is_trivial": false,\n}) — strip them after comment removal.
function stripTrailingCommas(text) {
  return text.replace(/,(\s*[}\]])/g, '$1');
}

function safeParseGateResponse(raw) {
  const cleaned = raw.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const jsonStr = extractJsonObject(cleaned);
  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    // Fallback pass: strip comments/trailing commas and retry once before
    // giving up — this is what actually recovers phi3-style malformed output.
    parsed = JSON.parse(stripTrailingCommas(stripJsonComments(jsonStr)));
  }
  return {
    redactions: Array.isArray(parsed.redactions) ? parsed.redactions : [],
    is_trivial: Boolean(parsed.is_trivial),
    trivial_summary: typeof parsed.trivial_summary === 'string' ? parsed.trivial_summary : '',
  };
}

// Replace every occurrence of each redaction's original text with its token,
// across all message contents. Returns sanitized messages + a redaction_map
// (token -> original) kept in-process only, never persisted.
function applyRedactions(messages, redactions) {
  const redaction_map = {};
  const pii_flags = {};

  let sanitized = messages.map((m) => ({ ...m }));

  for (const r of redactions) {
    if (!r.token || !r.original) continue;
    redaction_map[r.token] = r.original;
    pii_flags[r.category || 'unknown'] = (pii_flags[r.category || 'unknown'] || 0) + 1;
    sanitized = sanitized.map((m) => ({
      ...m,
      content: typeof m.content === 'string' ? m.content.split(r.original).join(r.token) : m.content,
    }));
  }

  return { sanitized, redaction_map, pii_flags };
}

function emptyTrivialStructured() {
  return {
    title: 'Untitled Session',
    summary: '',
    goals: [], constraints: [], decisions: [], assumptions: [],
    tech_stack: [], architecture: [], open_questions: [], key_entities: [], timeline: [],
  };
}

// Lightweight local structuring for trivial captures — mirrors structurer.js's
// scored-item shape but skips the cloud call entirely.
function buildTrivialStructured(summary) {
  const s = emptyTrivialStructured();
  s.summary = summary || '';
  s.title = (summary || 'Untitled Session').slice(0, 60);
  return s;
}

function mergeRedactions(a, b) {
  return {
    redaction_map: { ...a.redaction_map, ...b.redaction_map },
    pii_flags: Object.keys(b.pii_flags).reduce(
      (acc, k) => ({ ...acc, [k]: (acc[k] || 0) + b.pii_flags[k] }),
      { ...a.pii_flags }
    ),
  };
}

// Same length-based cutoff the 'llm' path already used (see comment below) —
// only input this short is cheap-pathed regardless of gate mode. In 'script'
// mode there's no LLM to generate a paraphrased summary, so the trivial
// summary is just the sanitized content itself, trimmed.
const TRIVIAL_LENGTH_THRESHOLD = 80;

function buildScriptTrivialSummary(sanitizedMessages) {
  const joined = sanitizedMessages.map((m) => m.content || '').join(' ').trim();
  return joined.slice(0, TRIVIAL_LENGTH_THRESHOLD);
}

export async function localGate(messages) {
  // Deterministic pass always runs first — protects common high-confidence
  // PII (email/phone/keys/ssn/address/card/name-heuristic) regardless of
  // gate mode or whether the local LLM is reachable.
  const regexResult = scriptRedact(messages);

  if (piiGateMode() === 'script') {
    const totalInputLength = regexResult.sanitized.reduce((sum, m) => sum + (m.content || '').length, 0);
    const isTrivial = totalInputLength <= TRIVIAL_LENGTH_THRESHOLD;
    return {
      sanitized_messages: regexResult.sanitized,
      redaction_map: regexResult.redaction_map,
      pii_flags: regexResult.pii_flags,
      handled_locally: isTrivial,
      local_structured: isTrivial ? buildTrivialStructured(buildScriptTrivialSummary(regexResult.sanitized)) : null,
    };
  }

  const healthy = await checkOllamaHealth();

  if (!healthy) {
    if (ollamaFallbackMode() === 'warn') {
      console.error('[local-gate] Ollama unreachable — proceeding with regex-only redaction (OLLAMA_FALLBACK_MODE=warn)');
      return {
        sanitized_messages: regexResult.sanitized,
        redaction_map: regexResult.redaction_map,
        pii_flags: regexResult.pii_flags,
        handled_locally: false,
        local_structured: null,
      };
    }
    const err = new Error('Local privacy gate unavailable: Ollama is not reachable. Start Ollama (ollama serve) or set OLLAMA_FALLBACK_MODE=warn to bypass (not recommended).');
    err.status = 503;
    throw err;
  }

  // LLM pass runs on the already regex-sanitized messages — defense in
  // depth, the model never even sees raw emails/phones/keys for the common
  // categories, only whatever regex couldn't catch (names, addresses, etc).
  let gateResult;
  try {
    const raw = await callOllama(GATE_SYSTEM_PROMPT, buildUserMessage(regexResult.sanitized));
    gateResult = safeParseGateResponse(raw);
  } catch (firstErr) {
    console.error('[local-gate] Ollama call/parse failed, retrying once:', firstErr.message);
    try {
      const retryRaw = await callOllama(STRICT_RETRY_PROMPT, buildUserMessage(regexResult.sanitized));
      gateResult = safeParseGateResponse(retryRaw);
    } catch (retryErr) {
      console.error('[local-gate] Retry also failed:', retryErr.message);
      if (ollamaFallbackMode() === 'warn') {
        return {
          sanitized_messages: regexResult.sanitized,
          redaction_map: regexResult.redaction_map,
          pii_flags: regexResult.pii_flags,
          handled_locally: false,
          local_structured: null,
        };
      }
      const blockErr = new Error('Local privacy gate failed to analyse the conversation. Refusing to forward unredacted content to the cloud.');
      blockErr.status = 503;
      throw blockErr;
    }
  }

  const llmResult = applyRedactions(regexResult.sanitized, gateResult.redactions);
  const merged = mergeRedactions(regexResult, llmResult);

  // Small local models cannot be trusted to judge "triviality" for anything
  // beyond genuinely tiny input — confirmed in testing: phi3 flagged a real
  // architecture decision ("we decided to use Redis because...", ~90 chars)
  // as trivial, and even when given a plausible-length summary, the trivial
  // path (buildTrivialStructured) never extracts decisions/tech_stack at
  // all by design — that's the cost-saving shortcut, not a bug, but it
  // means trusting a wrong "trivial" verdict on substantive content
  // silently destroys real structure. So input length is the sole gate, not
  // the model's own judgment or its summary: only input short enough that
  // there's plausibly nothing worth extracting ("hi"/"hello") is cheap-pathed.
  // Anything longer always gets full Groq structuring, regardless of what
  // the model claims about triviality.
  const totalInputLength = regexResult.sanitized.reduce((sum, m) => sum + (m.content || '').length, 0);
  const isTinyEnoughToTrustLocally = totalInputLength <= TRIVIAL_LENGTH_THRESHOLD;

  if (gateResult.is_trivial && isTinyEnoughToTrustLocally) {
    return {
      sanitized_messages: llmResult.sanitized,
      redaction_map: merged.redaction_map,
      pii_flags: merged.pii_flags,
      handled_locally: true,
      local_structured: buildTrivialStructured(gateResult.trivial_summary),
    };
  }

  return {
    sanitized_messages: llmResult.sanitized,
    redaction_map: merged.redaction_map,
    pii_flags: merged.pii_flags,
    handled_locally: false,
    local_structured: null,
  };
}
