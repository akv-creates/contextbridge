// Shared capture pipeline — local privacy gate -> structure -> save -> index.
// Used by both POST /context/capture (chat messages) and POST /context/capture-file
// (uploaded documents), so the doc path gets the exact same PII redaction,
// triviality short-circuit, and Smart Slice indexing as chat capture.

import { structureContext } from './structurer.js';
import { localGate } from './local-gate.js';
import { saveSession, saveContextItems } from '../memory/postgres.js';
import { saveEmbedding } from '../memory/faiss.js';
import { embed } from '../memory/embeddings.js';

// Categories that live as arrays in structured_context — flattened into one
// context_items row per entry for Smart Slice retrieval.
const ITEM_CATEGORIES = [
  'goals', 'constraints', 'decisions', 'assumptions',
  'tech_stack', 'architecture', 'open_questions', 'key_entities', 'timeline',
];

// Flatten a structured_context into [{category, item_text, importance}] rows.
// Accepts both scored objects ({text, importance}) and plain strings.
function flattenStructuredForItems(structured) {
  const rows = [];
  for (const cat of ITEM_CATEGORIES) {
    const arr = structured[cat];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      const text = typeof item === 'string' ? item : item.text;
      if (!text || !text.trim()) continue;
      const importance = typeof item === 'object' && Number.isInteger(item.importance)
        ? item.importance
        : 3;
      rows.push({ category: cat, item_text: text, importance });
    }
  }
  return rows;
}

// Embed + persist items for Smart Slice. Fire-and-forget with error logging —
// must not block the capture response. Serial on purpose: MiniLM on CPU
// doesn't benefit from parallel calls and we'd rather avoid spikes.
async function embedAndSaveItems(userId, sessionId, structured) {
  const rows = flattenStructuredForItems(structured);
  if (rows.length === 0) return;
  const enriched = [];
  for (const r of rows) {
    try {
      const vec = await embed(r.item_text);
      enriched.push({ ...r, embedding: vec });
    } catch (err) {
      console.error('[capture-flow] item embed failed:', err.message);
    }
  }
  if (enriched.length > 0) {
    await saveContextItems(userId, sessionId, enriched);
  }
}

const toText = (item) => (typeof item === 'string' ? item : item.text);

// Runs the full capture pipeline for a set of {role, content} messages and
// returns the same response shape /context/capture has always returned.
export async function runCaptureFlow(sourceModel, messages, userId) {
  const t0 = Date.now();
  const { sanitized_messages, redaction_map, pii_flags, handled_locally, local_structured } =
    await localGate(messages);
  const t1 = Date.now();

  const structured = handled_locally ? local_structured : await structureContext(sanitized_messages);
  const t2 = Date.now();

  const sessionId = await saveSession(userId, sourceModel, sanitized_messages, structured, pii_flags, handled_locally);

  console.log(`[capture-flow] timing — local_gate: ${t1 - t0}ms, structurer: ${t2 - t1}ms (handled_locally: ${handled_locally})`);

  const embeddingText = [
    structured.summary,
    ...structured.goals.map(toText),
    ...structured.constraints.map(toText),
    ...structured.decisions.map(toText),
    ...structured.tech_stack.map(toText),
    ...structured.architecture.map(toText),
    ...structured.open_questions.map(toText),
    ...structured.key_entities.map(toText),
    ...structured.timeline.map(toText),
  ].filter(Boolean).join(' ');

  if (embeddingText.trim()) {
    saveEmbedding(sessionId, embeddingText).catch((err) => {
      console.error('[capture-flow] Embedding failed for session:', sessionId, err.message);
    });
  }

  // Per-item embeddings for Smart Slice. Fire-and-forget — the caller gets
  // its response immediately; indexing catches up in the background.
  embedAndSaveItems(userId, sessionId, structured).catch((err) => {
    console.error('[capture-flow] Item-level embed failed for session:', sessionId, err.message);
  });

  const tokenCount = Math.ceil(JSON.stringify(structured).length / 4);

  console.log('[capture-flow] Completed for session:', sessionId);

  return {
    session_id: sessionId,
    title: structured.title,
    summary: structured.summary,
    goals: structured.goals.map(toText),
    constraints: structured.constraints.map(toText),
    decisions: structured.decisions.map(toText),
    assumptions: structured.assumptions.map(toText),
    tech_stack: structured.tech_stack.map(toText),
    architecture: structured.architecture.map(toText),
    open_questions: structured.open_questions.map(toText),
    key_entities: structured.key_entities.map(toText),
    timeline: structured.timeline.map(toText),
    token_count: tokenCount,
    // Local privacy gate audit — counts per PII category redacted on-device
    // before any cloud call, and whether the cloud structurer was skipped.
    pii_flags: pii_flags || {},
    handled_locally: Boolean(handled_locally),
    // Transient redaction map (token -> original). Returned to the local
    // extension only so the user can selectively un-redact before transfer.
    // NEVER persisted server-side (not saved to DB) — held in popup memory only.
    redaction_map: redaction_map || {},
  };
}
