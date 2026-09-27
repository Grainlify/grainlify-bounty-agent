-- Migration 0011: Retain factual on-chain transaction fee in lamports
-- Resolves Grainlify Issue #1: Record the real network fee in the ledger, not only the capped estimate
ALTER TABLE inference_calls
  ADD COLUMN IF NOT EXISTS fee_lamports BIGINT;

ALTER TABLE inference_spend
  ADD COLUMN IF NOT EXISTS fee_lamports BIGINT;
