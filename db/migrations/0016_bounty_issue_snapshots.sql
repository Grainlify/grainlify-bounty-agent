-- What the fit assessment is told about the issue it judges applicants for.
--
-- Every fit call used to be sent an empty issue body, no acceptance criteria
-- and no language, so the model judged people against a title alone. The
-- body comes from the GitHub issue, the criteria from the section of it that
-- states them, and the language from the repository's own primary language.
--
-- Kept per bounty for the same reasons contributor_snapshots is kept per
-- person: one fetch rather than one per application, and everybody who
-- applies for a bounty in the same week is judged against the same text - an
-- issue edited halfway through a window does not quietly change the test for
-- the people who apply after the edit.
CREATE TABLE IF NOT EXISTS bounty_issue_snapshots (
  bounty_id            UUID PRIMARY KEY REFERENCES bounties(id) ON DELETE CASCADE,
  body                 TEXT NOT NULL,
  acceptance_criteria  TEXT NOT NULL,
  primary_language     TEXT NOT NULL,
  built_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Set when part of it could not be read, so a thin snapshot is explainable.
  build_note           TEXT
);
