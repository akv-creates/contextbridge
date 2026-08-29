// One-time backfill: flatten every existing session's structured_context into
// context_items rows with MiniLM embeddings. Safe to re-run — skips sessions
// that already have items.
//
// Usage:  node backend/db/backfill-items.js
//         DATABASE_URL=... node backend/db/backfill-items.js
//
// Idempotent: a session is skipped if it already has >= 1 row in context_items.

import 'dotenv/config';
import { query } from '../memory/postgres.js';
import { saveContextItems } from '../memory/postgres.js';
import { embed } from '../memory/embeddings.js';

const ITEM_CATEGORIES = [
  'goals', 'constraints', 'decisions', 'assumptions',
  'tech_stack', 'architecture', 'open_questions', 'key_entities', 'timeline',
];

function flatten(structured) {
  const rows = [];
  for (const cat of ITEM_CATEGORIES) {
    const arr = structured?.[cat];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      const text = typeof item === 'string' ? item : item?.text;
      if (!text || !String(text).trim()) continue;
      const importance = typeof item === 'object' && Number.isInteger(item.importance)
        ? item.importance : 3;
      rows.push({ category: cat, item_text: text, importance });
    }
  }
  return rows;
}

async function main() {
  console.log('[backfill] Starting…');

  const sessions = await query(
    `SELECT c.id, c.user_id, c.title, c.structured_context,
            (SELECT COUNT(*) FROM context_items ci WHERE ci.session_id = c.id) AS item_count
     FROM contexts c
     WHERE c.is_deleted = false
     ORDER BY c.created_at ASC`,
  );

  console.log(`[backfill] Found ${sessions.rows.length} sessions`);

  let processed = 0;
  let skipped = 0;
  let totalItems = 0;
  let failed = 0;

  for (const s of sessions.rows) {
    if (Number(s.item_count) > 0) {
      skipped++;
      continue;
    }

    const rows = flatten(s.structured_context);
    if (rows.length === 0) {
      skipped++;
      continue;
    }

    try {
      const enriched = [];
      for (const r of rows) {
        const vec = await embed(r.item_text);
        enriched.push({ ...r, embedding: vec });
      }
      await saveContextItems(s.user_id, s.id, enriched);
      totalItems += enriched.length;
      processed++;
      console.log(`[backfill] ${s.id} (${s.title?.slice(0, 40) || 'untitled'}) — ${enriched.length} items`);
    } catch (err) {
      failed++;
      console.error(`[backfill] Failed ${s.id}:`, err.message);
    }
  }

  console.log('[backfill] Done.');
  console.log(`  Processed: ${processed}`);
  console.log(`  Skipped:   ${skipped}`);
  console.log(`  Failed:    ${failed}`);
  console.log(`  Total items indexed: ${totalItems}`);

  process.exit(0);
}

main().catch((err) => {
  console.error('[backfill] Fatal:', err);
  process.exit(1);
});
