// 1. Database Migration: db/migrations/20231027_add_fee_lamports_to_inference_calls.sql
/*
ALTER TABLE inference_calls ADD COLUMN fee_lamports BIGINT;
*/

// 2. packages/x402/src/client.ts
// Update the interface and call to include fee_lamports
export interface SettleRequest {
  fee_micro: number;
  fee_lamports: bigint; // Added factual lamports
  // ... existing fields
}

// Inside the settlement logic:
await db.inference_calls.update({
  where: { id: callId },
  data: {
    fee_micro: result.feeMicro,
    fee_lamports: result.feeLamports, // Persisting actual cost
  },
});

// 3. services/signer/src/signer.ts
import { lamportsToMicroCeil } from './utils';

// ... inside processPayment function
const res = await confirmTransaction(tx); 

// Keep existing ceiling logic for budget enforcement
const feeMicro = lamportsToMicroCeil(res.feeLamports, solUsdCeilingPrice);

// Pass both to the ledger repository
await ledger.recordPayment({
  inferenceCallId,
  feeMicro,
  feeLamports: res.feeLamports, // Passed through for historical accuracy
});

// 4. Verification Test (e.g., packages/x402/src/client.test.ts)
it('should record both capped fee_micro and actual fee_lamports', async () => {
  const mockFeeLamports = 5000n;
  const solUsdCeiling = 400;
  
  const feeMicro = lamportsToMicroCeil(mockFeeLamports, solUsdCeiling);
  
  // Assert micro remains conservative/consistent
  expect(feeMicro).toBeGreaterThan(0);
  
  // Assert actual lamports are captured
  const record = await db.inference_calls.create({
    data: { fee_micro: feeMicro, fee_lamports: mockFeeLamports }
  });
  
  expect(record.fee_lamports).toBe(mockFeeLamports);
  expect(record.fee_micro).toBe(feeMicro);
});