# ContextBridge — Project Log

Running log of what's been built, why, and current state. Updated as we build (not a spec — see `CLAUDE.md` for that).

---

## What it is

Chrome extension + Node/Express backend that captures AI conversation context (ChatGPT, Claude, Ollama, Gemini, plus .docx/.pptx upload) and transfers it between models without copy-paste. No accounts — a `userId` UUID is generated client-side and stored in `chrome.storage.local`.

**Stack**: Manifest V3 vanilla-JS extension · Node 20 / Express 4 · Postgres 16 (JSONB) · Groq (llama-3.3-70b) for structuring · local Ollama for a PII-redaction/triviality gate · `@xenova/transformers` MiniLM-L6-v2 for embeddings.

---

## Shipped

### Core capture/inject pipeline
- `/context/capture` — scrape or paste a conversation → local Ollama gate (PII redaction + triviality short-circuit) → Groq structures into 9 categories (summary, goals, constraints, decisions, assumptions, tech_stack, architecture, open_questions, key_entities, timeline) → saved to Postgres.
- `/context/inject` — reassembles + formats for target model via adapter (`claude.js` XML tags, `gpt.js` dash headers, `ollama.js` CAPS headers, `gemini.js` JSON, `markdown.js` universal .md).
- Popup: one-click inject (auto-paste into ChatGPT/Claude tab via `chrome.scripting.executeScript`, clipboard fallback), inject modal with format preview tab, JSON copy/download, .md export (single + bulk `export-all`), session merge.
- Document capture: upload .docx/.pptx to extract context without a live chat.

### Local privacy/cost gate (`engine/local-gate.js`)
Every capture goes through a local Ollama model before Groq ever sees it:
- Redacts PII (emails, phones, keys, names, addresses, financial/health info) with placeholder tokens; the token→original map never persists.
- Trivial captures get summarized locally and skip the Groq call (`handled_locally: true`).
- Fail-safe: Ollama down → `OLLAMA_FALLBACK_MODE=block` (default) rejects with 503 rather than leaking unredacted text to the cloud.
- Audit columns on `contexts`: `pii_flags`, `handled_locally`.

### Smart Slice — query-aware retrieval (the USP)
Problem: injecting a full session wastes 70–90% of tokens on stuff irrelevant to the user's next question, and long contexts dilute model attention ("lost in the middle").

