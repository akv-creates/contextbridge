// Express routes for context capture and retrieval — thin wrappers over engine and memory layers.

import { Router } from 'express';
import { structureContext } from '../engine/structurer.js';
import { saveSession, getSessions, getSession } from '../memory/postgres.js';
import { saveEmbedding } from '../memory/faiss.js';

const router = Router();

// POST /context/capture
router.post('/capture', async (req, res, next) => {
  try {
    const { source_model, messages, user_id } = req.body;

    if (!source_model || typeof source_model !== 'string') {
      return res.status(400).json({ error: 'source_model is required and must be a string' });
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages is required and must be a non-empty array' });
    }
    if (!user_id || typeof user_id !== 'string') {
      return res.status(400).json({ error: 'user_id is required and must be a string' });
    }

    const structured = await structureContext(messages);

    const sessionId = await saveSession(user_id, source_model, messages, structured);

    // Items are scored objects { text, importance } — extract plain text for embedding.
    const toText = (item) => (typeof item === 'string' ? item : item.text);

    const embeddingText = [
      structured.summary,
      ...structured.goals.map(toText),
      ...structured.constraints.map(toText),
      ...structured.decisions.map(toText),
      ...structured.tech_stack.map(toText),
      ...structured.architecture.map(toText),
      ...structured.open_questions.map(toText),
      ...structured.key_entities.map(toText),
    ].filter(Boolean).join(' ');

    if (embeddingText.trim()) {
      saveEmbedding(sessionId, embeddingText).catch((err) => {
        console.error('[context/capture] Embedding failed for session:', sessionId, err.message);
      });
    }

    const tokenCount = Math.ceil(JSON.stringify(structured).length / 4);

    console.log('[context/capture] Completed for session:', sessionId);

    // Return plain string arrays to the client (importance scores are internal).
    return res.status(201).json({
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
      token_count: tokenCount,
    });
  } catch (err) {
    next(err);
  }
});

// GET /context/sessions?user_id=...
router.get('/sessions', async (req, res, next) => {
  try {
    const { user_id, limit = 20, offset = 0 } = req.query;

    if (!user_id) {
      return res.status(400).json({ error: 'user_id query param is required' });
    }

    const result = await getSessions(user_id, Number(limit), Number(offset));
    return res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /context/:id?user_id=...
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { user_id } = req.query;

    if (!user_id) {
      return res.status(400).json({ error: 'user_id query param is required' });
    }

    const session = await getSession(id, user_id);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    return res.json({ ...session, versions: [] });
  } catch (err) {
    next(err);
  }
});

export default router;
