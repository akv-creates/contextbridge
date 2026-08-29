-- 003_pii_gate.sql — audit columns for the local Ollama privacy/cost gate.
-- redaction_map (token -> original PII) is intentionally NOT persisted here;
-- only counts per category and whether the cloud structurer was skipped.

ALTER TABLE contexts ADD COLUMN IF NOT EXISTS pii_flags JSONB DEFAULT '{}'::jsonb;
ALTER TABLE contexts ADD COLUMN IF NOT EXISTS handled_locally BOOLEAN NOT NULL DEFAULT false;
