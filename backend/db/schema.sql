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
