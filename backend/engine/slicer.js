// Smart Slice — query-aware retrieval over a user's item-level embeddings.
// Produces a focused structured_context bundle scoped to the user's next
// question, with explicit safeguards so output quality doesn't regress.
//
// Flow:
//   1. Embed the query with the same MiniLM model used at capture time.
//   2. Build a hybrid candidate pool (semantic top-K ∪ keyword ILIKE matches).
//   3. Score each candidate with similarity + importance + keyword boost.
//   4. Pin always-include items (CRITICAL + summary) regardless of score.
//   5. Apply category quotas so slices stay balanced across goals/decisions/etc.
//   6. Greedy-pack into a token budget (default 800).
//   7. Confidence gate: if top-K mean similarity is too low, signal caller
//      to fall back to full context instead of an unreliable slice.

import {
  getContextItemsForUser,
  searchContextItemsByKeywords,
  getSession,
} from '../memory/postgres.js';
import { embed, cosineSim } from '../memory/embeddings.js';

// Tunable via env so we can iterate in prod without redeploys.
const CONFIDENCE_THRESHOLD = Number(process.env.SLICE_CONFIDENCE_THRESHOLD || 0.35);
const DEFAULT_TOKEN_BUDGET = Number(process.env.SLICE_TOKEN_BUDGET || 800);
const DEFAULT_TOP_K = Number(process.env.SLICE_TOP_K || 15);

// Category-level minimums — when a category has items, we guarantee at least
// this many get through, even if they score below the top-K cutoff. Keeps the
// slice "shaped" like a real session rather than all-goals-no-constraints.
const CATEGORY_MIN = {
  goals: 2,
  decisions: 2,
  constraints: 1,
  tech_stack: 1,
  architecture: 1,
  assumptions: 1,
  open_questions: 1,
  key_entities: 1,
  timeline: 0,
};

// Rough token estimator matching engine/assembler.js:estimateTokens.
function estimateTokens(str) {
  return Math.ceil(String(str || '').length / 4);
}

// Extract keyword tokens from a free-form query. Strips stopwords + short words;
// empty result means semantic retrieval runs alone.
const STOPWORDS = new Set([
  'the','a','an','and','or','but','if','then','so','as','of','in','on','at','to','for',
  'from','by','with','about','is','are','was','were','be','been','being','do','does',
  'did','have','has','had','not','no','yes','it','this','that','these','those','i','we',
  'you','they','he','she','my','your','our','their','me','us','him','her','them','how',
  'what','why','when','where','which','who','can','could','should','would','will','shall',
]);

function extractKeywords(query) {
  return String(query || '')
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
    .slice(0, 8); // cap query tokens to keep ILIKE fast
}

// Score one item against the query:
//   base = 0.7 * semantic + 0.3 * keyword_boost
//   final = base * (0.7 + 0.1 * importance)
// importance range is 1..5, so multiplier spans 0.8 .. 1.2 — nudges critical
// items up without letting them dominate irrelevant content.
function scoreItem(item, queryVec, keywordTokens) {
  const semantic = cosineSim(queryVec, item.embedding);
  let keywordBoost = 0;
  if (keywordTokens.length > 0) {
    const text = item.item_text.toLowerCase();
    const hits = keywordTokens.filter((t) => text.includes(t)).length;
    keywordBoost = Math.min(1, hits / keywordTokens.length);
  }
  const base = 0.7 * semantic + 0.3 * keywordBoost;
  const importanceMult = 0.7 + 0.1 * (item.importance || 3);
  return {
    score: base * importanceMult,
    raw_similarity: semantic,
  };
}

// Build the sliced structured_context bundle. Returns an object in the same
// shape as assembleBundle's output so the adapter layer can render it unchanged.
function groupByCategory(items) {
  const out = { summary: '' };
  for (const it of items) {
    if (!out[it.category]) out[it.category] = [];
    out[it.category].push(it.item_text);
  }
  return out;
}

