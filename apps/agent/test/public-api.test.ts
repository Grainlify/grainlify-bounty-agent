import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { p2Config } from '../src/config.ts';
import { corsHeaders, PublicApi, type PublicLedgerMetrics } from '../src/public.ts';

describe('CORS answers every caller, whatever Origin they send', () => {
  // The wallet card broke because the server withheld the header from a
  // request whose Origin a browser extension had rewritten. It answered 400 --
  // a real reply, correctly formed -- and Chrome then refused to let the page
  // read it, reporting a CORS failure for a request that had succeeded end to
  // end. Nothing this API exposes is authorised by origin, so withholding the
  // header protected nothing and hid a working response.
  const allowed = ['https://grainlify.com'];

  it('echoes an origin it recognises', () => {
    expect(corsHeaders('https://grainlify.com', allowed, 'POST, OPTIONS')['access-control-allow-origin']).toBe('https://grainlify.com');
  });

  it('still answers when the Origin header is missing entirely', () => {
    expect(corsHeaders(undefined, allowed, 'POST, OPTIONS')['access-control-allow-origin']).toBe('*');
  });

  it('still answers an origin it does not recognise', () => {
    // An extension re-issuing the fetch is the real case. It gets a readable
    // reply; it does not get authorisation, which lives in the signatures.
    expect(corsHeaders('chrome-extension://abc', allowed, 'POST, OPTIONS')['access-control-allow-origin']).toBe('*');
  });

  it('always varies on Origin, so a cache cannot serve one caller another answer', () => {
    expect(corsHeaders(undefined, allowed).vary).toBe('Origin');
    expect(corsHeaders('https://grainlify.com', allowed).vary).toBe('Origin');
  });

  it('allows any header on POST routes, not just content-type', () => {
    // An extension that adds one header to the page's fetch makes it a
    // preflighted request. Listing only content-type meant the browser refused
    // to send the real request at all -- reproduced with a single injected
    // header against an otherwise correct call.
    expect(corsHeaders('https://x.test', allowed, 'POST, OPTIONS')['access-control-allow-headers']).toBe('*');
  });
});

