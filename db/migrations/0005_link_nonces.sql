-- Nonces from Grainlify-countersigned wallet links (packages/gate/src/session-link.ts).
-- A nonce is spent in the same transaction that stores the link, so a message
-- can link a wallet at most once, however often it is replayed.
CREATE TABLE link_nonces (
  nonce           TEXT PRIMARY KEY,
  github_user_id  BIGINT NOT NULL,
  used_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
