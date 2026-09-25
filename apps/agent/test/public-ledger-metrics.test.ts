import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { p2Config } from '../src/config.ts';
import { PublicApi } from '../src/public.ts';

function publicApi(aggregate: Record<string, string | null>, inferenceMode: 'mock' | 'live') {
  const query = vi.fn(async (queryText: string) => {
    if (queryText.includes('FROM bounties b')) return { rows: [], rowCount: 0 };
    if (queryText.includes('FROM payouts p')) return { rows: [], rowCount: 0 };
    if (queryText.includes('ORDER BY created_at DESC LIMIT 200')) return { rows: [], rowCount: 0 };
    if (queryText.includes('COUNT(*) FILTER (WHERE scheme')) return { rows: [aggregate], rowCount: 1 };
    if (queryText.includes('FROM inference_spend')) return { rows: [], rowCount: 0 };
    throw new Error(`Unexpected query in public ledger test: ${queryText}`);
  });
  const cfg = p2Config({ mints: {}, trustedApprovers: [], inferenceMode });
  return new PublicApi({ query } as unknown as pg.Pool, cfg);
}

const metricsRow = {
  served_call_count: '2',
  on_chain_call_count: '1',
  surplus_credit_call_count: '1',
  unclassified_call_count: '0',
  inference_total_micro: '120',
  network_fee_total_micro: '20',
  merged_pr_count: '1',
};

describe('GET /public/ledger response metrics', () => {
  it('adds aggregate metrics without changing the existing response sections', async () => {
    const ledger = await publicApi(metricsRow, 'live').ledger();

    expect(ledger.status).toMatchObject({ inferenceMode: 'live' });
    expect(ledger).toHaveProperty('totals');
    expect(Array.isArray(ledger.budget)).toBe(true);
    expect(ledger.events).toEqual([]);
    expect(ledger.metrics).toEqual({
      servedCalls: { total: 2, onChain: 1, surplusCredit: 1, unclassified: 0 },
      inferenceTotalMicro: 120,
      networkFeeTotalMicro: 20,
      costPerServedCallMicro: 70,
      costPerMergedPrMicro: 140,
    });
  });

  it('reports no average as zero when no merged PR is recorded', async () => {
    const ledger = await publicApi({ ...metricsRow, merged_pr_count: '0' }, 'live').ledger();

    expect(ledger.metrics.costPerMergedPrMicro).toBeNull();
  });

  it('does not publish test-gateway monetary values', async () => {
    const ledger = await publicApi(metricsRow, 'mock').ledger();

    expect(ledger.metrics).toMatchObject({
      servedCalls: { total: 2, onChain: 1, surplusCredit: 1 },
      inferenceTotalMicro: null,
      networkFeeTotalMicro: null,
      costPerServedCallMicro: null,
      costPerMergedPrMicro: null,
    });
  });
});
