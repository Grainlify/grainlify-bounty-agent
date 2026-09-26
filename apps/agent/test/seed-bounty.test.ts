// Seeding a bounty: a chosen amount, no inference call, no GitHub comment.
// Needs TEST_DATABASE_URL.

import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase } from '../../../packages/db/src/testing.ts';
import { p2Config } from '../src/config.ts';
import { DrawService } from '../src/draw-service.ts';
import { BountyService } from '../src/service.ts';
import { FakeGitHub } from './fake-github.ts';

const dbUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!dbUrl)('seeding a bounty', () => {
  let db: pg.Pool;
  let gh: FakeGitHub;
  let service: BountyService;
  let draw: DrawService;
  const now = () => new Date('2026-09-27T10:00:00Z');

  beforeAll(async () => {
    db = await freshDatabase(dbUrl!, 'test_seed_bounty');
  });
  beforeEach(async () => {
    gh = new FakeGitHub();
    gh.issues.set('grainlify/sandbox#7', { number: 7, title: 'Fix the flaky assertion', body: '', state: 'open', authorLogin: 'someone' });
    await db.query('TRUNCATE bounty_assignments, bounty_draws, bounty_applications, bounties, bounty_config CASCADE');
    const cfg = p2Config({
      mints: { USDC: { mint: 'MintUSDC', decimals: 6 } },
      trustedApprovers: [],
      network: 'solana-mainnet',
    });
    // x402 left unset on purpose: if seeding ever reaches for inference this
    // throws rather than quietly spending from the lifetime budget.
    service = new BountyService({ db, gh, x402: undefined as never, payoutSigner: {} as never, cfg, now });
    draw = new DrawService({ db, gh, now });
    await service.addRepo('Grainlify/sandbox', true);
  });
  afterAll(async () => {
    await db?.end();
  });

  it('creates a posted bounty at the amount asked for, and says nothing on GitHub', async () => {
    const r = await service.seedBounty({ repo: 'Grainlify/sandbox', issueNumber: 7, amountMinor: 1_000_000n, createdBy: 'Jagadeeshftw' });
    const row = await db.query<{ amount_minor: string; status: string; issue_title: string; is_test: boolean; price_call_id: string | null }>(
      `SELECT amount_minor::text, status, issue_title, is_test, price_call_id FROM bounties WHERE id = $1`, [r.bountyId],
    );
    expect(row.rows[0]).toMatchObject({ amount_minor: '1000000', status: 'posted', issue_title: 'Fix the flaky assertion', is_test: false, price_call_id: null });
    // The normal path announces a bounty on the issue. Seeding must not: a
    // command for setting up records should not post in public as a side
    // effect.
    expect(gh.comments).toHaveLength(0);
  });

  it('marks a test bounty and records exactly what it waives', async () => {
    const r = await service.seedBounty({
      repo: 'Grainlify/sandbox', issueNumber: 7, amountMinor: 1_000_000n, createdBy: 'Jagadeeshftw',
      isTest: true, waivedRules: ['block_org_members'],
    });
    const row = await db.query<{ is_test: boolean; waived_eligibility_rules: string[] }>(
      `SELECT is_test, waived_eligibility_rules FROM bounties WHERE id = $1`, [r.bountyId],
    );
    expect(row.rows[0]).toMatchObject({ is_test: true, waived_eligibility_rules: ['block_org_members'] });
  });

  it('refuses a repo that is not allowlisted', async () => {
    await expect(service.seedBounty({ repo: 'Someone/else', issueNumber: 1, amountMinor: 1_000_000n, createdBy: 'x' }))
      .rejects.toThrow(/not allowlisted/);
  });

  it('falls back to a plain title rather than failing when the issue cannot be read', async () => {
    const r = await service.seedBounty({ repo: 'Grainlify/sandbox', issueNumber: 999, amountMinor: 1_000_000n, createdBy: 'x' });
    expect(r.title).toBe('Issue #999');
  });

  it('opens a window the draw can then close', async () => {
    const r = await service.seedBounty({ repo: 'Grainlify/sandbox', issueNumber: 7, amountMinor: 1_000_000n, createdBy: 'x' });
    const w = await draw.openApplications(r.bountyId);
    expect(new Date(w.closesAt).getTime() - new Date(w.opensAt).getTime()).toBe(6 * 3600_000);
  });
});
