// Express route for context injection — POST /context/inject per PRD §5.3.

import { Router } from 'express';
import { getSession } from '../memory/postgres.js';
import { assembleBundle } from '../engine/assembler.js';
import { formatForClaude } from '../adapters/claude.js';
import { formatForGPT } from '../adapters/gpt.js';
import { formatForOllama } from '../adapters/ollama.js';
import { formatForGemini } from '../adapters/gemini.js';

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

export default router;