describe('PublicApi.ledger() inference cost aggregates and null handling', () => {
  function fakeDb(options: {
    calls?: any[];
    merged?: any[];
    bounties?: any[];
    gates?: any[];
    bountyConfig?: any[];
  } = {}) {
    return {
      query: vi.fn(async (sql: string) => {
        if (/bounty_config/i.test(sql)) {
          return { rows: options.bountyConfig ?? [] };
        }
        if (/FROM bounties/i.test(sql)) {
          return { rows: options.bounties ?? [] };
        }
        if (/FROM payouts/i.test(sql)) {
          return { rows: options.gates ?? [] };
        }
        if (/FROM submissions/i.test(sql)) {
          return { rows: options.merged ?? [] };
        }
        if (/FROM inference_calls/i.test(sql)) {
          const rows = (options.calls ?? []).map((c) => ({
            created_at: new Date().toISOString(),
            ...c,
          }));
          return { rows, rowCount: rows.length };
        }
        return { rows: [] };
      }),
    } as unknown as pg.Pool;
  }

  const cfg = p2Config({ mints: {}, trustedApprovers: [] });

  it('preserves backward compatibility and returns aggregates & metrics with the expected shape', async () => {
    const db = fakeDb();
    const api = new PublicApi(db, cfg);
    const res = await api.ledger();

    // Backward-compatibility: existing properties remain untouched
    expect(res).toHaveProperty('status');
    expect(res).toHaveProperty('totals');
    expect(res).toHaveProperty('budget');
    expect(res).toHaveProperty('events');
    expect(res.totals).toMatchObject({
      bountiesPosted: 0,
      bountiesPaidMainnet: 0,
      bountiesPaidTest: 0,
      inferenceCalls: 0,
      inferenceCeilingMicro: 5_000_000,
    });

    // New aggregate fields exposed on both metrics and aggregates
    expect(res).toHaveProperty('metrics');
    expect(res).toHaveProperty('aggregates');
    expect(res.metrics).toBe(res.aggregates);

    const m = res.metrics;
    expect(m).toHaveProperty('servedCalls');
    expect(m).toHaveProperty('paidCalls');
    expect(m).toHaveProperty('creditCalls');
    expect(m).toHaveProperty('byScheme');
    expect(m).toHaveProperty('inferenceMicro');
    expect(m).toHaveProperty('feeMicro');
    expect(m).toHaveProperty('totalMicro');
    expect(m).toHaveProperty('costPerServedCallMicro');
    expect(m).toHaveProperty('costPerMergedPrMicro');
    expect(m).toHaveProperty('feeSharePct');
    expect(m).toHaveProperty('feeToInferenceRatio');
  });

  it('reports uncomputable figures as null, never 0, when no calls have been served', async () => {
    const db = fakeDb({ calls: [] });
    const api = new PublicApi(db, cfg);
    const { metrics } = await api.ledger();

    expect(metrics.servedCalls).toBe(0);
    expect(metrics.paidCalls).toBe(0);
    expect(metrics.creditCalls).toBe(0);
    expect(metrics.inferenceMicro).toBe(0);
    expect(metrics.feeMicro).toBe(0);
    expect(metrics.totalMicro).toBe(0);

    // CRUCIAL: Uncomputable ratios and averages must be null, never 0
    expect(metrics.costPerServedCallMicro).toBeNull();
    expect(metrics.costPerPaidCallMicro).toBeNull();
    expect(metrics.costPerMergedPrMicro).toBeNull();
    expect(metrics.perMergedMicro).toBeNull();
    expect(metrics.feeSharePct).toBeNull();
    expect(metrics.feeToInferenceRatio).toBeNull();
    expect(metrics.listPriceMicro).toBeNull();
  });

  it('reports uncomputable costPerMergedPr as null when no PR has merged, even if calls exist', async () => {
    const db = fakeDb({
      calls: [
        {
          scheme: 'onchain',
          status: 'served',
          model: 'gpt-oss-120b',
          paid_micro: 9,
          fee_micro: 2004,
          charged_micro: 6,
          usage_in: 10,
          usage_out: 5,
          links: { repo: 'Grainlify/sandbox', issueNumber: 1 },
        },
      ],
      merged: [], // No merged PR yet
    });
    const api = new PublicApi(db, cfg);
    const { metrics } = await api.ledger();

    expect(metrics.servedCalls).toBe(1);
    expect(metrics.paidCalls).toBe(1);
    expect(metrics.totalMicro).toBe(2010);
    // Cost per served call CAN be computed:
    expect(metrics.costPerServedCallMicro).toBe(2010);

    // But cost per merged PR CANNOT be computed because 0 PRs have merged
    // "No merged PR yet" and "zero cost per merged PR" are different claims!
    expect(metrics.mergedPrCount).toBe(0);
    expect(metrics.costPerMergedPrMicro).toBeNull();
    expect(metrics.perMergedMicro).toBeNull();
  });

  it('reports 0 for costPerMergedPr when PR merged with zero cost, distinguishing from no merged PRs', async () => {
    // 1 PR has merged, but served calls for it incurred 0 cost (e.g. balance credit with 0 fee)
    const db = fakeDb({
      calls: [
        {
          scheme: 'balance',
          status: 'served',
          model: 'gpt-oss-120b',
          paid_micro: 0,
          fee_micro: 0,
          charged_micro: 0,
          usage_in: 10,
          usage_out: 5,
          links: { repo: 'Grainlify/sandbox', issueNumber: 1 },
        },
      ],
      merged: [{ owner: 'Grainlify', name: 'sandbox', issue_number: 1 }],
    });
    const api = new PublicApi(db, cfg);
    const { metrics } = await api.ledger();

    expect(metrics.mergedPrCount).toBe(1);
    expect(metrics.attributedMicro).toBe(0);
    // A merged PR with 0 cost computes to 0, NOT null!
    expect(metrics.costPerMergedPrMicro).toBe(0);
    expect(metrics.perMergedMicro).toBe(0);
  });

  it('correctly splits served calls by scheme (on-chain vs surplus credit) and ignores unserved calls', async () => {
    const db = fakeDb({
      calls: [
        {
          scheme: 'onchain',
          status: 'served',
          model: 'gpt-oss-120b',
          paid_micro: 35,
          fee_micro: 2004,
          charged_micro: 10,
          links: null,
        },
        {
          scheme: 'balance',
          status: 'served',
          model: 'gpt-oss-120b',
          paid_micro: 0,
          fee_micro: 0,
          charged_micro: 10,
          links: null,
        },
        {
          scheme: 'onchain',
          status: 'refused_budget', // Ignored because not served
          model: 'gpt-oss-120b',
          paid_micro: null,
          fee_micro: null,
          charged_micro: null,
          links: null,
        },
      ],
    });
    const api = new PublicApi(db, cfg);
    const { metrics } = await api.ledger();

    expect(metrics.servedCalls).toBe(2);
    expect(metrics.paidCalls).toBe(1);
    expect(metrics.creditCalls).toBe(1);
    expect(metrics.byScheme).toEqual({
      onchain: 1,
      balance: 1,
    });
  });

  it('computes inference total, network fee total, headline ~99% fee share, and cost per merged PR', async () => {
    const db = fakeDb({
      calls: [
        // Attributed to merged PR Grainlify/repo#1
        {
          scheme: 'onchain',
          status: 'served',
          model: 'gpt-oss-120b',
          paid_micro: 35,
          fee_micro: 2004,
          charged_micro: 6,
          usage_in: 100,
          usage_out: 50,
          links: { repo: 'Grainlify/repo', issueNumber: 1 },
        },
        // Attributed to merged PR Grainlify/repo#2
        {
          scheme: 'onchain',
          status: 'served',
          model: 'gpt-oss-120b',
          paid_micro: 35,
          fee_micro: 2004,
          charged_micro: 6,
          usage_in: 100,
          usage_out: 50,
          links: { repo: 'Grainlify/repo', issueNumber: 2 },
        },
        // Unattributed call for issue 3 (not merged)
        {
          scheme: 'onchain',
          status: 'served',
          model: 'gpt-oss-120b',
          paid_micro: 35,
          fee_micro: 2004,
          charged_micro: 6,
          usage_in: 100,
          usage_out: 50,
          links: { repo: 'Grainlify/repo', issueNumber: 3 },
        },
      ],
      merged: [
        { owner: 'Grainlify', name: 'repo', issue_number: 1 },
        { owner: 'Grainlify', name: 'repo', issue_number: 2 },
      ],
    });
    const api = new PublicApi(db, cfg);
    const { metrics } = await api.ledger();

    expect(metrics.servedCalls).toBe(3);
    expect(metrics.inferenceMicro).toBe(18); // 3 * 6
    expect(metrics.feeMicro).toBe(6012); // 3 * 2004
    expect(metrics.totalMicro).toBe(6030); // 18 + 6012

    // The headline number: network fees are ~99% of spend!
    expect(metrics.feeSharePct).toBeGreaterThan(99);
    expect(metrics.feeToInferenceRatio).toBeCloseTo(334, 0);

    // Cost per served call
    expect(metrics.costPerServedCallMicro).toBe(2010); // 6030 / 3

    // Cost per merged PR: 2 merged PRs, each attributed 2010 micro
    expect(metrics.mergedPrCount).toBe(2);
    expect(metrics.attributedMicro).toBe(4020);
    expect(metrics.unattributedMicro).toBe(2010);
    expect(metrics.costPerMergedPrMicro).toBe(2010); // 4020 / 2
  });

  it('survives database query failures gracefully with safe empty metrics', async () => {
    const errorDb = {
      query: vi.fn(async (sql: string) => {
        if (/FROM inference_calls/i.test(sql) && /scheme/i.test(sql)) {
          throw new Error('relation "inference_calls" does not exist');
        }
        return { rows: [] };
      }),
    } as unknown as pg.Pool;
    const api = new PublicApi(errorDb, cfg);
    const res = await api.ledger();

    expect(res).toBeDefined();
    expect(res.metrics.servedCalls).toBe(0);
    expect(metricsAreNull(res.metrics)).toBe(true);
  });

  function metricsAreNull(m: PublicLedgerMetrics) {
    return m.costPerServedCallMicro === null && m.costPerMergedPrMicro === null && m.feeSharePct === null;
  }
});

