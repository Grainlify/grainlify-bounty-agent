import { describe, expect, it } from 'vitest';
import { computeMetrics, costPerMergedPr, type ServedCallCost } from '../src/metrics.ts';

const onchain = (paidMicro: number, feeMicro: number): ServedCallCost => ({ scheme: 'onchain', paidMicro, feeMicro, chargedMicro: null });
const balance = (chargedMicro: number): ServedCallCost => ({ scheme: 'balance', paidMicro: 0, feeMicro: 0, chargedMicro });

describe('computeMetrics', () => {
  it('splits served calls by scheme and totals inference and network fees', () => {
    const m = computeMetrics([onchain(100, 9_900), onchain(100, 9_900), balance(150)], 2);
    expect(m.servedCalls).toBe(3);
    expect(m.servedByScheme).toEqual({ onchain: 2, balance: 1 });
    expect(m.inferenceMicro).toBe(350); // 100 + 100 on-chain + 150 from surplus credit
    expect(m.networkFeesMicro).toBe(19_800); // ~99% of what the paid calls cost
  });

  it('averages inference plus fees over served calls and merged PRs', () => {
    const m = computeMetrics([onchain(100, 9_900), onchain(100, 9_900), balance(150)], 2);
    expect(m.costPerServedCallMicro).toBe(Math.round(20_150 / 3));
    expect(m.costPerMergedPrMicro).toBe(10_075);
  });

  it('reads an unknown scheme as on-chain and counts it in neither bucket', () => {
    const m = computeMetrics([{ scheme: null, paidMicro: 5, feeMicro: 7, chargedMicro: null }], 1);
    expect(m.servedByScheme).toEqual({ onchain: 0, balance: 0 });
    expect(m.inferenceMicro).toBe(5);
    expect(m.networkFeesMicro).toBe(7);
  });

  it('reports zero totals with no served calls, but null cost per served call', () => {
    const m = computeMetrics([], 3);
    expect(m).toEqual({
      servedCalls: 0,
      servedByScheme: { onchain: 0, balance: 0 },
      inferenceMicro: 0,
      networkFeesMicro: 0,
      costPerServedCallMicro: null,
      costPerMergedPrMicro: 0, // 0 spend over 3 merged PRs is a true zero, not an unknown
    });
  });

  it('reports null cost per merged PR when no PR has merged, even with real spend', () => {
    const m = computeMetrics([onchain(100, 9_900)], 0);
    expect(m.inferenceMicro).toBe(100);
    expect(m.costPerServedCallMicro).toBe(10_000);
    // "No merged PR yet" is not "zero cost per merged PR".
    expect(m.costPerMergedPrMicro).toBeNull();
  });

  it('makes a total null when any served call is missing that figure', () => {
    const m = computeMetrics([onchain(100, 9_900), { scheme: 'onchain', paidMicro: null, feeMicro: null, chargedMicro: null }], 1);
    expect(m.inferenceMicro).toBeNull();
    expect(m.networkFeesMicro).toBeNull();
    expect(m.costPerServedCallMicro).toBeNull();
    expect(m.costPerMergedPrMicro).toBeNull();
  });

  it('treats a missing balance charge as unknown, but a missing balance fee as zero', () => {
    const unknown = computeMetrics([{ scheme: 'balance', paidMicro: 0, feeMicro: null, chargedMicro: null }], 1);
    expect(unknown.inferenceMicro).toBeNull();
    expect(unknown.networkFeesMicro).toBe(0); // surplus credit has no on-chain transaction, so provably no fee
  });

  it('rejects NaN, negative and fractional micro amounts', () => {
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      const m = computeMetrics([{ scheme: 'onchain', paidMicro: bad, feeMicro: 0, chargedMicro: null }], 1);
      expect(m.inferenceMicro).toBeNull();
    }
  });

  it('refuses a non-array rather than silently reporting zeros', () => {
    expect(() => computeMetrics(null as never, 0)).toThrow(TypeError);
    expect(() => computeMetrics(undefined as never, 0)).toThrow(TypeError);
  });
});

describe('costPerMergedPr', () => {
  it('divides and rounds to whole micro', () => {
    expect(costPerMergedPr(1_000, 3)).toBe(333);
    expect(costPerMergedPr(20_150, 2)).toBe(10_075);
  });

  it('is null — never 0 — when the total is unknown or no PR has merged', () => {
    expect(costPerMergedPr(null, 3)).toBeNull();
    expect(costPerMergedPr(1_000, 0)).toBeNull();
    expect(costPerMergedPr(1_000, -2)).toBeNull();
    expect(costPerMergedPr(1_000, Number.NaN)).toBeNull();
  });

  it('allows a true zero: spend recorded as 0 over merged PRs', () => {
    expect(costPerMergedPr(0, 2)).toBe(0);
  });

  it('floors a fractional PR count rather than rounding it up', () => {
    expect(costPerMergedPr(1_000, 2.9)).toBe(500);
  });
});
