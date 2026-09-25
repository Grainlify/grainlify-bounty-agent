-- Record the real Solana network fee in lamports alongside the capped USD estimate.
ALTER TABLE inference_calls ADD COLUMN IF NOT EXISTS fee_lamports BIGINT;
