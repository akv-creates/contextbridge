// Express route for context injection — POST /context/inject per PRD §5.3.

import { Router } from 'express';
import { getSession, getContextItemsForUser } from '../memory/postgres.js';
import { assembleBundle } from '../engine/assembler.js';
import { sliceForQuery } from '../engine/slicer.js';
import { formatForClaude } from '../adapters/claude.js';
import { formatForGPT } from '../adapters/gpt.js';
import { formatForOllama } from '../adapters/ollama.js';
import { formatForGemini } from '../adapters/gemini.js';
import { formatForMarkdown } from '../adapters/markdown.js';

// Render a bundle via the adapter matching target_model. format: 'markdown'
// on non-Claude targets overrides to the universal markdown renderer.
function renderBundle(bundle, target_model, format) {
  const wantMarkdown =
    target_model === 'markdown' ||
    (format === 'markdown' && target_model !== 'claude');
  if (wantMarkdown) return { formatted: formatForMarkdown(bundle), adapter: 'markdown' };
  switch (target_model) {
    case 'claude':          return { formatted: formatForClaude(bundle), adapter: 'claude' };
    case 'chatgpt':
    case 'gpt':             return { formatted: formatForGPT(bundle), adapter: 'gpt' };
    case 'ollama':          return { formatted: formatForOllama(bundle), adapter: 'ollama' };
    case 'gemini':          return { formatted: formatForGemini(bundle), adapter: 'gemini' };
    default:                return null;
  }
}

const router = Router();

// POST /context/inject
// Body: { session_id, target_model, format?, include, version_number, user_id }
// format: "prompt" (default) — returns formatted_prompt string
//         "json"            — returns structured JSON with metadata wrapper
router.post('/inject', async (req, res, next) => {
  try {
    const {
      session_id,
      user_id,
      target_model,
      format = 'prompt',
      include = { goals: true, constraints: true, decisions: true, raw_summary: false },
      version_number = null,
    } = req.body;

    if (!session_id) return res.status(400).json({ error: 'session_id is required' });
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });
    if (!target_model) return res.status(400).json({ error: 'target_model is required' });

    const session = await getSession(session_id, user_id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // Map include flags to assembler options.
    const assemblerOptions = {
      includeGoals: include.goals !== false,
      includeConstraints: include.constraints !== false,
      includeDecisions: include.decisions !== false,
      includeAssumptions: include.assumptions !== false,
      includeTechStack: include.tech_stack !== false,
      includeArchitecture: include.architecture !== false,
      includeOpenQuestions: include.open_questions !== false,
      includeKeyEntities: include.key_entities !== false,
      includeTimeline: include.timeline !== false,
      includeSummary: include.summary !== false,
      showImportance: true,
      maxTokens: 4000,
    };

    const { bundle, tokenCount } = assembleBundle(session.structured_context, assemblerOptions);

    // JSON format — return structured data with metadata wrapper.
    if (format === 'json') {
      console.log('[inject] JSON context for session:', session_id);
      return res.json({
        json_context: {
          context_metadata: {
            session_id: session.id,
            source_model: session.source_model,
            captured_at: session.created_at,
            version: '1.0.0',
          },
          context: bundle,
        },
        token_count: tokenCount,
      });
    }

    // Prompt format — format via adapter.
    let formatted;
    let adapterUsed;

    // Universal markdown override: any target except Claude can opt into
    // the portable markdown renderer via format: 'markdown'. Claude keeps
    // its XML-tagged flavor because the Anthropic API / claude.ai chat are
    // tuned for it. target_model 'markdown' forces markdown unconditionally
    // (used by the .md export path).
    const wantMarkdown =
      target_model === 'markdown' ||
      (format === 'markdown' && target_model !== 'claude');

    if (wantMarkdown) {
      formatted = formatForMarkdown(bundle);
      adapterUsed = 'markdown';
    } else {
      switch (target_model) {
        case 'claude':
          formatted = formatForClaude(bundle);
          adapterUsed = 'claude';
          break;
        case 'chatgpt':
        case 'gpt':
          formatted = formatForGPT(bundle);
          adapterUsed = 'gpt';
          break;
        case 'ollama':
          formatted = formatForOllama(bundle);
          adapterUsed = 'ollama';
          break;
        case 'gemini':
          formatted = formatForGemini(bundle);
          adapterUsed = 'gemini';
          break;
        default:
          return res.status(400).json({ error: `Unknown target_model: ${target_model}` });
      }
    }

    console.log('[inject] Formatted context for session:', session_id);

    return res.json({
      formatted_prompt: formatted,
      token_count: tokenCount,
      adapter_used: adapterUsed,
    });
  } catch (err) {
    next(err);
  }
});

