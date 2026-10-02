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
    await db.query('TRUNCATE bounty_assignments, bounty_draws, bounty_applications, bounties, audit_log CASCADE');
    await db.query(`INSERT INTO repos (owner, name, enabled, bounties_enabled, registered_project) VALUES ('Grainlify','test-repo', true, true, true)
                    ON CONFLICT (owner,name) DO UPDATE SET enabled = true, bounties_enabled = true, registered_project = true`);
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

  it('publishes every real draw, unassign and reopening, in order, without an unassign\'s reason', async () => {
    // Steering in plain sight: a maintainer who keeps unassigning and
    // redrawing until somebody they prefer wins does it on the public record.
    const id = await bounty({ closeAt: new Date(Date.now() - 1000).toISOString() });
    const at = (m: number) => new Date(Date.UTC(2026, 9, 1, 10, m)).toISOString();
    await db.query(`INSERT INTO bounty_draws (bounty_id, seed, winner_login, triggered_by, created_at) VALUES ($1, 1, 'first', 'automatic', $2)`, [id, at(0)]);
    await db.query(
      `INSERT INTO bounty_assignments (bounty_id, github_user_id, github_login, status, stale_at, released_at, released_by, release_reason)
       VALUES ($1, 42, 'first', 'released_voluntary', $2, $2, 'maint', 'a private reason for the contributor')`, [id, at(5)]);
    await db.query(`INSERT INTO bounty_draws (bounty_id, seed, winner_login, triggered_by, is_simulation, created_at) VALUES ($1, 2, 'nobody', 'maint', true, $2)`, [id, at(7)]);
    await db.query(`INSERT INTO bounty_draws (bounty_id, seed, winner_login, triggered_by, created_at) VALUES ($1, 3, 'second', 'maint', $2)`, [id, at(9)]);
    // A deadline release is not somebody's decision, and is not listed as one.
    await db.query(
      `INSERT INTO bounty_assignments (bounty_id, github_user_id, github_login, status, stale_at, released_at, counts_as_abandon)
       VALUES ($1, 43, 'quiet', 'released_stale', $2, $2, true)`, [id, at(11)]);

    // Back to open after the holder's pull request closed unmerged.
    await db.query(
      `INSERT INTO audit_log (actor, action, subject, detail, at) VALUES ('agent','bounty.reopened',$1,$2,$3)`,
      [id, JSON.stringify({ reason: 'pull request closed without merging', prNumber: 37, contributor: 'second', holder: 'second' }), at(10)]);
    // Another bounty's reopening is not this one's.
    await db.query(`INSERT INTO audit_log (actor, action, subject, detail) VALUES ('agent','bounty.reopened',$1,'{}')`, [randomUUID()]);

    const h = (await api.bounties(id))[0]!.history;
    expect(h).toEqual([
      { kind: 'draw', at: at(0), by: 'automatic', drawn: 'first' },
      { kind: 'unassign', at: at(5), by: 'maint', contributor: 'first' },
      { kind: 'draw', at: at(9), by: 'maint', drawn: 'second' },
      { kind: 'reopened', at: at(10), by: 'agent', reason: 'pull request closed without merging', prNumber: 37, contributor: 'second' },
    ]);
    expect(JSON.stringify(h)).not.toContain('private reason');
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

describe.skipIf(!dbUrl)('the published rules', () => {
  // Reuses this file's database rather than creating a second. Every
  // CREATE DATABASE competes with the others running in parallel, and two
  // unrelated files were timing out at five seconds because of it.
  let db2: pg.Pool;
  let api2: PublicApi;

  beforeAll(async () => {
    db2 = await freshDatabase(dbUrl!, 'test_public_bounties_rules');
    api2 = new PublicApi(db2, p2Config({ mints: {}, trustedApprovers: [] }));
  });
  afterAll(async () => {
    await db2?.end();
  });

  it('publishes every weight with its value and its coded default', async () => {
    const r = await api2.rules();
    const byKey = Object.fromEntries(r.settings.map((s) => [s.key, s]));
    expect(byKey.weight_fit_strong).toMatchObject({ value: '2.0', default: '2.0', overridden: false });
    expect(byKey.weight_fit_plausible).toMatchObject({ value: '1.0' });
    expect(byKey.weight_fit_weak).toMatchObject({ value: '0.25' });
    expect(byKey.weight_first_ever_application).toMatchObject({ value: '1.5' });
    expect(byKey.weight_per_abandon).toMatchObject({ value: '0.5' });
    expect(byKey.application_window_hours).toMatchObject({ value: '6' });
  });

  it('shows an override as an override, with who changed it', async () => {
    // A weight that moved with no name against it is what makes a result
    // arguable rather than answerable.
    await db2.query(`INSERT INTO bounty_config (key, value, updated_by) VALUES ('weight_fit_strong','3.0','Jagadeeshftw')
                     ON CONFLICT (key) DO UPDATE SET value = '3.0', updated_by = 'Jagadeeshftw'`);
    const r = await api2.rules();
    const s = r.settings.find((x) => x.key === 'weight_fit_strong')!;
    expect(s).toMatchObject({ value: '3.0', default: '2.0', overridden: true, updatedBy: 'Jagadeeshftw' });
    expect(s.updatedAt).not.toBeNull();
    await db2.query(`DELETE FROM bounty_config WHERE key = 'weight_fit_strong'`);
  });

  it('publishes the prior-completion cap and says it is not a setting', async () => {
    const r = await api2.rules();
    expect(r.structural.priorCompletionCap).toBe(2);
    expect(r.structural.priorCompletionCapNote).toContain('not a setting');
    // It must not appear among the editable settings, or the page would be
    // promising something a config edit could quietly undo.
    expect(r.settings.some((s) => s.key.includes('prior_completion_cap'))).toBe(false);
  });

  it('names what the draw can never read, which is the claim people check', async () => {
    const r = await api2.rules();
    expect(r.structural.neverWeighted).toEqual(
      expect.arrayContaining(['follower count', 'stars', 'merge rate', 'total pull request count', 'how well the application is written']),
    );
    expect(r.structural.neverWeightedNote).toContain('no code path');
  });

  it('answers with no overrides stored, because defaults live in code', async () => {
    // Was creating a whole database to assert this. That is the same claim as
    // "the settings table is empty", and spinning one up mid-test added a
    // CREATE/DROP to a parallel run that made two unrelated files flaky.
    await db2.query('TRUNCATE bounty_config');
    const r = await api2.rules();
    expect(r.settings.every((s) => !s.overridden)).toBe(true);
    expect(r.settings.length).toBeGreaterThan(10);
  });
});
