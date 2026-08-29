// Express routes for context capture and retrieval — thin wrappers over engine and memory layers.

import { Router } from 'express';
import { runCaptureFlow } from '../engine/capture-flow.js';
import { mergeContexts, assembleBundle } from '../engine/assembler.js';
import {
  getSessions, getSession, getAllSessionsFull, saveSession,
  updateSession, softDeleteSession, restoreSession, purgeSession, listTrashed,
} from '../memory/postgres.js';
import { formatForMarkdown } from '../adapters/markdown.js';
import { saveVersion, getVersions } from '../engine/versioner.js';

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

    const result = await runCaptureFlow(source_model, messages, user_id);
    return res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// GET /context/sessions?user_id=...
router.get('/sessions', async (req, res, next) => {
  try {
    const { user_id, limit = 20, offset = 0, folder_id } = req.query;

    if (!user_id) {
      return res.status(400).json({ error: 'user_id query param is required' });
    }

    const result = await getSessions(user_id, Number(limit), Number(offset), { folderId: folder_id });
    return res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /context/export-all.md?user_id=...
// Concatenates every non-deleted session into a single markdown knowledge file.
// Drop-in for Claude Projects / Custom GPT knowledge / Gemini Gems / NotebookLM.
router.get('/export-all.md', async (req, res, next) => {
  try {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id query param is required' });

    const sessions = await getAllSessionsFull(user_id);
    if (!sessions.length) {
      return res.status(404).json({ error: 'No sessions to export' });
    }

    const parts = [
      '# ContextBridge — All Sessions',
      '',
      `> ${sessions.length} session(s) exported on ${new Date().toISOString().slice(0, 10)}.`,
      '> Each session below is a self-contained block separated by a horizontal rule.',
      '',
      '---',
      '',
    ];

    for (const s of sessions) {
      const { bundle } = assembleBundle(s.structured_context, { maxTokens: 8000 });
      const md = formatForMarkdown(bundle);
      const captured = s.created_at ? new Date(s.created_at).toISOString().slice(0, 10) : '';
      parts.push(`# Session: ${s.title || 'Untitled'}`);
      parts.push('');
      parts.push(`*Source: \`${s.source_model || 'unknown'}\` — captured ${captured} — id \`${s.id}\`*`);
      parts.push('');
      parts.push(md);
      parts.push('');
      parts.push('---');
      parts.push('');
    }

    const filename = `contextbridge-all-${new Date().toISOString().slice(0, 10)}.md`;
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(parts.join('\n'));
  } catch (err) {
    next(err);
  }
});

// GET /context/export-all.json?user_id=...
// Server-side full export — includes structured_context (the local-storage
// popup export only has what the extension has loaded, which can be stale).
router.get('/export-all.json', async (req, res, next) => {
  try {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id query param is required' });

    const sessions = await getAllSessionsFull(user_id);
    if (!sessions.length) {
      return res.status(404).json({ error: 'No sessions to export' });
    }

    const filename = `contextbridge-all-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(JSON.stringify({
      exported_at: new Date().toISOString(),
      user_id,
      count: sessions.length,
      sessions,
    }, null, 2));
  } catch (err) {
    next(err);
  }
});

// GET /context/:id/export.md?user_id=...
// Streams a portable markdown rendering of the full session — suitable for
// drop-in upload to Claude Projects / Custom GPTs / Gemini Gems / NotebookLM.
router.get('/:id/export.md', async (req, res, next) => {
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

    const { bundle } = assembleBundle(session.structured_context, {
      maxTokens: 8000, // generous for a file export vs an inline paste
    });

    const markdown = formatForMarkdown(bundle);

    // Sanitize title to a filesystem-safe slug.
    const rawTitle = (session.title || session.structured_context?.title || 'context').toString();
    const slug = rawTitle
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 60) || 'context';

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${slug}.md"`);
    return res.send(markdown);
  } catch (err) {
    next(err);
  }
});

// GET /context/trash?user_id=...  — list soft-deleted sessions.
router.get('/trash', async (req, res, next) => {
  try {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id query param is required' });
    const sessions = await listTrashed(user_id);
    return res.json({ sessions });
  } catch (err) { next(err); }
});

// GET /context/:id/versions?user_id=...
router.get('/:id/versions', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id query param is required' });
    // user_id scoping: ensure the session belongs to this user first.
    const session = await getSession(id, user_id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const versions = await getVersions(id);
    return res.json({ versions });
  } catch (err) { next(err); }
});

// POST /context/:id/versions/:v/restore  { user_id }
// Restore a prior structured_context snapshot. Snapshots current state first
// so the restore itself can be undone.
router.post('/:id/versions/:v/restore', async (req, res, next) => {
  try {
    const { id, v } = req.params;
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });
    const session = await getSession(id, user_id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const versions = await getVersions(id);
    const target = versions.find((row) => Number(row.version_number) === Number(v));
    if (!target) return res.status(404).json({ error: 'Version not found' });

    // Snapshot current state so this restore is itself reversible.
    await saveVersion(id, session.structured_context);

    // Replace structured_context with the snapshot. updateSession only handles
    // title+folder; direct query for the JSONB write.
    const { query } = await import('../memory/postgres.js');
    await query(
      `UPDATE contexts SET structured_context = $1, updated_at = NOW()
       WHERE id = $2 AND user_id = $3`,
      [target.structured_context, id, user_id],
    );
    return res.json({ ok: true, restored_version: Number(v) });
  } catch (err) { next(err); }
});

