import { describe, expect, it } from 'vitest';
import { computeMetrics, type LedgerMetricAggregate } from '../src/metrics.ts';

function aggregate(overrides: Partial<LedgerMetricAggregate> = {}): LedgerMetricAggregate {
  return {
    served_call_count: '3',
    on_chain_call_count: '2',
    surplus_credit_call_count: '1',
    unclassified_call_count: '0',
    inference_total_micro: '300',
    network_fee_total_micro: '30',
    merged_pr_count: '2',
    ...overrides,
  };
}

describe('public ledger metrics', () => {
  it('splits served calls and computes the per-call and per-merged-PR costs', () => {
    expect(computeMetrics(aggregate(), false)).toEqual({
      servedCalls: { total: 3, onChain: 2, surplusCredit: 1, unclassified: 0 },
      inferenceTotalMicro: 300,
      networkFeeTotalMicro: 30,
      costPerServedCallMicro: 110,
      costPerMergedPrMicro: 165,
    });
  });

  it('keeps mock-mode money metrics unavailable while retaining valid call counts', () => {
    expect(computeMetrics(aggregate(), true)).toEqual({
      servedCalls: { total: 3, onChain: 2, surplusCredit: 1, unclassified: 0 },
      inferenceTotalMicro: null,
      networkFeeTotalMicro: null,
      costPerServedCallMicro: null,
      costPerMergedPrMicro: null,
    });
  });

  it('returns null for averages when their denominator is zero', () => {
    expect(
      computeMetrics(
        aggregate({ served_call_count: '0', on_chain_call_count: '0', surplus_credit_call_count: '0', inference_total_micro: '0', network_fee_total_micro: '0', merged_pr_count: '0' }),
        false,
      ),
    ).toEqual({
      servedCalls: { total: 0, onChain: 0, surplusCredit: 0, unclassified: 0 },
      inferenceTotalMicro: 0,
      networkFeeTotalMicro: 0,
      costPerServedCallMicro: null,
      costPerMergedPrMicro: null,
    });
  });

  it('does not turn an incomplete cost total into zero', () => {
    expect(computeMetrics(aggregate({ inference_total_micro: null }), false)).toMatchObject({
      inferenceTotalMicro: null,
      networkFeeTotalMicro: 30,
      costPerServedCallMicro: null,
      costPerMergedPrMicro: null,
    });
  });
});
