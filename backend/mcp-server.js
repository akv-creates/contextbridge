// ContextBridge MCP Server — exposes captured context sessions to Claude Desktop/Code.
// Run: node mcp-server.js (or npm run mcp)
// Configure in ~/.claude/mcp.json to connect from Claude Code.

import dotenv from 'dotenv';
dotenv.config({ override: true });

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getSessions, getSession } from './memory/postgres.js';
import { assembleBundle } from './engine/assembler.js';

const server = new McpServer({
  name: 'contextbridge',
  version: '1.0.0',
});

// ── Tool: list_sessions ──────────────────────────────────────────────────────

server.tool(
  'list_sessions',
  'List recently captured AI conversation context sessions. Returns session IDs, titles, source models, and timestamps.',
  {
    user_id: z.string().describe('User ID to list sessions for'),
    limit: z.number().optional().default(10).describe('Max sessions to return (default 10)'),
  },
  async ({ user_id, limit }) => {
    const { sessions } = await getSessions(user_id, limit, 0);

    const text = sessions.length === 0
      ? 'No captured sessions found.'
      : sessions.map((s, i) =>
          `${i + 1}. [${s.id}] "${s.title}" — ${s.source_model}, ${new Date(s.created_at).toLocaleString()}, ${s.goal_count} goals`
        ).join('\n');

    return {
      content: [{ type: 'text', text }],
    };
  }
);

// ── Tool: get_context ────────────────────────────────────────────────────────

server.tool(
  'get_context',
  'Retrieve full structured context from a captured AI conversation session. Returns summary, goals, constraints, decisions, tech stack, architecture, open questions, key entities, and assumptions.',
  {
    session_id: z.string().describe('Session UUID to retrieve'),
    user_id: z.string().describe('User ID that owns the session'),
  },
  async ({ session_id, user_id }) => {
    const session = await getSession(session_id, user_id);

    if (!session) {
      return {
        content: [{ type: 'text', text: `Session not found: ${session_id}` }],
        isError: true,
      };
    }

    const { bundle, tokenCount } = assembleBundle(session.structured_context);

    const result = {
      context_metadata: {
        session_id: session.id,
        title: session.title,
        source_model: session.source_model,
        captured_at: session.created_at,
        token_count: tokenCount,
        version: '1.0.0',
      },
      context: bundle,
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ── Resource: contextbridge://sessions ────────────────────────────────────────

server.resource(
  'sessions',
  'contextbridge://sessions',
  async (uri) => {
    // Default user — in MCP context, the user_id is typically set via env or config.
    const userId = process.env.MCP_USER_ID || 'default';
    const { sessions } = await getSessions(userId, 20, 0);

    const text = sessions.length === 0
      ? 'No sessions captured yet.'
      : sessions.map((s) =>
          `• ${s.title} (${s.source_model}) — ${s.id}`
        ).join('\n');

    return {
      contents: [{
        uri: uri.href,
        mimeType: 'text/plain',
        text,
      }],
    };
  }
);

// ── Start ────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[ContextBridge MCP] Server started on stdio');
}

main().catch((err) => {
  console.error('[ContextBridge MCP] Fatal error:', err);
  process.exit(1);
});
