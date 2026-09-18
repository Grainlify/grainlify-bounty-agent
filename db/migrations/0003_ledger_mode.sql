-- Whether this database's ledger holds mock (play) money or live (real) money.
-- Set once, the first time a process binds to the database; never changed.
CREATE TABLE ledger_meta (
  singleton   BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  mode        TEXT NOT NULL CHECK (mode IN ('mock','live')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
