-- Admin-editable draw settings, the test-bounty marker, and the eligibility
-- rules a bounty is allowed to waive.

-- Settings an admin can change from the dashboard without a deploy.
--
-- A config FILE is the wrong home for a window length or a weight: changing
-- one means a release, and during a live programme the person who needs to
-- change it is not the person who can deploy. Defaults still live in code
-- (packages/gate/src/draw.ts and drawConfigDefaults below); a row here
-- overrides one, and deleting the row restores the default. Nothing is
-- silently inherited - the dashboard shows which values are overridden.
--
-- updated_by is the approver login, so a weight change is attributable. A
-- draw that surprises someone should be answerable with "this was the config
-- at the time, changed by this person, on this date".
CREATE TABLE bounty_config (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT NOT NULL
);

-- A bounty that exists to exercise the pipeline, not to pay for work.
--
-- is_test is shown on the public page. A test bounty that looked like a real
-- one would be worse than no test at all: contributors would apply to it.
ALTER TABLE bounties ADD COLUMN is_test BOOLEAN NOT NULL DEFAULT false;

-- Eligibility rules this bounty waives, by name, checked against a fixed
-- allowlist in code. Stored per bounty rather than as a global switch so a
-- waiver cannot leak from the test bounty to a real one, and stored as the
-- rule NAMES rather than a boolean so the page and the audit log can say
-- exactly what was relaxed.
--
-- Note what is NOT reachable from here: the payout gate. This column is read
-- only by the application-eligibility check. Nothing in it can waive
-- not_self_merged, merged_by_maintainer, the caps, or the wallet requirement,
-- because the gate never reads this column.
ALTER TABLE bounties ADD COLUMN waived_eligibility_rules TEXT[] NOT NULL DEFAULT '{}';

-- When the draw for this bounty last ran automatically, so a restarted
-- scheduler does not re-run a draw it already ran.
ALTER TABLE bounties ADD COLUMN auto_draw_ran_at TIMESTAMPTZ;

-- Which rules an applicant failed is already stored on bounty_applications
-- (gate_failure_reason). This records the opposite for the draw: the config
-- in force when it ran, so a result stays explainable after a weight changes.
ALTER TABLE bounty_draws ADD COLUMN config_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE bounty_draws ADD COLUMN triggered_by TEXT NOT NULL DEFAULT 'automatic';