// POST /context/slice — Smart Slice: query-aware retrieval across all a user's
// sessions. Returns a token-trimmed focused inject payload + savings metadata.
//
// Body: { user_id, query, target_model, format?, max_tokens?, top_k? }
router.post('/slice', async (req, res, next) => {
  try {
    const {
      user_id,
      query,
      target_model,
      format = 'prompt',
      max_tokens,
      top_k,
    } = req.body;

    if (!user_id) return res.status(400).json({ error: 'user_id is required' });
    if (!query || !String(query).trim()) return res.status(400).json({ error: 'query is required' });
    if (!target_model) return res.status(400).json({ error: 'target_model is required' });

    const slice = await sliceForQuery(user_id, query, {
      maxTokens: max_tokens,
      topK: top_k,
    });

    if (slice.empty) {
      // No items indexed yet — the caller should fall back to picking a session
      // manually. 200 with empty flag so the UI can show a helpful message.
      return res.json({
        empty: true,
        reason: slice.reason,
      });
    }

    const rendered = renderBundle(slice.bundle, target_model, format);
    if (!rendered) {
      return res.status(400).json({ error: `Unknown target_model: ${target_model}` });
    }

    // Full-inject token estimate = every item across the sessions represented
    // in the slice. This is what the user would have paid if they'd injected
    // each session in full instead of slicing.
    const fullTokenEstimate = await estimateFullTokensForSessions(
      user_id,
      slice.picked_meta,
    );
    const tokenCount = Math.ceil(rendered.formatted.length / 4);
    const savingsPct = fullTokenEstimate > 0
      ? Math.max(0, Math.round((1 - tokenCount / fullTokenEstimate) * 100))
      : 0;

    console.log('[inject/slice] query-len:', String(query).length,
      'picked:', slice.selected_count,
      'excluded:', slice.excluded_count,
      'low_conf:', slice.low_confidence);

    return res.json({
      formatted_prompt: rendered.formatted,
      token_count: tokenCount,
      adapter_used: rendered.adapter,
      slice_meta: {
        picked: slice.picked_meta,
        selected_count: slice.selected_count,
        excluded_count: slice.excluded_count,
        mean_similarity: slice.mean_similarity,
        low_confidence: slice.low_confidence,
        full_token_estimate: fullTokenEstimate,
        savings_pct: savingsPct,
      },
    });
  } catch (err) {
    next(err);
  }
});

// Estimate what a full (non-sliced) inject of the sessions in this slice
// would have cost. Pulls every item for the user and sums the ones belonging
// to sessions represented in the pick, plus a per-session overhead for
// summary + category headings.
async function estimateFullTokensForSessions(userId, pickedMeta) {
  const sessionIds = new Set(pickedMeta.map((p) => p.session_id));
  if (sessionIds.size === 0) return 0;
  const allItems = await getContextItemsForUser(userId);
  let total = 0;
  for (const it of allItems) {
    if (sessionIds.has(it.session_id)) {
      total += Math.ceil((it.item_text || '').length / 4);
    }
  }
  return total + sessionIds.size * 80; // ~80 tokens per session for summary + headings
}

export default router;
