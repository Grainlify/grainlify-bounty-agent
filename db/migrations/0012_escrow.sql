-- Maintainer-funded bounties, held in an on-chain escrow.
--
-- The money never passes through Grainlify: these rows are a mirror of what the
-- escrow program holds, kept so the product can show state without reading the
-- chain on every page load. The chain is the truth; this table is the index.

CREATE TABLE bounty_escrows (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_id        UUID NOT NULL UNIQUE REFERENCES bounties(id) ON DELETE CASCADE,

  -- On-chain identities. escrow_pubkey is the PDA; the vault is its token
  -- account. Both are derivable from bounty_id, and stored anyway so a row can
  -- be matched to a transaction without re-deriving.
  escrow_pubkey    TEXT NOT NULL UNIQUE,
  vault_pubkey     TEXT NOT NULL,
  funder_wallet    TEXT NOT NULL,
  contributor_wallet TEXT,

  mint             TEXT NOT NULL,
  currency         TEXT NOT NULL,
  network          TEXT NOT NULL,

  -- What the contributor receives, and the fee charged ON TOP of it. Both are
  -- what the escrow itself recorded at funding: a fee that could be recomputed
  -- later would not be the fee that was quoted.
  amount_minor     NUMERIC(40,0) NOT NULL CHECK (amount_minor > 0),
  fee_bps          INT NOT NULL CHECK (fee_bps >= 0 AND fee_bps <= 1000),
  fee_minimum_minor NUMERIC(40,0) NOT NULL DEFAULT 0,
  fee_amount_minor NUMERIC(40,0) NOT NULL CHECK (fee_amount_minor >= 0),

  assignment_mode  TEXT NOT NULL CHECK (assignment_mode IN ('draw','self_assign')),
  state            TEXT NOT NULL CHECK (state IN ('funding','funded','assigned','released','refunded','failed')),

  deadline_at      TIMESTAMPTZ NOT NULL,
  merge_commit     TEXT,

  -- One signature per transition, so the ledger can link a state to the
  -- transaction that caused it rather than asserting it happened.
  fund_tx          TEXT,
  assign_tx        TEXT,
  release_tx       TEXT,
  refund_tx        TEXT,

  created_by       TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error       TEXT
);

CREATE INDEX bounty_escrows_state ON bounty_escrows (state);
CREATE INDEX bounty_escrows_deadline ON bounty_escrows (deadline_at) WHERE state IN ('funded','assigned');

-- Every transition, appended. The mirror above can be rebuilt from this and
-- the chain; this is what an admin screen shows when asked "what happened".
CREATE TABLE bounty_escrow_events (
  id         BIGSERIAL PRIMARY KEY,
  escrow_id  UUID NOT NULL REFERENCES bounty_escrows(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  tx         TEXT,
  detail     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX bounty_escrow_events_escrow ON bounty_escrow_events (escrow_id, created_at);

-- A funded bounty is one with an escrow behind it. The agent's own bounties
-- keep funded_by NULL, so nothing about the existing flow changes.
ALTER TABLE bounties ADD COLUMN IF NOT EXISTS funded_by TEXT;