export async function sliceForQuery(userId, query, options = {}) {
  const {
    maxTokens = DEFAULT_TOKEN_BUDGET,
    topK = DEFAULT_TOP_K,
    confidenceThreshold = CONFIDENCE_THRESHOLD,
  } = options;

  const trimmed = String(query || '').trim();
  if (!trimmed) {
    return { empty: true, reason: 'empty_query' };
  }

  // 1. Embed query + pull candidate pool.
  const queryVec = await embed(trimmed);
  const keywordTokens = extractKeywords(trimmed);

  const [semanticPool, keywordPool] = await Promise.all([
    getContextItemsForUser(userId),
    keywordTokens.length > 0
      ? searchContextItemsByKeywords(userId, keywordTokens)
      : Promise.resolve([]),
  ]);

  if (semanticPool.length === 0) {
    return { empty: true, reason: 'no_items_indexed' };
  }

  // Merge pools — keyword hits are tagged so we can boost them even if their
  // similarity alone wouldn't make the cut.
  const keywordIds = new Set(keywordPool.map((r) => r.id));
  const merged = new Map();
  for (const r of semanticPool) merged.set(r.id, r);
  for (const r of keywordPool) if (!merged.has(r.id)) merged.set(r.id, r);

  // 2. Score every candidate. Drop truly irrelevant items (negative similarity
  // means the vector points the opposite direction — no chance this helps).
  const MIN_SIMILARITY_FLOOR = 0.05;
  const scored = [];
  for (const item of merged.values()) {
    const { score, raw_similarity } = scoreItem(item, queryVec, keywordTokens);
    if (raw_similarity < MIN_SIMILARITY_FLOOR && !keywordIds.has(item.id)) continue;
    scored.push({
      ...item,
      score: keywordIds.has(item.id) ? score * 1.1 : score, // small bonus for exact keyword hits
      raw_similarity,
    });
  }
  scored.sort((a, b) => b.score - a.score);

  // 2a. Deduplicate by normalized text — near-identical items appear across
  // forked/re-captured sessions and would otherwise fill the slice with
  // repeats. Keep the highest-scored occurrence of each text.
  const seenText = new Map(); // normText -> best score
  const deduped = [];
  for (const it of scored) {
    const norm = String(it.item_text || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const prev = seenText.get(norm);
    if (prev === undefined) {
      seenText.set(norm, it.score);
      deduped.push(it);
    }
    // else: skip — we already have a better-scored copy
  }

  // 3. Confidence gate — if top 5 similarities are weak, caller should fall back.
  const topSims = deduped.slice(0, 5).map((s) => s.raw_similarity);
  const meanTop = topSims.length > 0
    ? topSims.reduce((a, b) => a + b, 0) / topSims.length
    : 0;
  const low_confidence = meanTop < confidenceThreshold;
  // Low confidence doesn't abort — we still build the best-effort slice and
  // flag it. The UI surfaces a banner so the user can decide to inject it,
  // refine their query, or fall back to a full session inject.

  // 4. Always-include floor: pin a small number of CRITICAL items that also
  // have meaningful similarity to the query. Our structurer marks most items
  // importance=5, so pinning all of them would blow the budget and defeat
  // the purpose of slicing. Cap at top-3 CRITICAL-by-score above a floor sim.
  const CRITICAL_FLOOR_CAP = 2;
  const CRITICAL_MIN_SIM = 0.25;
  const selectedIds = new Set();
  const selected = [];
  const itemBudget = Math.floor(maxTokens * 0.8);
  let usedTokens = 0;
  const pushIfFits = (item, { force = false } = {}) => {
    if (selectedIds.has(item.id)) return false;
    const cost = estimateTokens(item.item_text);
    if (!force && usedTokens + cost > itemBudget) return false;
    selectedIds.add(item.id);
    selected.push(item);
    usedTokens += cost;
    return true;
  };
  const criticalCandidates = deduped
    .filter((it) => it.importance >= 5 && it.raw_similarity >= CRITICAL_MIN_SIM)
    .slice(0, CRITICAL_FLOOR_CAP);
  for (const it of criticalCandidates) pushIfFits(it);

  // 5. Category quotas — fill each category up to CATEGORY_MIN from top-scored
  // items in that category, but only if they clear a modest similarity bar.
  // Respects token budget.
  const QUOTA_MIN_SIM = 0.25;
  for (const [cat, minCount] of Object.entries(CATEGORY_MIN)) {
    if (minCount === 0) continue;
    const inCat = deduped.filter(
      (s) => s.category === cat && !selectedIds.has(s.id) && s.raw_similarity >= QUOTA_MIN_SIM,
    );
    const existingInCat = selected.filter((s) => s.category === cat).length;
    const need = Math.max(0, minCount - existingInCat);
    for (let i = 0; i < need && i < inCat.length; i++) pushIfFits(inCat[i]);
  }

  // 6. Greedy-pack remaining top-scored items into the token budget.
  for (const it of deduped) {
    if (selected.length >= topK) break;
    if (selectedIds.has(it.id)) continue;
    pushIfFits(it);
  }

  // 7. Pin summaries from every session represented in the slice.
  // One summary per session so multi-session slices stay grounded.
  const sessionIds = [...new Set(selected.map((s) => s.session_id))];
  const summaries = [];
  for (const sid of sessionIds) {
    const sess = await getSession(sid, userId);
    if (sess && sess.structured_context && sess.structured_context.summary) {
      summaries.push(sess.structured_context.summary);
    }
  }
  const combinedSummary = summaries.join(' | ');

  // Build bundle shape compatible with assembleBundle output.
  const bundle = groupByCategory(selected);
  bundle.summary = combinedSummary;

  const picked_meta = selected.map((s) => ({
    id: s.id,
    session_id: s.session_id,
    session_title: s.session_title,
    source_model: s.source_model,
    category: s.category,
    text: s.item_text,
    score: Number(s.score.toFixed(4)),
    similarity: Number(s.raw_similarity.toFixed(4)),
    importance: s.importance,
  }));

  return {
    empty: false,
    low_confidence,
    bundle,
    picked_meta,
    selected_count: selected.length,
    excluded_count: deduped.length - selected.length,
    mean_similarity: meanTop,
    token_estimate: estimateTokens(JSON.stringify(bundle)),
  };
}
