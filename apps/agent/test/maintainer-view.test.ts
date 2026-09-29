// What a maintainer may see, and when. Needs TEST_DATABASE_URL.

import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshDatabase } from '../../../packages/db/src/testing.ts';
import { DrawService, poolVisibilityForMaintainer } from '../src/draw-service.ts';
import { FakeGitHub } from './fake-github.ts';

const dbUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!dbUrl)('the maintainer view of a bounty', () => {
  let db: pg.Pool;
  let gh: FakeGitHub;
  let svc: DrawService;
  let now = new Date('2026-09-27T10:00:00Z');
  let repoId: number;

  const bounty = async (closeAt: string | null) => {
    const id = randomUUID();
    await db.query(
      `INSERT INTO bounties (id, repo_id, issue_number, amount_minor, currency, mint, network, status, created_by, applications_close_at)
       VALUES ($1,$2,$3,1000000,'USDC','m','solana-mainnet','posted','t',$4)`,
      [id, repoId, Math.floor(Math.random() * 100000), closeAt],
    );
    return id;
  };
  const applicant = async (bountyId: string, id: number, login: string, status = 'applied', reason: string | null = null) => {
    await db.query(
      `INSERT INTO bounty_applications (bounty_id, github_user_id, github_login, status, gate_failure_reason) VALUES ($1,$2,$3,$4,$5)`,
      [bountyId, id, login, status, reason],
    );
  };

  beforeAll(async () => {
    db = await freshDatabase(dbUrl!, 'test_maintainer_view');
  });
  beforeEach(async () => {
    now = new Date('2026-09-27T10:00:00Z');
    gh = new FakeGitHub();
    svc = new DrawService({ db, gh, now: () => now });
    await db.query('TRUNCATE bounty_events, bounty_assignments, bounty_draws, bounty_applications, bounties, bounty_config CASCADE');
    await db.query(`INSERT INTO repos (owner, name, enabled, bounties_enabled, registered_project) VALUES ('Grainlify','test-repo', true, true, true)
                    ON CONFLICT (owner,name) DO UPDATE SET enabled = true, bounties_enabled = true, registered_project = true`);
    repoId = (await db.query<{ id: string }>(`SELECT id FROM repos WHERE owner='Grainlify' AND name='test-repo'`)).rows[0]!.id as unknown as number;
  });
  afterAll(async () => {
    await db?.end();
  });

  const open = () => new Date(now.getTime() + 3600_000).toISOString();
  const shut = () => new Date(now.getTime() - 1000).toISOString();

  // The rule the whole design turns on. A maintainer has influence over the
  // repository and therefore over applicants; if they can see who applied
  // while applications are open, people can be leaned on or tipped off.
  it('shows a rough count and NO names while the window is open', async () => {
    const b = await bounty(open());
    for (let i = 0; i < 3; i++) await applicant(b, 600 + i, `person${i}`);

    const v = (await svc.maintainerView(b)) as Record<string, unknown>;
    expect(v).toMatchObject({ windowOpen: true, applicantBucket: 'few', applicantCount: null, applications: null, draw: null });
    expect(JSON.stringify(v)).not.toContain('person0');
  });

  it('will not give an exact count while the window is open, even if the event publishes exact counts', async () => {
    // applicant_count_visibility is about the PUBLIC page. A maintainer has
    // more influence than a passer-by, so the reason to stay coarse applies
    // to them more strongly, not less.
    await svc.setSetting('applicant_count_visibility', 'exact', 'admin');
    const b = await bounty(open());
    await applicant(b, 700, 'someone');
    expect(await svc.maintainerView(b)).toMatchObject({ applicantCount: null, applicantBucket: 'few' });
  });

  it('shows the full list with each gate outcome once the window has closed', async () => {
    const b = await bounty(shut());
    await applicant(b, 800, 'eligible');
    await applicant(b, 801, 'refused', 'rejected_gate', 'no_linked_wallet');

    const v = (await svc.maintainerView(b)) as { applications: { githubLogin: string; gateFailureReason: string | null }[]; applicantCount: number };
    expect(v.applications.map((a) => a.githubLogin).sort()).toEqual(['eligible', 'refused']);
    expect(v.applications.find((a) => a.githubLogin === 'refused')!.gateFailureReason).toBe('no_linked_wallet');
    expect(v.applicantCount).toBe(1);
  });

  it('shows the winner and the ticket breakdown once the draw has run', async () => {
    const b = await bounty(shut());
    await applicant(b, 900, 'alice');
    await applicant(b, 901, 'bob');
    await svc.runDrawFor(b, { triggeredBy: 'admin' });

    const v = (await svc.maintainerView(b)) as { draw: { winnerLogin: string; seed: number; pool: unknown[] } | null };
    expect(v.draw).not.toBeNull();
    expect(['alice', 'bob']).toContain(v.draw!.winnerLogin);
    expect(v.draw!.seed).toBeGreaterThan(0);
    expect(v.draw!.pool).toHaveLength(2);
  });

  it('ignores a simulation: a maintainer sees the draw that assigned somebody', async () => {
    const b = await bounty(shut());
    await applicant(b, 910, 'solo');
    await svc.runDrawFor(b, { triggeredBy: 'admin', simulate: true });
    expect((await svc.maintainerView(b)) as { draw: unknown }).toMatchObject({ draw: null });
  });

  // Nothing here is a handle. A maintainer can look and never touch.
  it('says plainly that a maintainer cannot assign, in every state', async () => {
    const openB = await bounty(open());
    const shutB = await bounty(shut());
    for (const b of [openB, shutB]) {
      expect(await svc.maintainerView(b)).toMatchObject({ canAssign: false, assignmentIsByDraw: true });
    }
  });

  it('refuses a bounty that does not exist rather than returning an empty view', async () => {
    expect(await svc.maintainerView(randomUUID())).toMatchObject({ error: 'no_such_bounty' });
  });

  // The list, as opposed to one bounty. This is what the maintainer tab shows,
  // and it used to be filtered on the client against the caller's Grainlify
  // PROJECTS - a different question from what they maintain, which is why a
  // repository they plainly maintain but have not registered showed nothing.
  it('lists bounties on repositories the caller maintains, by GitHub permission', async () => {
    await bounty(open());
    gh.permissions.set('grainlify/test-repo:maintainer', 'maintain');
    const mine = await svc.bountiesForMaintainer('maintainer');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ repo: 'Grainlify/test-repo' });
  });

  it('does not need the repository to be a registered Grainlify project', async () => {
    // The sandbox is eligible through the test carve-out, not registration.
    // Filtering on registration is what hid it.
    await db.query(`UPDATE repos SET registered_project = false WHERE owner = 'Grainlify'`);
    await bounty(open());
    gh.permissions.set('grainlify/test-repo:maintainer', 'admin');
    expect(await svc.bountiesForMaintainer('maintainer')).toHaveLength(1);
  });

  it('shows nothing to somebody who only reads the repository', async () => {
    await bounty(open());
    gh.permissions.set('grainlify/test-repo:passer-by', 'read');
    expect(await svc.bountiesForMaintainer('passer-by')).toEqual([]);
  });

  it('one repository with three bounties costs one permission call, not three', async () => {
    // The answer is per repository; asking per bounty would spend the rate
    // limit for nothing.
    for (let i = 0; i < 3; i++) await bounty(open());
    const spy = vi.spyOn(gh, 'permission');
    gh.permissions.set('grainlify/test-repo:maintainer', 'write');
    expect(await svc.bountiesForMaintainer('maintainer')).toHaveLength(3);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('what a maintainer is told about an open pool', () => {
  it('bands it, and never gives a number', () => {
    expect(poolVisibilityForMaintainer(0, 'bucketed')).toMatchObject({ applicantBucket: 'none', applicantCount: null });
    expect(poolVisibilityForMaintainer(3, 'bucketed')).toMatchObject({ applicantBucket: 'few', applicantCount: null });
    expect(poolVisibilityForMaintainer(9, 'exact')).toMatchObject({ applicantBucket: 'many', applicantCount: null });
    expect(poolVisibilityForMaintainer(9, 'hidden')).toMatchObject({ applicantBucket: null, applicantCount: null });
  });
});
