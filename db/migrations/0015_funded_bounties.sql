-- Maintainer-funded bounties, from creation to a disputed unassignment.
--
-- A funded bounty is a row in `bounties` with funded_by set and an escrow
-- behind it (0012_escrow.sql). Everything here is additive: the agent's own
-- bounties keep funded_by NULL and no query that reads them changes meaning.

-- 'funding': the row exists because the escrow address is derived from the
-- bounty id, but nothing has been locked yet. Never listed publicly, never
-- open for applications. It becomes 'posted' only when the chain confirms the
-- funding, so no unfunded bounty is ever visible.
ALTER TABLE bounties DROP CONSTRAINT IF EXISTS bounties_status_check;
ALTER TABLE bounties ADD CONSTRAINT bounties_status_check
  CHECK (status IN ('funding','proposed','posted','in_review','payable','paid','cancelled','expired'));

-- The funder's GitHub id, so they can be told things (a proposal to unassign,
-- a refusal) the same way a contributor is. funded_by already holds the login.
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS funded_by_github_user_id BIGINT;

-- Unassigning once a pull request is open takes both sides.
--
-- Either side proposes; the other accepts or refuses. Silence for seven days
-- counts as accepting, so somebody who walked away cannot freeze a bounty. A
-- refusal marks it disputed and changes nothing else: the escrow deadline still
-- decides, and an admin is involved only if somebody asks them to look.
CREATE TABLE IF NOT EXISTS bounty_unassign_proposals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_id       UUID NOT NULL REFERENCES bounties(id) ON DELETE CASCADE,
  assignment_id   UUID NOT NULL REFERENCES bounty_assignments(id) ON DELETE CASCADE,
  proposed_by     TEXT NOT NULL CHECK (proposed_by IN ('funder','contributor')),
  proposer_login  TEXT NOT NULL,
  -- The proposer's position, in their words. Shown to the other side and, if
  -- it comes to it, to the admin.
  reason          TEXT NOT NULL,
  respond_by      TIMESTAMPTZ NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','accepted','accepted_by_silence','refused','withdrawn','superseded')),
  responder_login TEXT,
  -- The other side's position when they refuse; required then, so the
  -- dispute view never shows one argument against a blank.
  response        TEXT,
  responded_at    TIMESTAMPTZ,
  -- Set when the agreed unassignment has actually happened, on-chain and here.
  -- In self-assign mode the funder still has to sign it in their wallet.
  carried_out_at  TIMESTAMPTZ,
  -- Arbitration, for a refused proposal only.
  arbitration     TEXT CHECK (arbitration IS NULL OR arbitration IN ('left_to_deadline','release_requested')),
  arbitrated_by   TEXT,
  arbitrated_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One open question per assignment at a time.
CREATE UNIQUE INDEX IF NOT EXISTS bounty_unassign_proposals_one_pending
  ON bounty_unassign_proposals (assignment_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS bounty_unassign_proposals_bounty ON bounty_unassign_proposals (bounty_id, created_at);

-- A note an admin records about how a funder behaved. Public on the funder's
-- profile as a count; the text is for the admin record.
CREATE TABLE IF NOT EXISTS funder_conduct_notes (
  id           BIGSERIAL PRIMARY KEY,
  funder_login TEXT NOT NULL,
  bounty_id    UUID REFERENCES bounties(id) ON DELETE SET NULL,
  note         TEXT NOT NULL,
  recorded_by  TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS funder_conduct_notes_funder ON funder_conduct_notes (lower(funder_login));

-- Whether an unassignment happened on-chain without going through Grainlify:
-- in self-assign mode the funder can sign `unassign` from their own wallet,
-- and when the agent notices it records it rather than pretending it agreed.
ALTER TABLE bounty_assignments ADD COLUMN IF NOT EXISTS unassigned_on_chain_directly BOOLEAN NOT NULL DEFAULT false;
