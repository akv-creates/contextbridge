# ContextBridge — CLAUDE.md

## Project purpose
Browser extension + Node.js middleware that captures AI conversation context and transfers it between models (ChatGPT ↔ Claude ↔ Ollama).

## Stack
- Extension: Chrome Manifest V3, Vanilla JS
- Backend: Node.js 20, Express 4
- DB: PostgreSQL 16 (JSONB), FAISS (faiss-node)
- LLM: Groq (llama-3.3-70b-versatile) for structuring
- Embeddings: @xenova/transformers (all-MiniLM-L6-v2, 384-dim local)
- MCP: @modelcontextprotocol/sdk for Claude Desktop/Code integration

## Key rules
- Business logic lives in engine/ and adapters/ only. Routes are thin.
- Each adapter is a pure function: (contextBundle) => string
- Never log raw message content. Log session IDs only.
- All DB queries must include WHERE user_id = $1.
- Raw unredacted messages must never reach `structureContext()` (Groq) — they always pass through `localGate()` (engine/local-gate.js) first.

## Local privacy/cost gate (engine/local-gate.js)
Runs before the Groq structurer on every `/context/capture` request, using a local Ollama model:
- **PII redaction**: detects emails, phone numbers, API keys, names, addresses, financial/health info and replaces them with placeholder tokens (`[EMAIL_1]`, etc.) before anything is sent to Groq. The token→original map is kept in-process only and never persisted.
- **Triviality short-circuit**: trivial captures (short, no real decisions/architecture) are summarized locally and skip the Groq call entirely (`handled_locally: true`), saving API credits.
- **Fail-safe**: if Ollama is unreachable, `OLLAMA_FALLBACK_MODE=block` (default) rejects the capture with a 503 rather than sending unredacted content to the cloud. `OLLAMA_FALLBACK_MODE=warn` bypasses redaction and logs a warning (dev only).
- Env vars: `OLLAMA_BASE_URL`, `OLLAMA_MODEL` (default `llama3.2:3b`), `OLLAMA_FALLBACK_MODE`.
- Audit columns on `contexts`: `pii_flags` (counts per category), `handled_locally` (boolean).

## API contract (PRD §5.3)
- POST /context/capture — scrape + structure + save
- POST /context/inject — retrieve + format for target model
- GET /context/sessions?user_id= — paginated list
- GET /context/:id?user_id= — full session
- GET /health — { status, version, db }

## Structured context shape (after ENG-02 scoring)
9 categories: summary (string), goals, constraints, decisions, assumptions, tech_stack, architecture, open_questions, key_entities (arrays of { text: string, importance: 1-5 }).
Adapters receive plain string arrays (assembler strips importance before formatting).

## Adapters
- adapters/claude.js → XML tags (<goals>, <constraints>, <decisions>, <tech_stack>, etc.)
- adapters/gpt.js → dash section headers (--- Goals ---)
- adapters/ollama.js → minimal CAPS headers
- adapters/gemini.js → returns JSON string of contents[] array

## MCP Server
ContextBridge exposes an MCP server (`backend/mcp-server.js`) for Claude Desktop/Code — no paste or extension needed for these clients.
- Run: `npm run mcp` (or `node mcp-server.js`)
- **Read tools:**
  - `list_sessions` — list recent captures
  - `get_context` — retrieve full structured context by session_id
- **Write tools (save without paste):**
  - `save_context` — save a conversation by passing structured fields (title, summary, goals, decisions, tech_stack, constraints, assumptions, architecture, open_questions, key_entities, timeline). Fast — no Groq call; Claude does the structuring.
  - `save_raw_messages` — save a conversation by passing `{role, content}[]` messages. Runs the full Groq structurer pipeline (same as the Chrome extension).
- Resource: `contextbridge://sessions` (browsable session list)
- Configure in `~/.claude/mcp.json`. Set `MCP_USER_ID` to the same UUID the extension uses (found in `chrome.storage.local` → `userId`) so MCP-saved sessions show up in the popup:
  ```json
  {
    "mcpServers": {
      "contextbridge": {
        "command": "node",
        "args": ["/absolute/path/to/contextbridge/backend/mcp-server.js"],
        "env": { "MCP_USER_ID": "your-uuid-here" }
      }
    }
  }
  ```
- **Example prompts in Claude Desktop / Claude Code:**
  - *"Save this context to contextbridge"* → Claude calls `save_context` with structured fields
  - *"Save the raw messages of this conversation"* → Claude calls `save_raw_messages`
  - *"List my saved contextbridge sessions"* → `list_sessions`
  - *"Load context from session abc-123"* → `get_context`

## Folder structure
See PRD Section 5.1 / Appendix 10 for canonical structure.

## Inject formats
- `format: "prompt"` — formatted text via adapter (default)
- `format: "json"` — structured JSON with metadata wrapper
- Popup offers: Inject Now, Copy JSON, Download JSON

## Current sprint
S2 — Enhanced context extraction (9 categories), JSON export, MCP server