Built:
- **Item-level embeddings**: `context_items` table — one row per entry across the 9 structured-context array categories, each with a 384-dim MiniLM embedding. Populated on every `/capture` (fire-and-forget) and backfilled for pre-existing sessions.
- **`engine/slicer.js`**: given a free-text query, embeds it, does hybrid retrieval (semantic cosine ∪ Postgres `ILIKE` keyword match), scores by `0.7·similarity + 0.3·keyword_boost`, applies:
  - similarity floor (drop items <0.05 sim)
  - dedup by normalized text (kills near-duplicate items from re-captured/forked sessions)
  - capped CRITICAL floor (top-2 importance=5 items above 0.25 sim — not "pin everything," since the structurer over-uses importance=5)
  - category quotas (at least 1–2 items per category if any clear a 0.25 sim bar)
  - greedy token-budget packing (default 800 tokens)
  - confidence gate: mean top-5 similarity <0.35 → `low_confidence: true` flag (doesn't block, just warns)
- **`POST /context/slice`** — returns formatted prompt + `slice_meta` (picked items, savings %, low-confidence flag).
- **Popup UI**: collapsible "💭 Smart Slice" composer above the session list → preview modal showing picked items grouped by session (collapsible), relevance pills (strong/good/loose/weak) instead of raw decimals, importance dots instead of a wall of "CRITICAL" badges, low-confidence banner with a "Use full session instead" escape hatch, savings chip (`⚡ 58% smaller · 805 tokens`), footer chip tracking monthly tokens saved (`chrome.storage.local.cb_savings`).
- Verified: real queries land 55–60% token savings at mean similarity 0.5–0.6; nonsense queries correctly get flagged low-confidence.

### Session organization (folders, rename, trash, version history)
Problem: sessions were flat with no rename, no grouping, and duplicate/near-duplicate captures had nowhere to consolidate. A `context_versions` table + `versioner.js` existed in the schema but were never wired up.

Built (migration `004_folders_and_soft_ops.sql`):
- `folders` table (`user_id`, `name`, `color`), `contexts.folder_id` (nullable = Inbox), `contexts.deleted_at`.
- Fixed `context_versions` FK to cascade on delete (was leaving orphan rows on hard-delete).
- Backend: `PATCH /context/:id` (rename + move, single call), `DELETE /context/:id` (soft delete) / `POST /context/:id/restore` / `DELETE /context/:id/purge`, `GET /context/trash`, `GET /context/:id/versions` + `POST /context/:id/versions/:v/restore`, full `/folders` CRUD router. `/merge` now snapshots v1 on creation.
- Extension: folder rail (chip strip: All · Inbox · folders · + · Trash) filtering the session list; per-session kebab menu (Rename · Version history · Move to folder · Delete); trash view with Restore/Delete forever; version history modal with per-version Restore (auto-snapshots current state first so restores are themselves reversible).
- Design choice: **rename is metadata-only and does not create a version** — only `structured_context` changes (merge, version restore) get snapshotted. Keeps version history meaningful instead of noisy.

---

## Infra notes worth remembering

- Local Postgres has **three clusters** running on this machine (5432/5433/5434). The app's `DATABASE_URL` points at port **5434** (Homebrew `postgresql@16`), auth is `trust` over the Unix socket — no password needed once you're on the right port/socket.
- `contexts` and `context_versions` tables were owned by role `apple`; had to `ALTER TABLE ... OWNER TO postgres` once so the app's DB role could run `ALTER TABLE` migrations against them.
- Backend restart pattern used throughout: `pkill -f "node index.js"; cd backend && nohup node index.js > /tmp/contextbridge-backend.log 2>&1 &`.

---

### Consumer-demand experiment (telemetry + attribution fix + fake-door paywall)
Decision context: went through a first-principles critique of the whole product (see conversation history — not reproduced here since it's reasoning, not shipped state). Verdict: stay on the consumer path (cross-model personal memory), but two structural risks needed fixing before it's worth spending 30 days measuring — (1) value was invisible/unattributed to the product, (2) no way to measure activation or week-2 retention at all.

Built:
- **`events` + `pro_waitlist` tables** (migration `005_events_and_waitlist.sql`). `POST /events` is allow-listed server-side (`install`, `capture_success`, `inject_success`, `slice_run`, `popup_open`, `w1_active`, `w2_retained`, `paywall_view`, `paywall_click`) — unknown types are silently accepted (202) but not stored, so a typo in the extension can't inject arbitrary rows. `POST /events/waitlist` takes an optional email, validated server-side.
- **`extension/telemetry.js`** — shared by `popup.js` (classic `<script>` tag) and `background.js` (`importScripts`). Fire-and-forget, swallows all errors, respects a `cb_telemetry_enabled` toggle (default on, visible switch in Settings with plain-language copy: "never includes message content"). Computes W1/W2 retention client-side from a stored `cb_first_open_at` timestamp with one-shot guards so each fires once.
- **Attribution fix**: every successful inject (quick-inject, modal inject, Smart Slice inject) now shows a distinct `.value-toast` — icon + headline + concrete token count ("Briefed Claude — no re-explaining needed · ~842 tokens, injected instantly"), separate from the existing generic `.toast`. This is the Grammarly/Honey pattern: make the win visible and attributed at the moment it happens, not silently absorbed into "the model was smart."
- **Pro paywall fake door**: a contextual banner (shown only after real usage — savings > 0 or 3+ captures, never on first open) opens a waitlist modal. Measures `paywall_view` → `paywall_click` → waitlist-join as the CTR signal from the decision framework.

This is instrumentation for a decision, not a monetization launch — the numbers this produces (activation rate, W2 retention, paywall CTR) are the inputs to a go/no-go on the consumer path versus other directions.

### Capture speed — script-based redaction as the default privacy gate
Problem: captures were taking 15-20s on a good run, and one real capture took **277 seconds** and then failed outright (`Local privacy gate failed to analyse the conversation`). Root cause: `.env` had `OLLAMA_MODEL=phi3`, a small model that routinely ignores "output ONLY JSON" and produces malformed output — the code's own prior comments already flagged this — triggering a retry (2x the local-model latency) with no timeout guard, so a slow/failed call could hang indefinitely. On a base M1 (confirmed via `ollama ps` — 100% GPU/Metal, so not a config issue, just a heavy model for the hardware), even a clean single-pass call to phi3 took 15-19s.

Fixed in two layers:
1. **Made the existing Ollama path robust** (still available as `PII_GATE_MODE=llm`): `format: 'json'` on the Ollama call (grammar-constrained decoding — eliminates most malformed-output retries at the source), a hard 25s timeout via `AbortController` (bounds worst case at ~50s instead of unbounded), lowered `num_predict` 400→200 (real expected output is a handful of short redaction entries), and a 15s cache on the health check so back-to-back captures don't pay a redundant round-trip each time.
2. **Added a script-only mode and made it the default** (`PII_GATE_MODE=script`, `backend/engine/local-gate.js`): no local model call at all. Deterministic regex/heuristic redaction — extended the existing email/phone/API-key patterns with SSN, street addresses, and Luhn-validated credit card numbers, plus a name heuristic (trigger phrase like "my name is X" / "call me X" + a capitalized 1-3 word proper-noun match — case-insensitive on the trigger, case-sensitive on the name itself so it doesn't over-match lowercase phrases like "this is great"). Triviality short-circuit becomes a pure length check (≤80 chars) reusing the same threshold the LLM path already trusted over the model's own judgment.

Result: `local_gate` step went from 15,000-18,000ms (or 277,000ms on failure) to **2-3ms**. Full capture round-trip (including the Groq structuring call) is now ~0.6-4.5s depending on conversation length, down from a floor of ~19s.

Trade-off, documented in `.env.example`: script mode has lower recall than `llm` mode on names mentioned without a self-introduction ("my colleague John Park" — no trigger phrase, not caught), unusual address formats, and health/financial context an LLM would catch from semantic understanding rather than pattern-matching. `PII_GATE_MODE=llm` remains available for anyone who wants the stronger (slower) guarantee.

## Deferred / not built yet

- Multi-model content scrapers — only ChatGPT has a DOM scraper; Claude/Gemini/Ollama are paste-only.
- Graph visualization — no entity-relationship data stored beyond flat `context_items`; would need entity-extraction work first to be more than cosmetic.
- Bulk folder move, nested folders, auto-purge of trash after N days (column is there, no job yet), shared/team folders.
- Re-capture dedupe (detect "this looks like an update to session X" at capture time) — flagged as a stretch idea, not started.
