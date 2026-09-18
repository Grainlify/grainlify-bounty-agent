-- The bounty loop: repos on the allowlist, contributors and their wallets,
-- bounties, the PRs that claim them, advisory reviews, and payouts.

CREATE TABLE repos (
  id               BIGSERIAL PRIMARY KEY,
  owner            TEXT NOT NULL,
  name             TEXT NOT NULL,
  installation_id  BIGINT,
  enabled          BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner, name)
);

-- GitHub delivery ids we have processed. Dedupe gates processing, not just storage.
CREATE TABLE webhook_deliveries (
  delivery_id   TEXT PRIMARY KEY,
  event         TEXT NOT NULL,
  action        TEXT,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at  TIMESTAMPTZ,
  error         TEXT
);

CREATE TABLE contributors (
  github_user_id      BIGINT PRIMARY KEY,
  login               TEXT NOT NULL,
  account_created_at  TIMESTAMPTZ,
  is_bot              BOOLEAN NOT NULL DEFAULT false,
  first_seen          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One live wallet per GitHub account, and one live account per wallet.
CREATE TABLE wallet_links (
  id              BIGSERIAL PRIMARY KEY,
  github_user_id  BIGINT NOT NULL REFERENCES contributors(github_user_id),
  address         TEXT NOT NULL,
  message         TEXT NOT NULL,
  signature       TEXT NOT NULL,
  source          TEXT NOT NULL,            -- e.g. comment URL that proved the GitHub identity
  verified_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at      TIMESTAMPTZ
);
CREATE UNIQUE INDEX wallet_links_one_per_account ON wallet_links (github_user_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX wallet_links_one_account_per_wallet ON wallet_links (address) WHERE revoked_at IS NULL;

CREATE TABLE bounties (
  id              UUID PRIMARY KEY,
  repo_id         BIGINT NOT NULL REFERENCES repos(id),
  issue_number    INTEGER NOT NULL,
  amount_minor    BIGINT NOT NULL CHECK (amount_minor > 0),
  currency        TEXT NOT NULL,            -- 'USDC' | 'ANSEM'
  mint            TEXT NOT NULL,
  network         TEXT NOT NULL,            -- 'solana-devnet' | 'solana-mainnet' | 'localnet'
  status          TEXT NOT NULL CHECK (status IN ('proposed','posted','in_review','payable','paid','cancelled','expired')),
  price_call_id   UUID REFERENCES inference_calls(id),
  pricing         JSONB NOT NULL DEFAULT '{}',
  comment_id      BIGINT,
  created_by      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX bounties_one_open_per_issue ON bounties (repo_id, issue_number) WHERE status NOT IN ('paid','cancelled','expired');

CREATE TABLE submissions (
  id                     UUID PRIMARY KEY,
  bounty_id              UUID NOT NULL REFERENCES bounties(id),
  pr_number              INTEGER NOT NULL,
  author_github_user_id  BIGINT NOT NULL,
  author_login           TEXT NOT NULL,
  head_sha               TEXT,
  state                  TEXT NOT NULL CHECK (state IN ('open','closed','merged')),
  merged_by_login        TEXT,
  merged_at              TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (bounty_id, pr_number)
);

-- Advisory only. Nothing here can authorise a payment.
CREATE TABLE reviews (
  id                UUID PRIMARY KEY,
  submission_id     UUID NOT NULL REFERENCES submissions(id),
  head_sha          TEXT NOT NULL,
  verdict           TEXT NOT NULL,
  summary           TEXT NOT NULL,
  call_ids          UUID[] NOT NULL,
  ci_state          TEXT,
  github_review_id  BIGINT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (submission_id, head_sha)
);

CREATE TABLE payouts (
  id               UUID PRIMARY KEY,
  bounty_id        UUID NOT NULL REFERENCES bounties(id),
  submission_id    UUID NOT NULL REFERENCES submissions(id),
  recipient        TEXT NOT NULL,
  recipient_github_user_id BIGINT NOT NULL,
  amount_minor     BIGINT NOT NULL CHECK (amount_minor > 0),
  currency         TEXT NOT NULL,
  mint             TEXT NOT NULL,
  network          TEXT NOT NULL,
  gate_result      JSONB NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('refused','awaiting_approval','approved','submitted','confirmed','failed')),
  approval         JSONB,
  approved_at      TIMESTAMPTZ,
  tx_signature     TEXT UNIQUE,
  error            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A bounty is paid at most once. A refused gate result does not block a later, valid PR.
CREATE UNIQUE INDEX payouts_one_live_per_bounty ON payouts (bounty_id) WHERE status <> 'refused';

CREATE TABLE audit_log (
  id          BIGSERIAL PRIMARY KEY,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  subject     TEXT,
  detail      JSONB NOT NULL DEFAULT '{}',
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
