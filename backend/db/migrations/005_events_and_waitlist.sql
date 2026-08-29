-- Migration 005 — product telemetry for the consumer-demand experiment.
-- Anonymous, aggregate-only: no message content, no raw context ever lands
-- here. event_type + small metadata only.

BEGIN;

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

-- Pro-tier fake-door waitlist. Email is the only PII we ever willingly
-- collect, and only when the user types it in themselves to join.
CREATE TABLE IF NOT EXISTS pro_waitlist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(255) NOT NULL,
  email VARCHAR(320),
  source VARCHAR(60),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pro_waitlist_user_unique UNIQUE (user_id)
);

COMMIT;
