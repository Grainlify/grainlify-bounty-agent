-- Weighted-draw assignment for bounties.
--
-- These three tables are the bounty-side adapter for GrainHack's assignment
-- pipeline (Grainlify-Backend, migration 000041 and internal/hackathon/draw.go).
-- Same shape, same rules, same replayability; the grain differs because a
-- bounty belongs to the agent's own `bounties` table rather than to a
-- hackathon issue. Where a column exists there it is named the same here, so
-- the two can be read side by side.

-- One row per (bounty, contributor). A failed gate is STORED rather than
-- discarded, so the applicant can be shown the specific reason they did not
-- enter the pool instead of a shrug.
CREATE TABLE bounty_applications (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_id           UUID NOT NULL REFERENCES bounties(id) ON DELETE CASCADE,
  github_user_id      BIGINT NOT NULL,
  github_login        TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'applied'
                      CHECK (status IN ('applied','rejected_gate','won','lost','withdrawn')),
  gate_failure_reason TEXT,
  -- Layer-2 fit assessment, bought from UsePod over x402. NULL until assessed.
  -- fit_call_id ties the row to the receipt that paid for it, so the cost of a
  -- draw is auditable per application.
  fit                 TEXT CHECK (fit IS NULL OR fit IN ('strong','plausible','weak')),
  difficulty_match    TEXT CHECK (difficulty_match IS NULL OR difficulty_match IN ('below','matched','above')),
  fit_evidence        TEXT,
  fit_assessed_at     TIMESTAMPTZ,
  fit_call_id         UUID REFERENCES inference_calls(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One application per person per bounty, enforced by the database rather
  -- than by application code: the anti-gaming rule that matters most is the
  -- one that cannot be raced.
  UNIQUE (bounty_id, github_user_id)
);
CREATE INDEX bounty_applications_bounty ON bounty_applications (bounty_id, status);
CREATE INDEX bounty_applications_user ON bounty_applications (github_user_id, status);

-- The draw itself. seed + pool together are enough to replay any draw without
-- reading another table, which is what makes a contested result answerable.
CREATE TABLE bounty_draws (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_id            UUID NOT NULL REFERENCES bounties(id) ON DELETE CASCADE,
  seed                 BIGINT NOT NULL,
  -- [{github_user_id, github_login, fit, tickets, weights:{name:factor}}, ...]
  pool                 JSONB NOT NULL DEFAULT '[]'::jsonb,
  pool_size            INT NOT NULL DEFAULT 0,
  winner_github_user_id BIGINT,
  winner_login         TEXT,
  -- Which fallback fired, so an odd or absent assignment is explainable after
  -- the fact rather than requiring the code to be re-read.
  first_come_fallback  BOOLEAN NOT NULL DEFAULT false,
  no_winner_reason     TEXT,
  -- true = "simulate": the full pipeline against the real pool, writing no
  -- assignment. How weights get checked before anything is assigned for real.
  is_simulation        BOOLEAN NOT NULL DEFAULT false,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX bounty_draws_bounty ON bounty_draws (bounty_id, created_at DESC);

-- The assignment and its lifecycle.
CREATE TABLE bounty_assignments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_id         UUID NOT NULL REFERENCES bounties(id) ON DELETE CASCADE,
  draw_id           UUID REFERENCES bounty_draws(id) ON DELETE SET NULL,
  github_user_id    BIGINT NOT NULL,
  github_login      TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','pr_submitted','completed','released_stale','released_voluntary','released_pr_rejected')),
  assigned_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Resolved at write time from the config in force then, so a later config
  -- edit never retroactively moves an existing assignment's deadline.
  stale_at          TIMESTAMPTZ NOT NULL,
  qualifying_pr_number INT,
  merged_at         TIMESTAMPTZ,
  released_at       TIMESTAMPTZ,
  release_reason    TEXT,
  -- A rejected PR is a genuine attempt that missed; it re-draws but is NOT an
  -- abandon, so it must not weigh against the person in a later draw.
  counts_as_abandon BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One LIVE assignment per bounty. Partial rather than a plain UNIQUE, because a
-- released bounty must be re-drawable.
CREATE UNIQUE INDEX bounty_assignments_one_active ON bounty_assignments (bounty_id)
  WHERE status IN ('active','pr_submitted');

-- Applications open on posting and close when the window elapses.
ALTER TABLE bounties ADD COLUMN applications_open_at TIMESTAMPTZ;
ALTER TABLE bounties ADD COLUMN applications_close_at TIMESTAMPTZ;
ALTER TABLE bounties ADD COLUMN window_extensions INT NOT NULL DEFAULT 0;
