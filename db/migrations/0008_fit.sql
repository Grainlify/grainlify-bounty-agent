-- Layer 2: the AI fit assessment, ported from GrainHack's AI-specs.md §4.3.

-- The cached GitHub evidence a fit call is judged on.
--
-- §4.3: "built on first application in the event and reused for all later
-- applications (refresh if older than 7 days). One crawl per person, not per
-- application - rate-limit safe and reproducible."
--
-- Reproducible matters as much as the rate limit: two applications from the
-- same person a day apart should be judged on the same evidence, or the
-- difference between their assessments is partly just GitHub's clock.
CREATE TABLE contributor_snapshots (
  github_user_id  BIGINT PRIMARY KEY,
  login           TEXT NOT NULL,
  -- {account_age_days, public_repo_count, languages[], recent_repos[], sample_diffs[]}
  evidence        JSONB NOT NULL,
  built_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Why a snapshot is thin, when it is. An empty evidence blob because
  -- GitHub refused is a different thing from one because the person has no
  -- public code, and the fit prompt is told not to punish the second.
  build_note      TEXT
);

-- The applicant's own words. Optional, untrusted, and never weighted.
--
-- §4.4 is explicit that this is "UNTRUSTED. It is very likely AI-generated",
-- that the model must judge on the code rather than the prose, and that
-- application text quality is not available as a draw weight. It exists so
-- the model has something to flag as an injection attempt, and so somebody
-- with context to add has somewhere to put it.
ALTER TABLE bounty_applications ADD COLUMN application_text TEXT;

-- What the model actually said, kept so an assessment can be explained.
ALTER TABLE bounty_applications ADD COLUMN fit_concerns TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE bounty_applications ADD COLUMN fit_model TEXT;

-- 'fit' is a new call purpose, and inference_calls.purpose is a CHECK list.
-- Without this the first fit call fails at the receipt insert, before any
-- money moves - loudly, but only once somebody switches the assessment on.
ALTER TABLE inference_calls DROP CONSTRAINT IF EXISTS inference_calls_purpose_check;
ALTER TABLE inference_calls ADD CONSTRAINT inference_calls_purpose_check
  CHECK (purpose IN ('triage','price','review','crosscheck','fit','spike','eval'));

-- Cost per application is a join from the application to its receipt.
CREATE INDEX IF NOT EXISTS inference_calls_links_application
  ON inference_calls ((links->>'applicationId')) WHERE links ? 'applicationId';
