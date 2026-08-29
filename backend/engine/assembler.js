// Assembles a trimmed context bundle from structured context based on options and token budget.

// Items may be plain strings or scored objects { text, importance } from the structurer.
function toText(item) {
  return typeof item === 'string' ? item : item.text;
}

function toImportance(item) {
  return typeof item === 'string' ? 3 : (item.importance || 3);
}

// Format item with importance indicator for high/low value items.
function toScoredText(item) {
  const text = toText(item);
  const imp = toImportance(item);
  if (imp >= 5) return '[CRITICAL] ' + text;
  if (imp >= 4) return text;
  if (imp <= 2) return '[low] ' + text;
  return text;
}

// Least-important category trimmed first per PRD ENG-04.
const CATEGORY_PRIORITY = [
  'key_entities',
  'assumptions',
  'open_questions',
  'timeline',
  'constraints',
  'architecture',
  'tech_stack',
  'decisions',
  'goals',
];

export function assembleBundle(structuredContext, options = {}) {
  const {
    includeGoals = true,
    includeConstraints = true,
    includeDecisions = true,
    includeAssumptions = true,
    includeTechStack = true,
    includeArchitecture = true,
    includeOpenQuestions = true,
    includeKeyEntities = true,
    includeTimeline = true,
    includeSummary = true,
    showImportance = true,
    maxTokens = 4000,
  } = options;

  let bundle = {};

  // Summary is a string, not an array — include directly.
  if (includeSummary && structuredContext.summary) {
    bundle.summary = typeof structuredContext.summary === 'string'
      ? structuredContext.summary
      : '';
  }

  const arrayCategories = [
    { key: 'goals', include: includeGoals },
    { key: 'constraints', include: includeConstraints },
    { key: 'decisions', include: includeDecisions },
    { key: 'assumptions', include: includeAssumptions },
    { key: 'tech_stack', include: includeTechStack },
    { key: 'architecture', include: includeArchitecture },
    { key: 'open_questions', include: includeOpenQuestions },
    { key: 'key_entities', include: includeKeyEntities },
    { key: 'timeline', include: includeTimeline },
  ];

  const formatter = showImportance ? toScoredText : toText;

  for (const { key, include } of arrayCategories) {
    if (include && structuredContext[key] && structuredContext[key].length > 0) {
      bundle[key] = [...structuredContext[key]]
        .sort((a, b) => toImportance(b) - toImportance(a))
        .map(formatter);
    }
  }

  // Trim from least important category first until under token budget.
  let tokenCount = estimateTokens(bundle);

  while (tokenCount > maxTokens) {
    let trimmed = false;
    for (const cat of CATEGORY_PRIORITY) {
      if (bundle[cat] && Array.isArray(bundle[cat]) && bundle[cat].length > 0) {
        bundle[cat].pop();
        if (bundle[cat].length === 0) delete bundle[cat];
        tokenCount = estimateTokens(bundle);
        trimmed = true;
        break;
      }
    }
    if (!trimmed) break;
  }

  return { bundle, tokenCount };
}

function estimateTokens(bundle) {
  return Math.ceil(JSON.stringify(bundle).length / 4);
}

// ── Merge multiple structured contexts ──────────────────────────────────────

// Jaccard word-overlap similarity for deduplication.
function jaccardSimilarity(a, b) {
  const wordsA = new Set(a.toLowerCase().split(/\s+/));
  const wordsB = new Set(b.toLowerCase().split(/\s+/));
  let intersection = 0;
  for (const w of wordsA) { if (wordsB.has(w)) intersection++; }
  const union = wordsA.size + wordsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function deduplicateItems(items) {
  const result = [];
  for (const item of items) {
    const text = toText(item);
    const isDuplicate = result.some(function(existing) {
      return jaccardSimilarity(toText(existing), text) > 0.85;
    });
    if (!isDuplicate) {
      result.push(item);
    } else {
      // Keep the more detailed version (longer text or higher importance)
      const idx = result.findIndex(function(existing) {
        return jaccardSimilarity(toText(existing), text) > 0.85;
      });
      if (idx !== -1) {
        const existingText = toText(result[idx]);
        if (text.length > existingText.length || toImportance(item) > toImportance(result[idx])) {
          result[idx] = item;
        }
      }
    }
  }
  return result;
}

export function mergeContexts(contexts, title) {
  const ARRAY_KEYS = ['goals', 'constraints', 'decisions', 'assumptions', 'tech_stack', 'architecture', 'open_questions', 'key_entities', 'timeline'];

  const merged = {
    title: title || contexts[0]?.title || 'Merged Session',
    summary: 'Merged context from ' + contexts.length + ' sessions. ' +
      contexts.map(function(c) { return c.summary || ''; }).filter(Boolean).join(' | '),
  };

  for (const key of ARRAY_KEYS) {
    const allItems = [];
    for (const ctx of contexts) {
      if (ctx[key] && Array.isArray(ctx[key])) {
        allItems.push(...ctx[key]);
      }
    }
    merged[key] = deduplicateItems(allItems);
  }

  return merged;
}
