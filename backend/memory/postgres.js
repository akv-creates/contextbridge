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

export async function saveSession(userId, sourceModel, rawMessages, structuredContext) {
  const { title, summary, goals, constraints, decisions, assumptions, tech_stack, architecture, open_questions, key_entities, timeline } = structuredContext;

  const result = await query(
    `INSERT INTO contexts (user_id, source_model, title, raw_messages, structured_context)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [
      userId,
      sourceModel,
      title,
      JSON.stringify(rawMessages),
      JSON.stringify({ summary, goals, constraints, decisions, assumptions, tech_stack, architecture, open_questions, key_entities, timeline }),
    ]
  );

  // Log session_id only — never log message content.
  console.log('[postgres] Saved session:', result.rows[0].id);

  return result.rows[0].id;
}

export async function getSessions(userId, limit = 20, offset = 0) {
  const result = await query(
    `SELECT
       id,
       title,
       source_model,
       created_at,
       jsonb_array_length(structured_context->'goals') AS goal_count
     FROM contexts
     WHERE user_id = $1
       AND is_deleted = false
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );

  const countResult = await query(
    `SELECT COUNT(*) AS total FROM contexts WHERE user_id = $1 AND is_deleted = false`,
    [userId]
  );

  return {
    sessions: result.rows,
    total: Number(countResult.rows[0].total),
  };
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
