-- The exact Solana network fee in lamports, from the confirmed transaction,
-- stored next to fee_micro. fee_micro stays the conservative ceiling-price
-- estimate the budget counts against; this column is the factual figure.
-- Nullable: rows written before this migration, and balance-scheme calls
-- (no on-chain transaction, no network fee), have none.
ALTER TABLE inference_calls ADD COLUMN IF NOT EXISTS fee_lamports BIGINT;
