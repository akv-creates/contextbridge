-- 002_context_items.sql — item-level embeddings for Smart Slice (query-aware inject).
-- Each row is one entry from a session's structured_context (one goal, one decision, etc.)
-- with its 384-dim MiniLM embedding for per-item semantic retrieval.

CREATE TABLE IF NOT EXISTS context_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES contexts(id) ON DELETE CASCADE,
  user_id VARCHAR(255) NOT NULL,
  category TEXT NOT NULL,
  item_text TEXT NOT NULL,
  importance INT NOT NULL DEFAULT 3,
  embedding REAL[] NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_context_items_user ON context_items(user_id);
CREATE INDEX IF NOT EXISTS idx_context_items_session ON context_items(session_id);
