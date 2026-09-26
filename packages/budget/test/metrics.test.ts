import { describe, expect, it } from 'vitest';
import { computeMetrics, costPerMergedPr, type CallRow, type ListPrice } from '../src/metrics.ts';

const list = new Map<string, ListPrice>([['m', { inputPer1m: 800_000, outputPer1m: 4_000_000 }]]);
const row = (o: Partial<CallRow>): CallRow => ({
  scheme: 'onchain', status: 'served', model: 'm', paidMicro: 9, feeMicro: 2004,
  chargedMicro: 6, usageIn: 10, usageOut: 5, links: null, ...o,
});

describe('spend metrics', () => {
  it('separates what inference cost from what the chain cost', () => {
    const m = computeMetrics([row({}), row({})], list);
    expect(m.inferenceMicro).toBe(12);
    expect(m.feeMicro).toBe(4008);
    expect(m.totalMicro).toBe(4020);
    // The headline: the network fee dwarfs the inference it pays for.
    expect(m.feeToInferenceRatio).toBeCloseTo(334, 0);
    expect(m.feeSharePct).toBeGreaterThan(99);
  });

  it('counts a credit call as served, free, and not a paid call', () => {
    const m = computeMetrics([row({}), row({ scheme: 'balance', paidMicro: 0, feeMicro: 0, chargedMicro: 5 })], list);
    expect(m.paidCalls).toBe(1);
    expect(m.creditCalls).toBe(1);
    expect(m.servedCalls).toBe(2);
    expect(m.feeMicro).toBe(2004);
  });

  it('ignores calls that were never served', () => {
    const m = computeMetrics([row({}), row({ status: 'refused_budget', chargedMicro: null, feeMicro: null })], list);
    expect(m.servedCalls).toBe(1);
    expect(m.totalMicro).toBe(2010);
  });

  it('prices the same tokens at list, and says how many it could price', () => {
    const m = computeMetrics([row({ usageIn: 1_000_000, usageOut: 1_000_000 })], list);
    expect(m.listPriceMicro).toBe(4_800_000);
    expect(m.listPriceModels).toBe(1);
  });

  it('does not invent a list price for a model it has no price for', () => {
    const m = computeMetrics([row({ model: 'unknown' })], list);
    expect(m.listPriceMicro).toBeNull();
    expect(m.listPriceModels).toBe(0);
  });

  it('attributes spend to a merged PR through the bounty it served', () => {
    const rows = [
      row({ links: { repo: 'Grainlify/x', issueNumber: 1 } }),
      row({ links: { repo: 'Grainlify/x', issueNumber: 2 } }),
      row({ links: null }),
    ];
    const r = costPerMergedPr(rows, new Set(['Grainlify/x#1']));
    expect(r.merged).toBe(1);
    expect(r.attributedMicro).toBe(2010);
    expect(r.perMergedMicro).toBe(2010);
    // Spend on issues that never merged is reported, not hidden in the average.
    expect(r.unattributedMicro).toBe(4020);
  });

  it('reports nothing rather than zero when no PR has merged', () => {
    expect(costPerMergedPr([row({})], new Set()).perMergedMicro).toBeNull();
    expect(computeMetrics([], list).costPerServedCallMicro).toBeNull();
  });
});
