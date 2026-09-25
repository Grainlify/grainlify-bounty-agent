-- Store the actual Solana network fee in lamports alongside the conservative USD estimate.
ALTER TABLE inference_calls ADD COLUMN IF NOT EXISTS fee_lamports BIGINT;
