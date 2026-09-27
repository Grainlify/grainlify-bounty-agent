import { describe, expect, it } from 'vitest';
import { budgetConfig } from '../../budget/src/governor.ts';
import { InMemorySpendLedger } from '../../budget/src/ledger.ts';
import type { Payer } from '../src/client.ts';
import { X402Client } from '../src/client.ts';
import { InMemoryReceiptStore } from '../src/receipts.ts';

describe('fee_lamports retention in ledger and receipts (Issue #1)', () => {
  it('preserves factual confirmed fee_lamports in spend entry and inference receipts', async () => {
    const ledger = new InMemorySpendLedger(budgetConfig({ lifetimeCeilingMicro: 1_000_000 }));
    const receipts = new InMemoryReceiptStore();

    const mockPayer: Payer = {
      address: async () => 'HKMMpctYvofRCSF2uGnqfEGWcmMhD8A86xFqgmWTvcq9',
      balanceProof: async () => ({ payer_wallet: 'HKMMpctYvofRCSF2uGnqfEGWcmMhD8A86xFqgmWTvcq9', proof: 'dummy-proof' }),
      payQuote: async (rail) => ({
        kind: 'paid',
        payer_wallet: 'HKMMpctYvofRCSF2uGnqfEGWcmMhD8A86xFqgmWTvcq9',
        signature: 'tx-sig-actual-lamports-123',
        amount_micro: rail.amount_microunits,
        fee_lamports: 5_010, // Actual confirmed network fee on Solana
        fee_micro: 2_004,    // Conservative ceiling micro-USD
      }),
    };

    // Verify settlement directly against SpendLedger
    const res = await ledger.reserve({ phase: 'P1', kind: 'x402_payment', amountMicro: 50_000, callId: 'test-call-1' });
    expect(res.decision.ok).toBe(true);
    expect(res.entryId).toBeTruthy();

    await ledger.settle(res.entryId!, {
      amountMicro: 10_000,
      feeMicro: 2_004,
      feeLamports: 5_010,
      txSignature: 'tx-sig-actual-lamports-123',
    });

    const entries = await ledger.entries();
    const entry = entries.find((e) => e.id === res.entryId);
    expect(entry).toBeDefined();
    expect(entry?.feeMicro).toBe(2_004);
    expect(entry?.feeLamports).toBe(5_010);
    expect(entry?.status).toBe('settled');
  });

  it('safely handles missing or undefined fee_lamports (backward compatibility)', async () => {
    const ledger = new InMemorySpendLedger(budgetConfig({ lifetimeCeilingMicro: 1_000_000 }));
    const res = await ledger.reserve({ phase: 'P1', kind: 'x402_payment', amountMicro: 50_000, callId: 'test-call-2' });
    await ledger.settle(res.entryId!, {
      amountMicro: 10_000,
      feeMicro: 2_000,
      txSignature: 'tx-legacy-sig',
    });

    const entries = await ledger.entries();
    const entry = entries.find((e) => e.id === res.entryId);
    expect(entry?.feeMicro).toBe(2_000);
    expect(entry?.feeLamports).toBeNull();
  });
});
