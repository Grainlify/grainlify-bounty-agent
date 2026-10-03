-- Accounts erased at their owner's request (Grainlify-Backend internal/erasure).
--
-- The agent deletes what it holds about the person - wallet link, bounty
-- applications, profile snapshot, outbox events - and keeps the records of
-- payouts and draws, because the public ledger is a record of money paid and
-- is never edited silently.
--
-- This table is how both promises hold at once. The ledger rows stay exactly
-- as they were; the public API reads this table and shows "erased account"
-- wherever one of these accounts' logins would appear, and the ledger lists
-- each erasure as an event of its own, so the change to what is shown is
-- itself on the record rather than silent.
--
-- It keeps the GitHub id because that is what the retained rows are keyed by,
-- and the logins the agent knew the account by, because one older record (a
-- reopening's audit detail) names the contributor by login alone. Both are
-- already in the retained rows; this adds no new fact about the person, only
-- the instruction not to show it.
CREATE TABLE IF NOT EXISTS account_erasures (
  github_user_id  BIGINT PRIMARY KEY,
  logins          TEXT[] NOT NULL DEFAULT '{}',
  erased_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Rows removed per table, so "what did you delete" has an answer here too.
  removed         JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- What was still in flight when Grainlify's 30-day limit made the erasure
  -- go ahead anyway (erase_retaining_in_flight), and so what was kept for it.
  -- Emptied when a later pass finds nothing in flight and finishes the
  -- erasure (erasure-service.ts finishRetainedErasures).
  retained_in_flight TEXT[] NOT NULL DEFAULT '{}'
);
