-- Inference receipts and the cash spent on them.

CREATE TABLE IF NOT EXISTS inference_calls (
  id                    UUID PRIMARY KEY,
  purpose               TEXT NOT NULL CHECK (purpose IN ('triage','price','review','crosscheck','spike','eval')),
  phase                 TEXT NOT NULL CHECK (phase IN ('P1','P2P3','P4','LIVE')),
  model                 TEXT NOT NULL,
  path                  TEXT NOT NULL,
  links                 JSONB NOT NULL DEFAULT '{}',
  routing_requested     JSONB NOT NULL DEFAULT '{}',
  max_tokens            INTEGER NOT NULL,
  request_sha256        TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('quoting','quoted','paid','served','failed','refused_budget','refused_signer','payment_unknown','paid_not_served')),
  quote_id              TEXT UNIQUE,
  quote_cap_micro       BIGINT,
  quote_expires_at      TEXT,
  scheme                TEXT CHECK (scheme IN ('onchain','balance')),
  payer_wallet          TEXT,
  pay_tx_signature      TEXT UNIQUE,
  paid_micro            BIGINT,
  fee_micro             BIGINT,
  charged_micro         BIGINT,
  payment_response_raw  TEXT,
  payment_response      JSONB,
  response_headers      JSONB NOT NULL DEFAULT '{}',
  response_sha256       TEXT,
  usage_in              INTEGER,
  usage_out             INTEGER,
  latency_ms            INTEGER,
  error                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inference_calls_links_bounty ON inference_calls ((links->>'bountyId')) WHERE links ? 'bountyId';

-- Cash leaving the inference wallet, one row per payment or deposit.
-- 'reserved' counts reserved_micro; 'settled' counts amount + fee; 'released' counts nothing.
CREATE TABLE IF NOT EXISTS inference_spend (
  id              BIGSERIAL PRIMARY KEY,
  call_id         UUID REFERENCES inference_calls(id),
  phase           TEXT NOT NULL CHECK (phase IN ('P1','P2P3','P4','LIVE')),
  kind            TEXT NOT NULL CHECK (kind IN ('x402_payment','apikey_deposit')),
  status          TEXT NOT NULL CHECK (status IN ('reserved','settled','released')),
  reserved_micro  BIGINT NOT NULL CHECK (reserved_micro > 0),
  amount_micro    BIGINT,
  fee_micro       BIGINT,
  tx_signature    TEXT UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at      TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
