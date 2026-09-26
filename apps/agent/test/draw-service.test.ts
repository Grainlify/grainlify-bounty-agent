// Applications, eligibility and the draw, against Postgres. Needs TEST_DATABASE_URL.

import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase } from '../../../packages/db/src/testing.ts';
import { DrawService } from '../src/draw-service.ts';
import { FakeGitHub } from './fake-github.ts';

const dbUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!dbUrl)('applications and the draw', () => {
  let db: pg.Pool;
  let gh: FakeGitHub;
  let svc: DrawService;
  let now = new Date('2026-09-27T10:00:00Z');
  let repoId: number;

  const newBounty = async (over: { status?: string; waived?: string[]; isTest?: boolean } = {}) => {
    const id = randomUUID();
    await db.query(
      `INSERT INTO bounties (id, repo_id, issue_number, amount_minor, currency, mint, network, status, created_by, is_test, waived_eligibility_rules)
       VALUES ($1,$2,$3,1000000,'USDC','mint','solana-mainnet',$4,'test',$5,$6)`,
      [id, repoId, Math.floor(Math.random() * 100000), over.status ?? 'posted', over.isTest ?? false, over.waived ?? []],
    );
    return id;
  };

  const person = async (id: number, login: string, opts: { wallet?: boolean; ageDays?: number; perm?: string } = {}) => {
    gh.users.set(login.toLowerCase(), {
      id, login, type: 'User',
      createdAt: new Date(now.getTime() - (opts.ageDays ?? 400) * 86_400_000),
    });
    if (opts.perm) gh.permissions.set(`grainlify/test-repo:${login.toLowerCase()}`, opts.perm as never);
    await db.query(`INSERT INTO contributors (github_user_id, login) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, login]);
    if (opts.wallet !== false) {
      await db.query(
        `INSERT INTO wallet_links (github_user_id, address, message, signature, source) VALUES ($1,$2,'m','s','test')`,
        [id, `wallet-${id}`],
      );
    }
    return { id, login };
  };

  beforeAll(async () => {
    db = await freshDatabase(dbUrl!, 'test_draw_service');
  });
  beforeEach(async () => {
    now = new Date('2026-09-27T10:00:00Z');
    gh = new FakeGitHub();
    svc = new DrawService({ db, gh, now: () => now });
    await db.query('TRUNCATE bounty_assignments, bounty_draws, bounty_applications, wallet_links, bounties, contributors, bounty_config CASCADE');
    await db.query(`INSERT INTO repos (owner, name, enabled) VALUES ('Grainlify','test-repo', true)
                    ON CONFLICT (owner, name) DO UPDATE SET enabled = true RETURNING id`);
    repoId = (await db.query<{ id: string }>(`SELECT id FROM repos WHERE owner='Grainlify' AND name='test-repo'`)).rows[0]!.id as unknown as number;
  });
  afterAll(async () => {
    await db?.end();
  });

  // ------------------------------------------------------------------ config

  it('an empty settings table still produces a working programme', async () => {
    // Defaults live in code. A wiped settings table must be a reversion, not
    // an outage.
    const cfg = await svc.config();
    expect(cfg.application_window_hours).toBe('6');
    expect(cfg.block_org_members).toBe('true');
    expect(cfg.weight_fit_strong).toBe('2.0');
  });

  it('an admin override wins, and resetting restores the coded default', async () => {
    expect(await svc.setSetting('application_window_hours', '12', 'Jagadeeshftw')).toMatchObject({ ok: true });
    expect((await svc.config()).application_window_hours).toBe('12');
    const view = (await svc.settings()).find((s) => s.key === 'application_window_hours')!;
    expect(view).toMatchObject({ value: '12', default: '6', overridden: true, updatedBy: 'Jagadeeshftw' });

    await svc.resetSetting('application_window_hours');
    expect((await svc.config()).application_window_hours).toBe('6');
  });

  it('refuses a setting outside its range, and an unknown key', async () => {
    expect(await svc.setSetting('application_window_hours', '0', 'x')).toMatchObject({ ok: false });
    expect(await svc.setSetting('application_window_hours', 'six', 'x')).toMatchObject({ ok: false });
    expect(await svc.setSetting('auto_draw_enabled', 'maybe', 'x')).toMatchObject({ ok: false });
    expect(await svc.setSetting('drop_all_the_checks', 'true', 'x')).toMatchObject({ ok: false });
  });

  it('the window length an admin sets is the window a new bounty gets', async () => {
    await svc.setSetting('application_window_hours', '2', 'admin');
    const b = await newBounty();
    const w = await svc.openApplications(b);
    expect(new Date(w.closesAt).getTime() - new Date(w.opensAt).getTime()).toBe(2 * 3600_000);
  });

  it('opening a window twice does not move the close time', async () => {
    // A redelivered webhook must not quietly extend a window.
    const b = await newBounty();
    const first = await svc.openApplications(b);
    now = new Date(now.getTime() + 60 * 60_000);
    expect((await svc.openApplications(b)).closesAt).toBe(first.closesAt);
  });

  // ------------------------------------------------------------- eligibility

  it('accepts an eligible applicant and does not tell them the pool size', async () => {
    const b = await newBounty();
    await svc.openApplications(b);
    const p = await person(1, 'octo');
    const r = await svc.apply({ bountyId: b, githubUserId: p.id, githubLogin: p.login });
    expect(r).toMatchObject({ ok: true, status: 201 });
    expect(JSON.stringify(r)).not.toMatch(/poolSize"\s*:\s*\d/);
  });

  it('refuses a maintainer of the bounty repo, and says so', async () => {
    const b = await newBounty();
    await svc.openApplications(b);
    const p = await person(2, 'maint', { perm: 'write' });
    const r = await svc.apply({ bountyId: b, githubUserId: p.id, githubLogin: p.login });
    expect(r).toMatchObject({ ok: false, error: 'org_member' });
    expect((r as { detail: string }).detail).toContain('maintainers cannot win their own bounties');
  });

  it('a bounty may waive the org-member rule, and only that rule', async () => {
    const b = await newBounty({ waived: ['block_org_members'] });
    await svc.openApplications(b);
    const p = await person(3, 'maint2', { perm: 'admin' });
    expect(await svc.apply({ bountyId: b, githubUserId: p.id, githubLogin: p.login })).toMatchObject({ ok: true });
  });

  it('a waiver for anything else is ignored: the list is an allowlist, not a free-text switch', async () => {
    const b = await newBounty({ waived: ['no_linked_wallet', 'account_too_new', 'block_org_members'] });
    await svc.openApplications(b);
    // Org member: waived, so this rule passes. No wallet: NOT waivable, so it
    // still refuses even though the column names it.
    const p = await person(4, 'sneaky', { wallet: false, perm: 'admin' });
    expect(await svc.apply({ bountyId: b, githubUserId: p.id, githubLogin: p.login })).toMatchObject({ ok: false, error: 'no_linked_wallet' });
  });

  it('refuses someone with no linked wallet, because a winner must be payable', async () => {
    const b = await newBounty();
    await svc.openApplications(b);
    const p = await person(5, 'nowallet', { wallet: false });
    expect(await svc.apply({ bountyId: b, githubUserId: p.id, githubLogin: p.login })).toMatchObject({ ok: false, error: 'no_linked_wallet' });
  });

  it('refuses an account younger than the configured minimum', async () => {
    const b = await newBounty();
    await svc.openApplications(b);
    const p = await person(6, 'fresh', { ageDays: 3 });
    expect(await svc.apply({ bountyId: b, githubUserId: p.id, githubLogin: p.login })).toMatchObject({ ok: false, error: 'account_too_new' });
  });

  it('fails closed when the account cannot be read at all', async () => {
    const b = await newBounty();
    await svc.openApplications(b);
    await person(7, 'unreadable');
    gh.failUserLookup = true;
    expect(await svc.apply({ bountyId: b, githubUserId: 7, githubLogin: 'unreadable' })).toMatchObject({ ok: false, error: 'account_age_unknown' });
  });

  it('stores every refusal with its reason, so the applicant can be told which rule', async () => {
    const b = await newBounty();
    await svc.openApplications(b);
    await person(8, 'nope', { wallet: false });
    await svc.apply({ bountyId: b, githubUserId: 8, githubLogin: 'nope' });
    const v = await svc.applicationsFor(b);
    expect(v).toMatchObject({ total: 1, eligible: 0, refused: 1 });
    expect(v.applications[0]).toMatchObject({ status: 'rejected_gate', gateFailureReason: 'no_linked_wallet' });
  });

  it('lets a refused applicant back in once they fix the reason', async () => {
    const b = await newBounty();
    await svc.openApplications(b);
    await person(9, 'fixable', { wallet: false });
    expect(await svc.apply({ bountyId: b, githubUserId: 9, githubLogin: 'fixable' })).toMatchObject({ ok: false });
    await db.query(`INSERT INTO wallet_links (github_user_id, address, message, signature, source) VALUES (9,'w9','m','s','test')`);
    expect(await svc.apply({ bountyId: b, githubUserId: 9, githubLogin: 'fixable' })).toMatchObject({ ok: true });
  });

  it('refuses a second application from the same person', async () => {
    const b = await newBounty();
    await svc.openApplications(b);
    await person(10, 'twice');
    await svc.apply({ bountyId: b, githubUserId: 10, githubLogin: 'twice' });
    expect(await svc.apply({ bountyId: b, githubUserId: 10, githubLogin: 'twice' })).toMatchObject({ ok: false, error: 'already_applied' });
  });

  it('refuses someone already holding a bounty', async () => {
    const held = await newBounty();
    const wanted = await newBounty();
    await svc.openApplications(wanted);
    await person(11, 'busy');
    await db.query(
      `INSERT INTO bounty_assignments (bounty_id, github_user_id, github_login, status, stale_at) VALUES ($1,11,'busy','active', now() + interval '3 days')`,
      [held],
    );
    expect(await svc.apply({ bountyId: wanted, githubUserId: 11, githubLogin: 'busy' })).toMatchObject({ ok: false, error: 'holding_another_bounty' });
  });

  it('refuses once the window has closed', async () => {
    const b = await newBounty();
    await svc.openApplications(b);
    await person(12, 'late');
    now = new Date(now.getTime() + 7 * 3600_000);
    expect(await svc.apply({ bountyId: b, githubUserId: 12, githubLogin: 'late' })).toMatchObject({ ok: false, error: 'applications_closed' });
  });

  it('refuses a bounty that is not posted', async () => {
    const b = await newBounty({ status: 'paid' });
    await person(13, 'toolate');
    expect(await svc.apply({ bountyId: b, githubUserId: 13, githubLogin: 'toolate' })).toMatchObject({ ok: false, error: 'not_open' });
  });

  // -------------------------------------------------------------- the draw

  const poolOf = async (bountyId: string, n: number, from = 100) => {
    for (let i = 0; i < n; i++) {
      const p = await person(from + i, `applicant${from + i}`);
      await svc.apply({ bountyId, githubUserId: p.id, githubLogin: p.login });
    }
  };

  it('assigns exactly one winner and records the pool, seed and config', async () => {
    const b = await newBounty();
    await svc.openApplications(b);
    await poolOf(b, 4);
    const r = await svc.runDrawFor(b, { triggeredBy: 'Jagadeeshftw' });
    expect('drawId' in r).toBe(true);
    const d = r as Extract<typeof r, { drawId: string }>;
    expect(d.poolSize).toBe(4);
    expect(d.winner).not.toBeNull();
    expect(d.assignmentId).not.toBeNull();
    expect(d.pool.every((c) => c.tickets > 0)).toBe(true);
    expect(d.pool.reduce((s, c) => s + c.share, 0)).toBeCloseTo(1, 6);

    const stored = await svc.drawsFor(b);
    expect(stored[0]).toMatchObject({ poolSize: 4, simulation: false, triggeredBy: 'Jagadeeshftw' });
    // The config in force is stored with the draw, so a later weight change
    // does not make an old result unexplainable.
    expect((stored[0]!.configSnapshot as Record<string, string>).weight_fit_strong).toBe('2.0');
  });

  it('marks the winner won and everybody else lost', async () => {
    const b = await newBounty();
    await svc.openApplications(b);
    await poolOf(b, 3, 200);
    const d = (await svc.runDrawFor(b, { triggeredBy: 'admin' })) as { winner: { githubLogin: string } };
    const v = await svc.applicationsFor(b);
    expect(v.applications.filter((a) => a.status === 'won')).toHaveLength(1);
    expect(v.applications.filter((a) => a.status === 'lost')).toHaveLength(2);
    expect(v.applications.find((a) => a.status === 'won')!.githubLogin).toBe(d.winner.githubLogin);
  });

  it('a simulation runs the real pool and assigns nobody', async () => {
    const b = await newBounty();
    await svc.openApplications(b);
    await poolOf(b, 3, 300);
    const d = (await svc.runDrawFor(b, { triggeredBy: 'admin', simulate: true })) as { poolSize: number; winner: null; assignmentId: null };
    expect(d.poolSize).toBe(3);
    expect(d.winner).toBeNull();
    expect(d.assignmentId).toBeNull();
    expect((await db.query(`SELECT 1 FROM bounty_assignments WHERE bounty_id = $1`, [b])).rowCount).toBe(0);
    // Applications are untouched, so the real draw still has its pool.
    expect((await svc.applicationsFor(b)).applications.every((a) => a.status === 'applied')).toBe(true);
  });

  it('refuses to draw a bounty that already has a live assignment', async () => {
    const b = await newBounty();
    await svc.openApplications(b);
    await poolOf(b, 2, 400);
    await svc.runDrawFor(b, { triggeredBy: 'admin' });
    expect(await svc.runDrawFor(b, { triggeredBy: 'admin' })).toMatchObject({ error: 'already_assigned' });
  });

  it('a simulation is still allowed while a bounty is assigned', async () => {
    const b = await newBounty();
    await svc.openApplications(b);
    await poolOf(b, 2, 500);
    await svc.runDrawFor(b, { triggeredBy: 'admin' });
    expect(await svc.runDrawFor(b, { triggeredBy: 'admin', simulate: true })).toMatchObject({ simulation: true });
  });

  it('a pool of nobody produces no winner and no assignment', async () => {
    const b = await newBounty();
    await svc.openApplications(b);
    const d = (await svc.runDrawFor(b, { triggeredBy: 'admin' })) as { winner: null; noWinnerReason: string };
    expect(d.winner).toBeNull();
    expect(d.noWinnerReason).toBe('no applicants');
  });

  it('a newcomer carries the first-application weight and a completer carries theirs', async () => {
    const b = await newBounty();
    await svc.openApplications(b);
    const done = await newBounty();
    await person(600, 'veteran');
    await db.query(
      `INSERT INTO bounty_assignments (bounty_id, github_user_id, github_login, status, stale_at) VALUES ($1,600,'veteran','completed', now())`,
      [done],
    );
    await svc.apply({ bountyId: b, githubUserId: 600, githubLogin: 'veteran' });
    await poolOf(b, 1, 601);

    const d = (await svc.runDrawFor(b, { triggeredBy: 'admin', simulate: true })) as { pool: { githubLogin: string; weights: Record<string, number> }[] };
    const vet = d.pool.find((c) => c.githubLogin === 'veteran')!;
    const newbie = d.pool.find((c) => c.githubLogin === 'applicant601')!;
    expect(vet.weights.prior_completion).toBe(1.5);
    expect(vet.weights.first_ever_application).toBeUndefined();
    expect(newbie.weights.first_ever_application).toBe(1.5);
  });

  // --------------------------------------------------------- the scheduler

  it('draws automatically when a window has closed', async () => {
    const b = await newBounty();
    await svc.openApplications(b);
    await poolOf(b, 2, 700);
    expect(await svc.closeDueWindows()).toMatchObject({ drawn: [], extended: [], skipped: [] });
    now = new Date(now.getTime() + 7 * 3600_000);
    expect((await svc.closeDueWindows()).drawn).toEqual([b]);
    expect((await db.query(`SELECT 1 FROM bounty_assignments WHERE bounty_id = $1`, [b])).rowCount).toBe(1);
  });

  it('does not draw twice for the same bounty', async () => {
    const b = await newBounty();
    await svc.openApplications(b);
    await poolOf(b, 2, 800);
    now = new Date(now.getTime() + 7 * 3600_000);
    await svc.closeDueWindows();
    expect((await svc.closeDueWindows()).drawn).toEqual([]);
  });

  it('extends an empty window rather than leaving the bounty unassignable', async () => {
    const b = await newBounty();
    await svc.openApplications(b);
    now = new Date(now.getTime() + 7 * 3600_000);
    expect((await svc.closeDueWindows()).extended).toEqual([b]);
    const row = await db.query<{ window_extensions: number; applications_close_at: Date }>(
      `SELECT window_extensions, applications_close_at FROM bounties WHERE id = $1`, [b],
    );
    expect(row.rows[0]!.window_extensions).toBe(1);
    expect(new Date(row.rows[0]!.applications_close_at).getTime()).toBeGreaterThan(now.getTime());
  });

  it('stops extending after the configured limit', async () => {
    await svc.setSetting('max_window_extensions', '1', 'admin');
    const b = await newBounty();
    await svc.openApplications(b);
    now = new Date(now.getTime() + 7 * 3600_000);
    expect((await svc.closeDueWindows()).extended).toEqual([b]);
    now = new Date(now.getTime() + 7 * 3600_000);
    expect(await svc.closeDueWindows()).toMatchObject({ extended: [], skipped: [b] });
  });

  it('the automatic draw can be switched off entirely from the dashboard', async () => {
    await svc.setSetting('auto_draw_enabled', 'false', 'admin');
    const b = await newBounty();
    await svc.openApplications(b);
    await poolOf(b, 2, 900);
    now = new Date(now.getTime() + 7 * 3600_000);
    expect(await svc.closeDueWindows()).toMatchObject({ drawn: [], extended: [] });
    // And a manual draw still works while automatic is off.
    expect(await svc.runDrawFor(b, { triggeredBy: 'admin' })).toMatchObject({ triggeredBy: 'admin' });
  });
});
