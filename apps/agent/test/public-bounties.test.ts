// What the public bounties feed says, and - as much - what it does not say.
// Needs TEST_DATABASE_URL.

import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase } from '../../../packages/db/src/testing.ts';
import { p2Config } from '../src/config.ts';
import { poolVisibility, PublicApi } from '../src/public.ts';

const dbUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!dbUrl)('the public bounties feed', () => {
  let db: pg.Pool;
  let api: PublicApi;
  let repoId: number;

  const bounty = async (over: { isTest?: boolean; waived?: string[]; closeAt?: string | null } = {}) => {
    const id = randomUUID();
    await db.query(
      `INSERT INTO bounties (id, repo_id, issue_number, amount_minor, currency, mint, network, status, created_by, is_test, waived_eligibility_rules, applications_open_at, applications_close_at)
       VALUES ($1,$2,$3,1000000,'USDC','mint','solana-mainnet','posted','agent',$4,$5,now(),$6)`,
      [id, repoId, Math.floor(Math.random() * 100000), over.isTest ?? false, over.waived ?? [], over.closeAt === undefined ? null : over.closeAt],
    );
    return id;
  };

  beforeAll(async () => {
    db = await freshDatabase(dbUrl!, 'test_public_bounties');
    api = new PublicApi(db, p2Config({ mints: {}, trustedApprovers: [] }));
  });
  beforeEach(async () => {
    await db.query('TRUNCATE bounty_assignments, bounty_draws, bounty_applications, bounties CASCADE');
    await db.query(`INSERT INTO repos (owner, name, enabled) VALUES ('Grainlify','test-repo', true) ON CONFLICT (owner,name) DO UPDATE SET enabled = true`);
    repoId = (await db.query<{ id: string }>(`SELECT id FROM repos WHERE owner='Grainlify' AND name='test-repo'`)).rows[0]!.id as unknown as number;
  });
  afterAll(async () => {
    await db?.end();
  });

  it('marks a test bounty as one', async () => {
    // A test bounty that looked real would be worse than no test at all:
    // contributors would apply to it.
    const id = await bounty({ isTest: true, waived: ['block_org_members'] });
    const [b] = await api.bounties(id);
    expect(b).toMatchObject({ isTest: true, waivedRules: ['block_org_members'] });
  });

  it('says whether the application window is open, closed, or never opened', async () => {
    const never = await bounty({ closeAt: null });
    expect((await api.bounties(never))[0]).toMatchObject({ applicationState: 'none', applicationsCloseAt: null });

    const open = await bounty({ closeAt: new Date(Date.now() + 3600_000).toISOString() });
    expect((await api.bounties(open))[0]!.applicationState).toBe('open');

    const closed = await bounty({ closeAt: new Date(Date.now() - 3600_000).toISOString() });
    expect((await api.bounties(closed))[0]!.applicationState).toBe('closed');
  });

  it('names who holds a bounty, and drops the name once the assignment ends', async () => {
    const id = await bounty({ closeAt: new Date(Date.now() - 1000).toISOString() });
    await db.query(
      `INSERT INTO bounty_assignments (bounty_id, github_user_id, github_login, status, stale_at) VALUES ($1, 42, 'winner', 'active', now() + interval '3 days')`,
      [id],
    );
    expect((await api.bounties(id))[0]).toMatchObject({ assignedTo: 'winner' });
    await db.query(`UPDATE bounty_assignments SET status = 'released_stale' WHERE bounty_id = $1`, [id]);
    expect((await api.bounties(id))[0]).toMatchObject({ assignedTo: null });
  });

  it('never publishes who applied, only how many, and coarsely', async () => {
    // A precise live count makes the draw something to time: apply late, when
    // the odds look best. Names are never published at all.
    const id = await bounty({ closeAt: new Date(Date.now() + 3600_000).toISOString() });
    for (let i = 0; i < 5; i++) {
      await db.query(
        `INSERT INTO bounty_applications (bounty_id, github_user_id, github_login, status) VALUES ($1,$2,$3,'applied')`,
        [id, 900 + i, `person${i}`],
      );
    }
    const [b] = await api.bounties(id);
    expect(JSON.stringify(b)).not.toContain('person0');
    expect(b).toMatchObject({ applicantBucket: 'many', applicantCount: null });
  });

  it('bands the pool while the window is open', async () => {
    const empty = await bounty({ closeAt: new Date(Date.now() + 3600_000).toISOString() });
    expect((await api.bounties(empty))[0]).toMatchObject({ applicantBucket: 'none', applicantCount: null });

    const few = await bounty({ closeAt: new Date(Date.now() + 3600_000).toISOString() });
    for (let i = 0; i < 3; i++) {
      await db.query(`INSERT INTO bounty_applications (bounty_id, github_user_id, github_login, status) VALUES ($1,$2,$3,'applied')`, [few, 700 + i, `p${i}`]);
    }
    expect((await api.bounties(few))[0]).toMatchObject({ applicantBucket: 'few', applicantCount: null });
  });

  it('releases the exact count once the window has closed', async () => {
    // Settled pool: precision can no longer steer anyone, and by then the
    // count is what makes a result checkable.
    const id = await bounty({ closeAt: new Date(Date.now() - 1000).toISOString() });
    for (let i = 0; i < 3; i++) {
      await db.query(`INSERT INTO bounty_applications (bounty_id, github_user_id, github_login, status) VALUES ($1,$2,$3,'applied')`, [id, 800 + i, `q${i}`]);
    }
    expect((await api.bounties(id))[0]).toMatchObject({ applicantCount: 3, applicantBucket: null });
  });

  it('respects the visibility setting an admin chose', async () => {
    await db.query(`INSERT INTO bounty_config (key, value, updated_by) VALUES ('applicant_count_visibility','hidden','admin')
                    ON CONFLICT (key) DO UPDATE SET value = 'hidden'`);
    const id = await bounty({ closeAt: new Date(Date.now() + 3600_000).toISOString() });
    await db.query(`INSERT INTO bounty_applications (bounty_id, github_user_id, github_login, status) VALUES ($1,1,'x','applied')`, [id]);
    expect((await api.bounties(id))[0]).toMatchObject({ applicantBucket: null, applicantCount: null });
    await db.query(`DELETE FROM bounty_config WHERE key = 'applicant_count_visibility'`);
  });
});

describe('what to publish about a pool', () => {
  const open = new Date(Date.now() + 3600_000);
  const shut = new Date(Date.now() - 1000);

  it('bands three ways and no more', () => {
    // More bands means more precision, which is what bucketing removes.
    expect(poolVisibility(0, 'bucketed', open).applicantBucket).toBe('none');
    expect(poolVisibility(1, 'bucketed', open).applicantBucket).toBe('few');
    expect(poolVisibility(4, 'bucketed', open).applicantBucket).toBe('few');
    expect(poolVisibility(5, 'bucketed', open).applicantBucket).toBe('many');
    expect(poolVisibility(500, 'bucketed', open).applicantBucket).toBe('many');
  });

  it('a closed window overrides every setting, including hidden', () => {
    expect(poolVisibility(7, 'hidden', shut)).toMatchObject({ applicantCount: 7 });
    expect(poolVisibility(7, 'bucketed', shut)).toMatchObject({ applicantCount: 7, applicantBucket: null });
  });

  it('a bounty with no window at all publishes nothing', () => {
    expect(poolVisibility(3, 'bucketed', null)).toMatchObject({ applicantBucket: 'few', applicantCount: null });
  });
});
