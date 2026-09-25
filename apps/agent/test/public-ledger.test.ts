// The public ledger response carries the aggregate cost metrics of served
// inference calls: the split by payment scheme, inference and network-fee
// totals, cost per served call and cost per merged PR. Figures that cannot
// be computed are null, never 0. Runs against a stub pool — no database,
// wallet or network needed.

import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { p2Config } from '../src/config.ts';
import { PublicApi } from '../src/public.ts';

type Row = Record<string, unknown>;

/** Answers the read-only queries PublicApi.ledger makes. */
function stubPool(opts: { served?: Row[]; mergedPrs?: number; spend?: Row[] }): pg.Pool {
  const { served = [], mergedPrs = 0, spend = [] } = opts;
  return {
    query: async (sql: string) => {
      if (sql.includes('FROM bounties')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM payouts')) return { rows: [], rowCount: 0 };
      if (sql.includes('charged_micro')) return { rows: served, rowCount: served.length }; // the aggregate query
      if (sql.includes(`state = 'merged'`)) return { rows: [{ n: mergedPrs }], rowCount: 1 };
      if (sql.includes('FROM inference_calls')) return { rows: [], rowCount: 0 }; // the recent-events window
      if (sql.includes('FROM inference_spend')) return { rows: spend, rowCount: spend.length };
      throw new Error(`unexpected query: ${sql}`);
    },
  } as unknown as pg.Pool;
}

// pg returns BIGINT columns as strings, so the fixtures use strings too.
const onchainCall = (paid: string, fee: string): Row => ({ scheme: 'onchain', paid_micro: paid, fee_micro: fee, charged_micro: null });
const balanceCall = (charged: string | null): Row => ({ scheme: 'balance', paid_micro: '0', fee_micro: '0', charged_micro: charged });

const liveApi = (opts: Parameters<typeof stubPool>[0]) => new PublicApi(stubPool(opts), p2Config({ mints: {}, trustedApprovers: [], inferenceMode: 'live' }));

describe('public ledger inference aggregates', () => {
  it('adds the aggregates to the response without reshaping what was there', async () => {
    const body = await liveApi({ served: [onchainCall('100', '9900'), onchainCall('100', '9900'), balanceCall('150')], mergedPrs: 2 }).ledger();
    expect(body.inference).toEqual({
      servedCalls: 3,
      servedByScheme: { onchain: 2, balance: 1 },
      inferenceMicro: 350,
      networkFeesMicro: 19_800,
      costPerServedCallMicro: Math.round(20_150 / 3),
      costPerMergedPrMicro: 10_075,
    });
    // The pre-existing shape is untouched.
    expect(body).toHaveProperty('status');
    expect(body).toHaveProperty('totals');
    expect(body).toHaveProperty('budget');
    expect(body).toHaveProperty('events');
    expect(body.totals).toHaveProperty('inferenceCalls');
    expect(body.totals).toHaveProperty('inferenceSpendMicro');
  });

  it('reports null per-unit costs, not 0, when nothing has been served or merged', async () => {
    const body = await liveApi({ served: [], mergedPrs: 0 }).ledger();
    expect(body.inference).toEqual({
      servedCalls: 0,
      servedByScheme: { onchain: 0, balance: 0 },
      inferenceMicro: 0,
      networkFeesMicro: 0,
      costPerServedCallMicro: null,
      costPerMergedPrMicro: null,
    });
  });

  it('keeps "no merged PR yet" distinct from "zero cost per merged PR"', async () => {
    const body = await liveApi({ served: [onchainCall('100', '9900')], mergedPrs: 0 }).ledger();
    expect(body.inference.inferenceMicro).toBe(100);
    expect(body.inference.costPerServedCallMicro).toBe(10_000);
    expect(body.inference.costPerMergedPrMicro).toBeNull();
  });

  it('reports a total as null when any served call is missing that figure', async () => {
    const body = await liveApi({ served: [onchainCall('100', '9900'), balanceCall(null)], mergedPrs: 1 }).ledger();
    expect(body.inference.inferenceMicro).toBeNull();
    expect(body.inference.costPerServedCallMicro).toBeNull();
    expect(body.inference.costPerMergedPrMicro).toBeNull();
    expect(body.inference.networkFeesMicro).toBe(9_900); // fees are still fully known
  });

  it('hides play-money figures while inference is mocked, but keeps the counts', async () => {
    const api = new PublicApi(stubPool({ served: [onchainCall('100', '9900')], mergedPrs: 1 }), p2Config({ mints: {}, trustedApprovers: [] }));
    const body = await api.ledger();
    expect(body.status.inferenceMode).toBe('mock');
    expect(body.inference).toEqual({
      servedCalls: 1,
      servedByScheme: { onchain: 1, balance: 0 },
      inferenceMicro: null,
      networkFeesMicro: null,
      costPerServedCallMicro: null,
      costPerMergedPrMicro: null,
    });
  });
});
