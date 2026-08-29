-- Migration 003 — session organization.
-- Adds folders + soft-delete timestamp + fixes context_versions FK cascade
-- so purging a session cleans up its version history.

BEGIN;

-- Folders: one row per user-created bucket. Sessions optionally point to one.
CREATE TABLE IF NOT EXISTS folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(255) NOT NULL,
  name VARCHAR(120) NOT NULL,
  color VARCHAR(20),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT folders_user_name_unique UNIQUE (user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_folders_user ON folders(user_id);

-- Session → folder (nullable = "Inbox").
ALTER TABLE contexts
  ADD COLUMN IF NOT EXISTS folder_id UUID
  REFERENCES folders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_contexts_folder ON contexts(folder_id);

-- Soft-delete timestamp for future auto-purge.
ALTER TABLE contexts
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Fix context_versions FK: without cascade, purging a session leaves orphans.
-- Drop-and-recreate; wrap in DO block so it's idempotent.
DO $$
DECLARE
  fk_name TEXT;
BEGIN
  SELECT conname INTO fk_name
  FROM pg_constraint
  WHERE conrelid = 'context_versions'::regclass
    AND contype = 'f'
    AND confrelid = 'contexts'::regclass;

  IF fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE context_versions DROP CONSTRAINT %I', fk_name);
  END IF;

  ALTER TABLE context_versions
    ADD CONSTRAINT context_versions_session_id_fkey
    FOREIGN KEY (session_id) REFERENCES contexts(id) ON DELETE CASCADE;
END $$;

COMMIT;
