// Manages context version history — saves new versions and diffs against previous state.

import { query } from '../memory/postgres.js';

export async function saveVersion(sessionId, structuredContext) {
  // Get current max version number for this session.
  const result = await query(
    `SELECT COALESCE(MAX(version_number), 0) AS max_ver
     FROM context_versions
     WHERE session_id = $1`,
    [sessionId]
  );

  const nextVersion = Number(result.rows[0].max_ver) + 1;

  await query(
    `INSERT INTO context_versions (session_id, version_number, structured_context)
     VALUES ($1, $2, $3)`,
    [sessionId, nextVersion, JSON.stringify(structuredContext)]
  );

  return nextVersion;
}

export async function getVersions(sessionId) {
  const result = await query(
    `SELECT id, version_number, structured_context, diff_summary, created_at
     FROM context_versions
     WHERE session_id = $1
     ORDER BY version_number ASC`,
    [sessionId]
  );
  return result.rows;
}
