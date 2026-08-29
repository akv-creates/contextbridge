// ContextBridge MCP Server — exposes captured context sessions to Claude Desktop/Code.
// Run: node mcp-server.js (or npm run mcp)
// Configure in ~/.claude/mcp.json to connect from Claude Code.

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Resolve .env relative to this file, not the CWD (Claude Desktop/Code spawns us from its own dir).
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env'), override: true });

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getSessions, getSession, saveSession } from './memory/postgres.js';
import { assembleBundle } from './engine/assembler.js';
import { structureContext } from './engine/structurer.js';
import { saveEmbedding } from './memory/faiss.js';

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

// ── Tool: save_context (structured fields — no Groq call) ───────────────────

server.tool(
  'save_context',
  'Save the current conversation context to ContextBridge using already-structured fields. Use this to persist important context (goals, decisions, tech stack, constraints, etc.) from the conversation so it can be retrieved later or in another chat. Prefer this over save_raw_messages when you can summarize the conversation yourself — it is faster and skips a second LLM pass.',
  {
    title: z.string().optional().describe('Short session title (e.g., "Building chat app backend"). Auto-generated from summary if omitted.'),
    summary: z.string().optional().describe('1-3 sentence summary of the conversation'),
    goals: z.array(z.string()).optional().describe('User goals / what they are trying to accomplish'),
    constraints: z.array(z.string()).optional().describe('Constraints: budget, timeline, team size, non-negotiables'),
    decisions: z.array(z.string()).optional().describe('Decisions made during the conversation (ideally "WHAT — WHY")'),
    assumptions: z.array(z.string()).optional().describe('Assumptions being made that were not explicitly confirmed'),
    tech_stack: z.array(z.string()).optional().describe('Technologies / libraries / frameworks confirmed for use'),
    architecture: z.array(z.string()).optional().describe('Architectural decisions and system structure'),
    open_questions: z.array(z.string()).optional().describe('Unresolved questions requiring an answer'),
    key_entities: z.array(z.string()).optional().describe('People, teams, external systems, products, domain concepts (NOT technologies)'),
    timeline: z.array(z.string()).optional().describe('Dates, deadlines, milestones'),
  },
  async (args) => {
    try {
      const userId = process.env.MCP_USER_ID || 'default';

      const wrap = (arr) => (arr || []).filter(Boolean).map((text) => ({ text, importance: 3 }));

      const summary = args.summary || '';
      const title = args.title
        || (summary ? summary.split(/[.!?]/)[0].slice(0, 80) : 'Saved from Claude MCP');

      const structured = {
        title,
        summary,
        goals: wrap(args.goals),
        constraints: wrap(args.constraints),
        decisions: wrap(args.decisions),
        assumptions: wrap(args.assumptions),
        tech_stack: wrap(args.tech_stack),
        architecture: wrap(args.architecture),
        open_questions: wrap(args.open_questions),
        key_entities: wrap(args.key_entities),
        timeline: wrap(args.timeline),
      };

      const sessionId = await saveSession(userId, 'claude-mcp', [], structured);

      // Non-blocking embedding
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
        ...structured.timeline.map(toText),
      ].filter(Boolean).join(' ');
      if (embeddingText.trim()) {
        saveEmbedding(sessionId, embeddingText).catch((err) => {
          console.error('[mcp:save_context] Embedding failed for session:', sessionId, err.message);
        });
      }

      const counts = [
        structured.goals.length && `${structured.goals.length} goals`,
        structured.decisions.length && `${structured.decisions.length} decisions`,
        structured.tech_stack.length && `${structured.tech_stack.length} tech`,
        structured.constraints.length && `${structured.constraints.length} constraints`,
      ].filter(Boolean).join(', ');

      return {
        content: [{
          type: 'text',
          text: `Saved session ${sessionId} — "${title}"` + (counts ? ` (${counts})` : ''),
        }],
      };
    } catch (err) {
      console.error('[mcp:save_context] Error:', err.message);
      return {
        content: [{ type: 'text', text: `Failed to save context: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ── Tool: save_raw_messages (pipeline — runs Groq structurer) ───────────────

server.tool(
  'save_raw_messages',
  'Save a conversation to ContextBridge by passing raw {role, content} messages. The backend will run its structuring pipeline to extract goals, decisions, tech stack, etc. Use this when you want the same extraction quality as the Chrome extension, or when you are not confident in your own structuring.',
  {
    messages: z.array(z.object({
      role: z.string().describe('"user" or "assistant"'),
      content: z.string().describe('Message text'),
    })).min(1).describe('Array of conversation messages in order'),
    source_model: z.string().optional().default('claude-mcp').describe('Source model label (default "claude-mcp")'),
  },
  async ({ messages, source_model }) => {
    try {
      const userId = process.env.MCP_USER_ID || 'default';

      const structured = await structureContext(messages);
      const sessionId = await saveSession(userId, source_model, messages, structured);

      // Non-blocking embedding
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
        ...structured.timeline.map(toText),
      ].filter(Boolean).join(' ');
      if (embeddingText.trim()) {
        saveEmbedding(sessionId, embeddingText).catch((err) => {
          console.error('[mcp:save_raw_messages] Embedding failed for session:', sessionId, err.message);
        });
      }

      const counts = [
        structured.goals.length && `${structured.goals.length} goals`,
        structured.decisions.length && `${structured.decisions.length} decisions`,
        structured.tech_stack.length && `${structured.tech_stack.length} tech`,
      ].filter(Boolean).join(', ');

      return {
        content: [{
          type: 'text',
          text: `Saved session ${sessionId} — "${structured.title}"` + (counts ? ` (${counts})` : ''),
        }],
      };
    } catch (err) {
      console.error('[mcp:save_raw_messages] Error:', err.message);
      return {
        content: [{ type: 'text', text: `Failed to save messages: ${err.message}` }],
        isError: true,
      };
    }
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