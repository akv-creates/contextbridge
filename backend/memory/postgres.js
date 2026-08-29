// PostgreSQL persistence layer — saves and retrieves context sessions with user_id scoping.

import pg from 'pg';

const { Pool } = pg;

let pool;

function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      console.error('[postgres] DATABASE_URL is not set');
      throw new Error('DATABASE_URL not configured');
    }
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    pool.on('error', (err) => {
      console.error('[postgres] Unexpected pool error:', err.message);
    });
  }
  return pool;
}

export async function query(sql, params) {
  return getPool().query(sql, params);
}

export async function testConnection() {
  try {
    await getPool().query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

export async function saveSession(userId, sourceModel, rawMessages, structuredContext, piiFlags = {}, handledLocally = false) {
  const { title, summary, goals, constraints, decisions, assumptions, tech_stack, architecture, open_questions, key_entities, timeline } = structuredContext;

  const result = await query(
    `INSERT INTO contexts (user_id, source_model, title, raw_messages, structured_context, pii_flags, handled_locally)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      userId,
      sourceModel,
      title,
      JSON.stringify(rawMessages),
      JSON.stringify({ summary, goals, constraints, decisions, assumptions, tech_stack, architecture, open_questions, key_entities, timeline }),
      JSON.stringify(piiFlags || {}),
      Boolean(handledLocally),
    ]
  );

  // Log session_id only — never log message content.
  console.log('[postgres] Saved session:', result.rows[0].id);

  return result.rows[0].id;
}

export async function getSessions(userId, limit = 20, offset = 0, opts = {}) {
  // Folder filter: pass `folderId` = a UUID for a specific folder, the string
  // 'inbox' for un-foldered sessions, or null/undefined for all folders.
  const folderId = opts.folderId;
  const params = [userId];
  let folderClause = '';
  if (folderId === 'inbox') {
    folderClause = ' AND c.folder_id IS NULL';
  } else if (folderId) {
    params.push(folderId);
    folderClause = ` AND c.folder_id = $${params.length}`;
  }
  params.push(limit, offset);

  const result = await query(
    `SELECT
       c.id,
       c.title,
       c.source_model,
       c.folder_id,
       f.name AS folder_name,
       f.color AS folder_color,
       c.created_at,
       c.updated_at,
       jsonb_array_length(c.structured_context->'goals') AS goal_count
     FROM contexts c
     LEFT JOIN folders f ON f.id = c.folder_id
     WHERE c.user_id = $1
       AND c.is_deleted = false
       ${folderClause}
     ORDER BY c.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  const countParams = [userId];
  let countFolderClause = '';
  if (folderId === 'inbox') {
    countFolderClause = ' AND folder_id IS NULL';
  } else if (folderId) {
    countParams.push(folderId);
    countFolderClause = ` AND folder_id = $${countParams.length}`;
  }
  const countResult = await query(
    `SELECT COUNT(*) AS total FROM contexts
     WHERE user_id = $1 AND is_deleted = false${countFolderClause}`,
    countParams
  );

  return {
    sessions: result.rows,
    total: Number(countResult.rows[0].total),
  };
}

// ── Folders ──────────────────────────────────────────────────────────────────

export async function createFolder(userId, name, color) {
  const result = await query(
    `INSERT INTO folders (user_id, name, color) VALUES ($1, $2, $3)
     RETURNING id, name, color, created_at`,
    [userId, String(name).trim().slice(0, 120), color || null],
  );
  return result.rows[0];
}

export async function listFolders(userId) {
  const result = await query(
    `SELECT f.id, f.name, f.color, f.created_at,
            (SELECT COUNT(*) FROM contexts c
             WHERE c.folder_id = f.id AND c.user_id = $1 AND c.is_deleted = false) AS session_count
     FROM folders f
     WHERE f.user_id = $1
     ORDER BY f.name ASC`,
    [userId],
  );
  return result.rows.map((r) => ({ ...r, session_count: Number(r.session_count) }));
}

export async function updateFolder(userId, folderId, patch) {
  const sets = [];
  const values = [];
  let p = 1;
  if (patch.name !== undefined) { sets.push(`name = $${p++}`); values.push(String(patch.name).trim().slice(0, 120)); }
  if (patch.color !== undefined) { sets.push(`color = $${p++}`); values.push(patch.color || null); }
  if (sets.length === 0) return null;
  values.push(folderId, userId);
  const result = await query(
    `UPDATE folders SET ${sets.join(', ')}
     WHERE id = $${p++} AND user_id = $${p}
     RETURNING id, name, color, created_at`,
    values,
  );
  return result.rows[0] || null;
}

export async function deleteFolder(userId, folderId) {
  // contexts.folder_id has ON DELETE SET NULL — sessions fall back to Inbox.
  const result = await query(
    `DELETE FROM folders WHERE id = $1 AND user_id = $2 RETURNING id`,
    [folderId, userId],
  );
  return result.rowCount > 0;
}

// ── Session mutations ────────────────────────────────────────────────────────

// PATCH helper: { title?, folder_id? }. folder_id === null explicitly moves
// the session to Inbox. Returns updated row or null.
export async function updateSession(userId, sessionId, patch) {
  const sets = [];
  const values = [];
  let p = 1;
  if (patch.title !== undefined) {
    sets.push(`title = $${p++}`);
    values.push(String(patch.title).trim().slice(0, 500));
  }
  if (patch.folder_id !== undefined) {
    sets.push(`folder_id = $${p++}`);
    values.push(patch.folder_id);
  }
  if (sets.length === 0) return null;
  sets.push(`updated_at = NOW()`);
  values.push(sessionId, userId);
  const result = await query(
    `UPDATE contexts SET ${sets.join(', ')}
     WHERE id = $${p++} AND user_id = $${p} AND is_deleted = false
     RETURNING id, title, source_model, folder_id, structured_context, created_at, updated_at`,
    values,
  );
  return result.rows[0] || null;
}

export async function softDeleteSession(userId, sessionId) {
  const result = await query(
    `UPDATE contexts SET is_deleted = true, deleted_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND is_deleted = false
     RETURNING id`,
    [sessionId, userId],
  );
  return result.rowCount > 0;
}

export async function restoreSession(userId, sessionId) {
  const result = await query(
    `UPDATE contexts SET is_deleted = false, deleted_at = NULL, updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND is_deleted = true
     RETURNING id`,
    [sessionId, userId],
  );
  return result.rowCount > 0;
}

// Hard delete — context_items cascade via FK; context_versions cascade added
// in migration 004. Idempotent.
export async function purgeSession(userId, sessionId) {
  const result = await query(
    `DELETE FROM contexts WHERE id = $1 AND user_id = $2 RETURNING id`,
    [sessionId, userId],
  );
  return result.rowCount > 0;
}

export async function listTrashed(userId) {
  const result = await query(
    `SELECT id, title, source_model, deleted_at, created_at
     FROM contexts
     WHERE user_id = $1 AND is_deleted = true
     ORDER BY deleted_at DESC NULLS LAST`,
    [userId],
  );
  return result.rows;
}

export async function getSession(sessionId, userId) {
  const result = await query(
    `SELECT id, title, source_model, structured_context, created_at
     FROM contexts
     WHERE id = $1
       AND user_id = $2
       AND is_deleted = false`,
    [sessionId, userId]
  );
  return result.rows[0] || null;
}

// ── Smart Slice: item-level embeddings ───────────────────────────────────────

// Bulk-insert context_items rows. items: [{category, item_text, importance, embedding}]
// embedding is a plain number[] of length 384.
export async function saveContextItems(userId, sessionId, items) {
  if (!items || items.length === 0) return;

  // Batch into a single parameterized INSERT — all rows for one session.
  const values = [];
  const placeholders = [];
  let p = 1;
  for (const it of items) {
    placeholders.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
    values.push(
      sessionId,
      userId,
      it.category,
      it.item_text,
      Number.isInteger(it.importance) ? it.importance : 3,
      it.embedding,
    );
  }

  await query(
    `INSERT INTO context_items (session_id, user_id, category, item_text, importance, embedding)
     VALUES ${placeholders.join(', ')}`,
    values,
  );
  console.log('[postgres] Saved', items.length, 'context_items for session:', sessionId);
}

// Return every item for a user, joined with session title. Used by the slicer
// to rank across all sessions. Returns [] if no items yet.
export async function getContextItemsForUser(userId) {
  const result = await query(
    `SELECT ci.id,
            ci.session_id,
            ci.category,
            ci.item_text,
            ci.importance,
            ci.embedding,
            c.title AS session_title,
            c.source_model AS source_model
     FROM context_items ci
     JOIN contexts c ON c.id = ci.session_id
     WHERE ci.user_id = $1
       AND c.is_deleted = false`,
    [userId],
  );
  return result.rows;
}

// Keyword filter helper — returns items whose item_text matches any of the
// supplied tokens (ILIKE). Used alongside semantic retrieval to catch vocab
// mismatches the embedding misses.
export async function searchContextItemsByKeywords(userId, tokens) {
  if (!tokens || tokens.length === 0) return [];
  const likes = tokens.map((_, i) => `ci.item_text ILIKE $${i + 2}`);
  const params = [userId, ...tokens.map((t) => `%${t}%`)];
  const result = await query(
    `SELECT ci.id,
            ci.session_id,
            ci.category,
            ci.item_text,
            ci.importance,
            ci.embedding,
            c.title AS session_title,
            c.source_model AS source_model
     FROM context_items ci
     JOIN contexts c ON c.id = ci.session_id
     WHERE ci.user_id = $1
       AND c.is_deleted = false
       AND (${likes.join(' OR ')})
     LIMIT 100`,
    params,
  );
  return result.rows;
}

// Full export — every non-deleted session with its structured_context.
// Used by the bulk .md / .json export routes.
export async function getAllSessionsFull(userId) {
  const result = await query(
    `SELECT id, title, source_model, structured_context, created_at
     FROM contexts
     WHERE user_id = $1
       AND is_deleted = false
     ORDER BY created_at DESC`,
    [userId]
  );
  return result.rows;
}

// ── Telemetry (anonymous, aggregate-only — never message content) ───────────

const ALLOWED_EVENT_TYPES = new Set([
  'install', 'capture_success', 'inject_success', 'slice_run',
  'popup_open', 'w1_active', 'w2_retained', 'paywall_view', 'paywall_click',
]);

export async function recordEvent(userId, eventType, metadata) {
  if (!ALLOWED_EVENT_TYPES.has(eventType)) return null;
  const result = await query(
    `INSERT INTO events (user_id, event_type, metadata) VALUES ($1, $2, $3)
     RETURNING id, created_at`,
    [userId, eventType, JSON.stringify(metadata || {})],
  );
  return result.rows[0];
}

export async function joinWaitlist(userId, email, source) {
  const result = await query(
    `INSERT INTO pro_waitlist (user_id, email, source) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email, source = EXCLUDED.source
     RETURNING id, created_at`,
    [userId, email || null, source || null],
  );
  return result.rows[0];
}
