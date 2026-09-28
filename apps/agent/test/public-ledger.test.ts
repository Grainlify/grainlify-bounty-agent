// The ledger's headline figure: what a served call actually costs, and which
// parts of that are not yet knowable. Needs TEST_DATABASE_URL.

import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase } from '../../../packages/db/src/testing.ts';
import { p2Config } from '../src/config.ts';
import { PublicApi } from '../src/public.ts';

const dbUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!dbUrl)('the ledger inference costs', () => {
  let db: pg.Pool;
  let live: PublicApi;
  let mock: PublicApi;
  let repoId: string;

  const call = async (over: {
    scheme?: string | null; paidMicro?: number | null; feeMicro?: number | null; chargedMicro?: number | null;
    usageIn?: number | null; usageOut?: number | null; model?: string; links?: Record<string, unknown>;
  } = {}) => {
    await db.query(
      `INSERT INTO inference_calls (id, purpose, phase, model, path, max_tokens, request_sha256, status, scheme, paid_micro, fee_micro, charged_micro, usage_in, usage_out, links)
       VALUES ($1,'price','P2P3',$2,'/proxy',300,'ab','served',$3,$4,$5,$6,$7,$8,$9)`,
      [
        randomUUID(), over.model ?? 'claude-haiku-4-5', over.scheme === undefined ? 'onchain' : over.scheme,
        over.paidMicro ?? 35, over.feeMicro ?? 2004, over.chargedMicro ?? 6, over.usageIn ?? 10, over.usageOut ?? 5, over.links ?? {},
      ],
    );
  };

  const mergedSubmission = async (issueNumber: number) => {
    const bountyId = randomUUID();
    await db.query(
      `INSERT INTO bounties (id, repo_id, issue_number, amount_minor, currency, mint, network, status, created_by)
       VALUES ($1,$2,$3,1000000,'USDC','mint','solana-mainnet','posted','agent')`,
      [bountyId, repoId, issueNumber],
    );
    await db.query(
      `INSERT INTO submissions (id, bounty_id, pr_number, author_github_user_id, author_login, state, merged_at)
       VALUES ($1,$2,1,42,'winner','merged',now())`,
      [randomUUID(), bountyId],
    );
  };

  beforeAll(async () => {
    db = await freshDatabase(dbUrl!, 'test_public_ledger');
    live = new PublicApi(db, p2Config({ mints: {}, trustedApprovers: [], inferenceMode: 'live' }));
    mock = new PublicApi(db, p2Config({ mints: {}, trustedApprovers: [] }));
  });
  beforeEach(async () => {
    await db.query('TRUNCATE inference_calls, payouts, submissions, bounties, repos CASCADE');
    await db.query(`INSERT INTO repos (owner, name, enabled, bounties_enabled, registered_project) VALUES ('Grainlify','test-repo', true, true, true)`);
    repoId = (await db.query<{ id: string }>(`SELECT id FROM repos WHERE owner='Grainlify' AND name='test-repo'`)).rows[0]!.id;
  });
  afterAll(async () => {
    await db?.end();
  });

  it('splits served calls by scheme, and totals inference against network fees', async () => {
    await call({ scheme: 'onchain', chargedMicro: 6, feeMicro: 2004, usageIn: 10, usageOut: 5 });
    await call({ scheme: 'onchain', chargedMicro: 6, feeMicro: 2004, usageIn: 10, usageOut: 5 });
    await call({ scheme: 'balance', paidMicro: 0, feeMicro: 0, chargedMicro: 5, usageIn: 10, usageOut: 5 });

    const c = (await live.ledger()).inferenceCosts;
    expect(c).toMatchObject({ servedCalls: 3, paidCalls: 2, creditCalls: 1, mergedPrs: 0, listPriceModels: 3 });
    expect(c.inferenceMicro).toBe(17);
    expect(c.feeMicro).toBe(4008);
    expect(c.totalMicro).toBe(4025);
    expect(c.costPerServedCallMicro).toBeCloseTo(4025 / 3, 6);
    // claude-haiku-4-5 lists at 400k in / 2M out per 1M, so
    // (10 * 400000 + 5 * 2000000) / 1e6 = 14 micro per call, 3 calls.
    expect(c.listPriceMicro).toBe(42);
    // No PR has merged, so the per-PR figure is unknowable and must be null, not 0.
    expect(c.perMergedPrMicro).toBeNull();
  });

  it('reports a real zero when a merged PR attracted no spend, distinct from unknown', async () => {
    await mergedSubmission(1);
    // Spend on a different issue: it cannot be attributed to the merged one.
    await call({ links: { repo: 'Grainlify/test-repo', issueNumber: 2 } });

    const c = (await live.ledger()).inferenceCosts;
    expect(c.mergedPrs).toBe(1);
    expect(c.attributedMicro).toBe(0);
    expect(c.perMergedPrMicro).toBe(0);
    expect(c.unattributedMicro).toBe(2010);
  });

  it('attributes spend through the bounty a merged PR served', async () => {
    await mergedSubmission(7);
    await call({ chargedMicro: 6, feeMicro: 2004, links: { repo: 'Grainlify/test-repo', issueNumber: 7 } });

    const c = (await live.ledger()).inferenceCosts;
    expect(c.mergedPrs).toBe(1);
    expect(c.attributedMicro).toBe(2010);
    expect(c.perMergedPrMicro).toBe(2010);
    expect(c.unattributedMicro).toBe(0);
  });

  it('publishes counts but withholds play money while inference is mocked', async () => {
    await call({ chargedMicro: 6, feeMicro: 2004, usageIn: 10, usageOut: 5 });

    const c = (await mock.ledger()).inferenceCosts;
    // The calls happened, so the counts are real; the money is the mock's, so it is not.
    expect(c).toMatchObject({ servedCalls: 1, paidCalls: 1, creditCalls: 0, listPriceModels: 1 });
    expect(c.inferenceMicro).toBeNull();
    expect(c.feeMicro).toBeNull();
    expect(c.totalMicro).toBeNull();
    expect(c.costPerServedCallMicro).toBeNull();
    expect(c.perMergedPrMicro).toBeNull();
    expect(c.listPriceMicro).toBeNull();
  });
});