// POST /context/:id/restore  { user_id }  — un-trash a soft-deleted session.
router.post('/:id/restore', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });
    const ok = await restoreSession(user_id, id);
    if (!ok) return res.status(404).json({ error: 'Session not found in trash' });
    return res.json({ ok: true });
  } catch (err) { next(err); }
});

// DELETE /context/:id/purge?user_id=...  — hard delete.
router.delete('/:id/purge', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id query param is required' });
    const ok = await purgeSession(user_id, id);
    if (!ok) return res.status(404).json({ error: 'Session not found' });
    return res.json({ ok: true });
  } catch (err) { next(err); }
});

// PATCH /context/:id  { user_id, title?, folder_id? }
// Rename / move. Rename is metadata-only so does NOT create a version snapshot;
// version snapshots are for structured_context changes only.
router.patch('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { user_id, title, folder_id } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });
    if (title === undefined && folder_id === undefined) {
      return res.status(400).json({ error: 'title or folder_id is required' });
    }
    const patch = {};
    if (title !== undefined) patch.title = title;
    if (folder_id !== undefined) patch.folder_id = folder_id; // null = Inbox
    const updated = await updateSession(user_id, id, patch);
    if (!updated) return res.status(404).json({ error: 'Session not found' });
    return res.json(updated);
  } catch (err) { next(err); }
});

// DELETE /context/:id?user_id=...  — soft delete.
router.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id query param is required' });
    const ok = await softDeleteSession(user_id, id);
    if (!ok) return res.status(404).json({ error: 'Session not found' });
    return res.json({ ok: true });
  } catch (err) { next(err); }
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

    return res.json({ ...session });
  } catch (err) {
    next(err);
  }
});

// POST /context/merge
router.post('/merge', async (req, res, next) => {
  try {
    const { session_ids, user_id, title } = req.body;

    if (!user_id || typeof user_id !== 'string') {
      return res.status(400).json({ error: 'user_id is required' });
    }
    if (!Array.isArray(session_ids) || session_ids.length < 2) {
      return res.status(400).json({ error: 'At least 2 session_ids are required' });
    }

    // Fetch all sessions (with user_id scoping)
    const sessions = [];
    for (const sid of session_ids) {
      const s = await getSession(sid, user_id);
      if (!s) return res.status(404).json({ error: `Session ${sid} not found` });
      sessions.push(s);
    }

    const contexts = sessions.map((s) => s.structured_context);
    const merged = mergeContexts(contexts, title);

    // Save merged session + snapshot its initial state as version 1 so future
    // edits can diff back to the pristine merge.
    const sessionId = await saveSession(user_id, 'merged', [], merged);
    await saveVersion(sessionId, merged).catch((err) => {
      console.error('[context/merge] saveVersion failed:', err.message);
    });

    const toText = (item) => (typeof item === 'string' ? item : item.text);
    const tokenCount = Math.ceil(JSON.stringify(merged).length / 4);

    console.log('[context/merge] Merged', session_ids.length, 'sessions into:', sessionId);

    return res.status(201).json({
      session_id: sessionId,
      title: merged.title,
      summary: merged.summary,
      goals: (merged.goals || []).map(toText),
      constraints: (merged.constraints || []).map(toText),
      decisions: (merged.decisions || []).map(toText),
      assumptions: (merged.assumptions || []).map(toText),
      tech_stack: (merged.tech_stack || []).map(toText),
      architecture: (merged.architecture || []).map(toText),
      open_questions: (merged.open_questions || []).map(toText),
      key_entities: (merged.key_entities || []).map(toText),
      timeline: (merged.timeline || []).map(toText),
      token_count: tokenCount,
      merged_from: session_ids,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
