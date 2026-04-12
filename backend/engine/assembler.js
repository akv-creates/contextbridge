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
