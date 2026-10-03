-- GrainHack records of an erased account under the payout-record retention
-- period (apps/agent/src/grainhack/retention.ts).
--
-- Erasure keeps an erased winner's GrainHack statement lines, payout rows and
-- payment reports: they are payout records, and the login inside a signed
-- statement cannot change (erasure-service.ts). The Terms say payout records
-- are kept five years after the payment, then erased, and Grainlify-Backend
-- does that to its own copy (internal/erasure/retention.go). This is the
-- agent's half.
--
-- Statements are immutable (0018_grainhack.sql). There is exactly one way
-- past that, and it is narrow, the same as the backend's (GH010 there):
--
--   * only inside a transaction that has set grainlify_agent.grainhack_retention
--     to its own transaction id with set_config(..., true) - a session-wide
--     SET, or a value left from another transaction, never matches;
--   * UPDATE only, to redact: statement_json, signature and redacted_at may
--     change, every other column must not; the signature becomes empty (it was
--     over bytes no longer stored); the new document is the old one with some
--     of its lines taken out, and names no erased account;
--   * every use is written to grainhack_retention_log, which names a
--     statement and a transaction, never a person.
--
-- DELETE is refused as before: a statement is redacted, never removed.
--
-- The public GrainHack ledger is not touched. It is append-only, and nothing
-- here changes that: its rows keep what they were written with, and the public
-- API shows an erased account's login as "erased account" (account_erasures).

ALTER TABLE grainhack_statements ADD COLUMN IF NOT EXISTS redacted_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS grainhack_retention_log (
  id            BIGSERIAL PRIMARY KEY,
  op            TEXT NOT NULL CHECK (op IN ('statement_redacted')),
  statement_id  UUID NOT NULL,
  txid          BIGINT NOT NULL,
  at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION grainhack_statements_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_doc JSONB;
  new_doc JSONB;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'grainhack statements are never deleted';
  END IF;
  IF current_setting('grainlify_agent.grainhack_retention', true) = txid_current()::text
     AND NEW.redacted_at IS NOT NULL
     AND NEW.signature = ''
     AND (to_jsonb(NEW) - ARRAY['statement_json', 'signature', 'redacted_at'])
       = (to_jsonb(OLD) - ARRAY['statement_json', 'signature', 'redacted_at']) THEN
    -- A statement already redacted once keeps its document under "statement".
    old_doc := COALESCE(OLD.statement_json::jsonb -> 'statement', OLD.statement_json::jsonb);
    new_doc := NEW.statement_json::jsonb -> 'statement';
    IF NEW.statement_json::jsonb ? 'redacted'
       AND new_doc IS NOT NULL
       AND jsonb_typeof(new_doc -> 'lines') = 'array'
       AND (new_doc - 'lines') = (old_doc - 'lines')
       -- Every line kept is one of the old lines, exactly.
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(new_doc -> 'lines') n
                       WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(old_doc -> 'lines') o WHERE o = n))
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(new_doc -> 'lines') e
                       JOIN account_erasures a ON a.github_user_id = (e ->> 'github_user_id')::bigint) THEN
      INSERT INTO grainhack_retention_log (op, statement_id, txid) VALUES ('statement_redacted', OLD.statement_id, txid_current());
      RETURN NEW;
    END IF;
  END IF;
  IF OLD.superseded_by IS NOT NULL OR NEW.superseded_by IS NULL
     OR (to_jsonb(NEW) - 'superseded_by') <> (to_jsonb(OLD) - 'superseded_by') THEN
    RAISE EXCEPTION 'grainhack statements are immutable once imported (only superseded_by may be set, once)';
  END IF;
  RETURN NEW;
END $$;
