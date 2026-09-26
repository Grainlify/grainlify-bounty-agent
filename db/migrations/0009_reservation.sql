-- Newcomer reservation, AI-specs.md §3.8.
--
-- "Reserved status is assigned at issue publication, not at draw time, so it
-- cannot be steered by who happens to apply."
--
-- That sentence is the whole design. Deciding at draw time would mean the
-- reservation could be switched on once the pool is visible, which turns a
-- protection for newcomers into a lever. A column set when the bounty is
-- created cannot be steered, because at that moment nobody has applied.
ALTER TABLE bounties ADD COLUMN reserved_for_newcomers BOOLEAN NOT NULL DEFAULT false;
