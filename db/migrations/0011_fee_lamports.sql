-- The exact Solana network fee the confirmed transaction actually cost, in
-- lamports, next to fee_micro.
--
-- fee_micro stays exactly as it is: a deliberate ceiling-price estimate
-- (solUsdCeilingPrice, $400) so the budget can never under-count spend. This
-- column is the factual figure the signer read off the confirmed transaction
-- (res.feeLamports), the number most worth getting right on a paid call.
-- Nullable so existing rows remain valid untouched; a call that moved no
-- on-chain fee (surplus credit) stores 0.
ALTER TABLE inference_calls ADD COLUMN fee_lamports BIGINT;
