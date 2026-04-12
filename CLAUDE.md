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
ContextBridge exposes an MCP server (`backend/mcp-server.js`) for Claude Desktop/Code.
- Run: `npm run mcp` (or `node mcp-server.js`)
- Tools: `list_sessions` (list recent captures), `get_context` (retrieve full structured context)
- Resource: `contextbridge://sessions` (browsable session list)
- Configure in `~/.claude/mcp.json`:
  ```json
  {
    "mcpServers": {
      "contextbridge": {
        "command": "node",
        "args": ["/absolute/path/to/contextbridge/backend/mcp-server.js"]
      }
    }
  }
  ```

## Folder structure
See PRD Section 5.1 / Appendix 10 for canonical structure.

## Inject formats
- `format: "prompt"` — formatted text via adapter (default)
- `format: "json"` — structured JSON with metadata wrapper
- Popup offers: Inject Now, Copy JSON, Download JSON

## Current sprint
S2 — Enhanced context extraction (9 categories), JSON export, MCP server
