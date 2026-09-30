-- Unassigning as a decision, rather than as a deadline lapsing.
--
-- The stale sweeper already releases assignments and records an abandon, which
-- is right when somebody went quiet. An unassignment we chose is a different
-- event with a different consequence: the contributor did nothing wrong, so
-- their record and their draw weight must come through it untouched.

-- Who is kept out of the NEXT draw on this bounty, and only that one.
--
-- The exclusion cannot live in the redraw call, because unassigning and
-- redrawing are two separate things somebody does minutes apart. It is cleared
-- by the draw that honours it, so it can never quietly apply twice.
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS exclude_login_next_draw TEXT;

-- Why an assignment ended, and who ended it. release_reason already holds the
-- text; this says whether a person decided it and which person.
ALTER TABLE bounty_assignments ADD COLUMN IF NOT EXISTS released_by TEXT;

-- Every change to a pull-request deadline, so extending one is a recorded act
-- rather than an edited row. The audit log has the same entry; this one is
-- what the contributor's own page reads.
CREATE TABLE IF NOT EXISTS bounty_deadline_changes (
  id            BIGSERIAL PRIMARY KEY,
  assignment_id UUID NOT NULL REFERENCES bounty_assignments(id) ON DELETE CASCADE,
  previous_at   TIMESTAMPTZ NOT NULL,
  new_at        TIMESTAMPTZ NOT NULL,
  reason        TEXT NOT NULL,
  changed_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bounty_deadline_changes_assignment
  ON bounty_deadline_changes (assignment_id, created_at);
