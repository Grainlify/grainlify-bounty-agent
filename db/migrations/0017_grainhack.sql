-- GrainHack payouts (drafts/grainhack-payout-contract.md §3).
--
-- A results statement comes from Grainlify-Backend, signed; it is stored here
-- byte for byte and never changed. Each line becomes one row in
-- grainhack_payouts: one row per winner per event pool, ever. A superseding
-- statement moves unpaid rows onto itself; a row that has been sent to the
-- signer keeps the statement it was approved under.

CREATE TABLE grainhack_statements (
  statement_id      UUID PRIMARY KEY,
  supersedes        UUID,
  -- Set once, when a later statement for the same event pool is imported.
  superseded_by     UUID,
  hackathon_id      UUID NOT NULL,
  hackathon_name    TEXT NOT NULL,
  pool              TEXT NOT NULL,
  computation_id    UUID NOT NULL,
  currency          TEXT NOT NULL,
  network           TEXT NOT NULL,
  pool_minor        NUMERIC(40,0) NOT NULL CHECK (pool_minor >= 0),
  -- The exact signed bytes and the backend's signature over them.
  statement_json    TEXT NOT NULL,
  signature         TEXT NOT NULL,
  statement_sha256  TEXT NOT NULL UNIQUE,
  issued_at         TIMESTAMPTZ NOT NULL,
  imported_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  imported_by       TEXT NOT NULL
);
CREATE INDEX grainhack_statements_event ON grainhack_statements (hackathon_id, pool, imported_at);
-- At most one current statement per event pool.
CREATE UNIQUE INDEX grainhack_statements_one_current ON grainhack_statements (hackathon_id, pool) WHERE superseded_by IS NULL;

-- The statement itself is immutable; only superseded_by may be set, once.
CREATE FUNCTION grainhack_statements_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'grainhack statements are never deleted';
  END IF;
  IF OLD.superseded_by IS NOT NULL OR NEW.superseded_by IS NULL
     OR (to_jsonb(NEW) - 'superseded_by') <> (to_jsonb(OLD) - 'superseded_by') THEN
    RAISE EXCEPTION 'grainhack statements are immutable once imported (only superseded_by may be set, once)';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER grainhack_statements_immutable BEFORE UPDATE OR DELETE ON grainhack_statements
  FOR EACH ROW EXECUTE FUNCTION grainhack_statements_immutable();

CREATE TABLE grainhack_payouts (
  id               UUID PRIMARY KEY,
  hackathon_id     UUID NOT NULL,
  pool             TEXT NOT NULL,
  github_user_id   BIGINT NOT NULL,
  login            TEXT NOT NULL,
  statement_id     UUID NOT NULL REFERENCES grainhack_statements(statement_id),
  amount_minor     NUMERIC(40,0) NOT NULL CHECK (amount_minor > 0),
  currency         TEXT NOT NULL,
  mint             TEXT NOT NULL,
  network          TEXT NOT NULL,
  -- Frozen from wallet_links when the row becomes awaiting_approval.
  recipient        TEXT,
  status           TEXT NOT NULL CHECK (status IN (
                     'held_kyc',          -- the statement holds this winner for KYC
                     'awaiting_wallet',   -- payable, but no live Solana wallet link
                     'awaiting_approval', -- payable, recipient frozen, waiting for a person
                     'submitted',         -- approval forwarded to the grainhack-signer
                     'paid',              -- the signer confirmed the transfer
                     'unknown',           -- the signer could not confirm; a person resolves it there
                     'failed',            -- the signer resolved it as never sent; not retried here
                     'removed')),         -- a superseding statement no longer lists this winner
  approval         JSONB,
  approved_by      TEXT,
  approved_at      TIMESTAMPTZ,
  tx_signature     TEXT UNIQUE,
  paid_at          TIMESTAMPTZ,
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (hackathon_id, pool, github_user_id),
  CHECK (status NOT IN ('awaiting_approval','submitted','paid','unknown') OR recipient IS NOT NULL),
  CHECK (status <> 'paid' OR tx_signature IS NOT NULL)
);
CREATE INDEX grainhack_payouts_event ON grainhack_payouts (hackathon_id, pool);

-- The public GrainHack ledger: pool deposits and payouts, appended, never
-- edited. A mistake is corrected by a new row that says so, not by changing
-- the old one.
CREATE TABLE grainhack_ledger (
  id                BIGSERIAL PRIMARY KEY,
  kind              TEXT NOT NULL CHECK (kind IN ('grainhack_pool_funded','grainhack_payout')),
  hackathon_id      UUID NOT NULL,
  hackathon_name    TEXT,
  pool              TEXT NOT NULL DEFAULT 'contributor',
  network           TEXT NOT NULL,
  currency          TEXT NOT NULL,
  decimals          INT NOT NULL,
  amount_minor      NUMERIC(40,0) NOT NULL CHECK (amount_minor > 0),
  tx_signature      TEXT NOT NULL,
  -- A payout: who was paid. A deposit: null.
  login             TEXT,
  github_user_id    BIGINT,
  payout_id         UUID UNIQUE,
  -- Rows carried over from before this path existed (event 1's KeeperHub
  -- legs on Base Sepolia). Shown as testnet history, never as a payout made here.
  is_history        BOOLEAN NOT NULL DEFAULT false,
  note              TEXT,
  recorded_by       TEXT NOT NULL,
  at                TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (network, tx_signature, kind)
);
CREATE INDEX grainhack_ledger_event ON grainhack_ledger (hackathon_id);

CREATE FUNCTION grainhack_ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'the GrainHack ledger is append-only: rows are never edited or deleted';
END $$;
CREATE TRIGGER grainhack_ledger_append_only BEFORE UPDATE OR DELETE ON grainhack_ledger
  FOR EACH ROW EXECUTE FUNCTION grainhack_ledger_append_only();

-- What the backend is told about GrainHack payouts, so it can notify winners.
-- An outbox like bounty_events, with its own endpoint and token.
CREATE TABLE grainhack_reports (
  id            BIGSERIAL PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('grainhack_paid','grainhack_link_wallet')),
  github_user_id BIGINT NOT NULL,
  payload       JSONB NOT NULL,
  dedupe_key    TEXT NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at  TIMESTAMPTZ,
  attempts      INT NOT NULL DEFAULT 0,
  last_error    TEXT
);
CREATE INDEX grainhack_reports_undelivered ON grainhack_reports (created_at) WHERE delivered_at IS NULL;
