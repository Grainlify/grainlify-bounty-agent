-- Which repositories may have bounties, and who decided.

-- Two separate facts, deliberately not one.
--
-- registered_project is Grainlify's: the repo belongs to a verified project
-- with our GitHub App installed. This agent cannot determine that - it has no
-- projects table and should not grow one - so the backend asserts it in the
-- signed admin message that sets it.
--
-- bounties_enabled is an admin's: this project has been switched on for
-- bounties. Both must hold. Keeping them apart means turning bounties on for
-- something that is not a registered project is impossible rather than merely
-- discouraged, and it means a project losing its verification takes its
-- bounties with it without anybody remembering to flip a second switch.
ALTER TABLE repos ADD COLUMN bounties_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE repos ADD COLUMN registered_project BOOLEAN NOT NULL DEFAULT false;

-- Who changed what, and when. An operational switch with no trail is one
-- nobody can answer questions about later: "why did this repo stop paying"
-- should not require reading a deploy history.
CREATE TABLE repo_bounty_audit (
  id                 BIGSERIAL PRIMARY KEY,
  repo_id            BIGINT REFERENCES repos(id) ON DELETE SET NULL,
  full_name          TEXT NOT NULL,
  bounties_enabled   BOOLEAN NOT NULL,
  registered_project BOOLEAN NOT NULL,
  changed_by         TEXT NOT NULL,
  changed_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX repo_bounty_audit_repo ON repo_bounty_audit (full_name, changed_at DESC);

-- The sandbox is already allowlisted and already carries the test bounty; it
-- is not a verified project and never will be. Marking it enabled here rather
-- than special-casing it at read time keeps the rule one expression.
UPDATE repos SET bounties_enabled = true
 WHERE lower(owner) = 'grainlify' AND lower(name) = 'grainlify-agent-sandbox';
