-- Things that happened to a contributor, waiting to be told to them.
--
-- An outbox rather than an HTTP call at the moment of the event, for two
-- reasons that both come from the requirement that a re-run must not send
-- duplicates.
--
-- Idempotency is structural here. dedupe_key is unique, so "you won bounty X"
-- can be enqueued a hundred times by a hundred re-runs of the draw and exists
-- once. Getting that from retry logic instead would mean every emitter
-- reimplementing it, and the one that forgot would be discovered by a
-- contributor receiving the same email six times.
--
-- And delivery can fail. The backend owns notifications and can be down or
-- mid-deploy; a draw must not fail because of that, and a notification must
-- not be lost because of it either. The row survives, the sender retries.
CREATE TABLE bounty_events (
  id           BIGSERIAL PRIMARY KEY,
  kind         TEXT NOT NULL,
  -- Who it is about. Resolved to a Grainlify user by the backend, which owns
  -- that mapping; this service knows people by their GitHub id.
  github_user_id BIGINT NOT NULL,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- What makes this event THIS event. Two draws of the same bounty produce
  -- the same key and therefore one row.
  dedupe_key   TEXT NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ,
  attempts     INT NOT NULL DEFAULT 0,
  last_error   TEXT
);
CREATE INDEX bounty_events_undelivered ON bounty_events (created_at) WHERE delivered_at IS NULL;
