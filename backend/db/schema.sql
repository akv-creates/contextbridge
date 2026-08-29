-- Database schema for ContextBridge — defines tables for sessions and version history.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS contexts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(255) NOT NULL,
  source_model VARCHAR(50) NOT NULL,
  title VARCHAR(500) NOT NULL,
  raw_messages JSONB NOT NULL,
  structured_context JSONB NOT NULL,
  embedding_id VARCHAR(100),
  is_deleted BOOLEAN NOT NULL DEFAULT false,
  pii_flags JSONB DEFAULT '{}'::jsonb,
  handled_locally BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS context_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES contexts(id),
  version_number INTEGER NOT NULL,
  structured_context JSONB NOT NULL,
  diff_summary JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contexts_user_id ON contexts(user_id);
CREATE INDEX IF NOT EXISTS idx_contexts_created_at ON contexts(created_at DESC);

-- Item-level embeddings for Smart Slice (migration 002). One row per entry across
-- the 9 array categories in structured_context.
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

-- Local privacy/cost gate audit columns (migration 003). pii_flags is a count
-- per PII category found by the local Ollama gate; the redaction map itself
-- (token -> original) is never persisted.

-- Session organization (migration 004): folders, soft-delete timestamp,
-- versions cascade on parent purge.
CREATE TABLE IF NOT EXISTS folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(255) NOT NULL,
  name VARCHAR(120) NOT NULL,
  color VARCHAR(20),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT folders_user_name_unique UNIQUE (user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_folders_user ON folders(user_id);

ALTER TABLE contexts
  ADD COLUMN IF NOT EXISTS folder_id UUID
  REFERENCES folders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_contexts_folder ON contexts(folder_id);

ALTER TABLE contexts
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Product telemetry (migration 005): anonymous event log + Pro waitlist.
CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(255) NOT NULL,
  event_type VARCHAR(60) NOT NULL,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);

CREATE TABLE IF NOT EXISTS pro_waitlist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(255) NOT NULL,
  email VARCHAR(320),
  source VARCHAR(60),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pro_waitlist_user_unique UNIQUE (user_id)
);
