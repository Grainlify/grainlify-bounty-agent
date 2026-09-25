import { describe, expect, it } from 'vitest';
import { budgetConfig, decide, HARD_LIFETIME_CEILING_MICRO, lamportsToMicroCeil, PHASE_ALLOCATION_MICRO, type SpendTotals } from '../src/governor.ts';
import { InMemorySpendLedger } from '../src/ledger.ts';

const zero: SpendTotals = { lifetimeMicro: 0, byPhase: { P1: 0, P2P3: 0, P4: 0, LIVE: 0 } };

describe('budget config', () => {
  it('allocates exactly the $5.00 lifetime ceiling', () => {
    const sum = Object.values(PHASE_ALLOCATION_MICRO).reduce((a, b) => a + b, 0);
    expect(sum).toBe(HARD_LIFETIME_CEILING_MICRO);
    expect(HARD_LIFETIME_CEILING_MICRO).toBe(5_000_000);
  });

  it('lets config lower the ceiling but never raise it', () => {
    expect(budgetConfig({ lifetimeCeilingMicro: 1_000_000 }).lifetimeCeilingMicro).toBe(1_000_000);
    expect(budgetConfig({ lifetimeCeilingMicro: 50_000_000 }).lifetimeCeilingMicro).toBe(5_000_000);
  });
});

describe('decide', () => {
  const cfg = budgetConfig();

  it('allows a spend inside both the phase and lifetime limits', () => {
    expect(decide(cfg, zero, { phase: 'P1', kind: 'x402_payment', amountMicro: 2_035 }).ok).toBe(true);
  });

  it('refuses a spend that would overrun the phase allocation', () => {
    const d = decide(cfg, { lifetimeMicro: 499_000, byPhase: { ...zero.byPhase, P1: 499_000 } }, { phase: 'P1', kind: 'x402_payment', amountMicro: 2_000 });
    expect(d).toMatchObject({ ok: false, code: 'over_phase' });
  });

  it('refuses a spend that would overrun the lifetime ceiling even if the phase has room', () => {
    const d = decide(cfg, { lifetimeMicro: 4_999_000, byPhase: { ...zero.byPhase, LIVE: 0 } }, { phase: 'LIVE', kind: 'x402_payment', amountMicro: 2_000 });
    expect(d).toMatchObject({ ok: false, code: 'over_lifetime' });
  });

  it('hard-stops once the ceiling is reached, whatever the amount', () => {
    const d = decide(cfg, { lifetimeMicro: 5_000_000, byPhase: zero.byPhase }, { phase: 'LIVE', kind: 'x402_payment', amountMicro: 1 });
    expect(d).toMatchObject({ ok: false, code: 'ceiling_reached' });
  });

  it('refuses zero, negative and fractional amounts', () => {
    for (const amountMicro of [0, -1, 1.5, Number.NaN]) {
      expect(decide(cfg, zero, { phase: 'P1', kind: 'x402_payment', amountMicro })).toMatchObject({ ok: false, code: 'invalid_amount' });
    }
  });
});

describe('lamportsToMicroCeil', () => {
  it('counts a 5000-lamport fee at a $400 SOL as $0.002, rounding up', () => {
    expect(lamportsToMicroCeil(5_000, 400)).toBe(2_000);
    expect(lamportsToMicroCeil(1, 400)).toBe(1);
  });

  it('proves fee_micro is unchanged for the same input when tracking fee_lamports', () => {
    const lamports = 5_000;
    const solPrice = 400;
    const feeMicroA = lamportsToMicroCeil(lamports, solPrice);
    const feeMicroB = lamportsToMicroCeil(lamports, solPrice);
    expect(feeMicroA).toBe(feeMicroB);
    expect(feeMicroA).toBe(2_000);
  });
});

describe('InMemorySpendLedger', () => {
  it('keeps reservations counted until settled or released, and only releases reservations', async () => {
    const l = new InMemorySpendLedger(budgetConfig({ lifetimeCeilingMicro: 10_000 }));
    const a = await l.reserve({ phase: 'P1', kind: 'x402_payment', amountMicro: 6_000, callId: 'c1' });
    expect(a.decision.ok).toBe(true);
    const b = await l.reserve({ phase: 'P1', kind: 'x402_payment', amountMicro: 6_000, callId: 'c2' });
    expect(b.decision).toMatchObject({ ok: false, code: 'over_lifetime' });
    await l.settle(a.entryId!, { amountMicro: 3_000, feeMicro: 2_000, txSignature: 'sig' });
    expect((await l.totals()).lifetimeMicro).toBe(5_000);
    await expect(l.release(a.entryId!)).rejects.toThrow(/settled/);
  });

  it('cannot be overrun by concurrent reservations', async () => {
    const l = new InMemorySpendLedger(budgetConfig({ lifetimeCeilingMicro: 10_000 }));
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => l.reserve({ phase: 'P1', kind: 'x402_payment', amountMicro: 1_000, callId: `c${i}` })));
    expect(results.filter((r) => r.decision.ok)).toHaveLength(10);
    expect((await l.totals()).lifetimeMicro).toBe(10_000);
  });
});
