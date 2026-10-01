// Unassigning because somebody decided to, rather than because a clock ran
// out, and moving a deadline on purpose. Needs TEST_DATABASE_URL.
//
// The consequence is the whole difference: the stale sweeper records an
// abandon because the contributor went quiet, and these must not, because they
// did nothing.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase } from '../../../packages/db/src/testing.ts';
import { DrawService } from '../src/draw-service.ts';
import { FakeGitHub } from './fake-github.ts';

const dbUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!dbUrl)('unassigning as a decision', () => {
  let db: pg.Pool;
  let gh: FakeGitHub;
  let svc: DrawService;
  let repoId: number;
  const now = new Date('2026-09-30T12:00:00Z');

  const person = async (id: number, login: string) => {
    gh.users.set(login.toLowerCase(), { id, login, type: 'User', createdAt: new Date(now.getTime() - 400 * 86_400_000) });
    await db.query('INSERT INTO contributors (github_user_id, login) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, login]);
    await db.query(
      `INSERT INTO wallet_links (github_user_id, address, message, signature, source) VALUES ($1,$2,'m','s','test')
       ON CONFLICT DO NOTHING`, [id, `wallet-${id}`]);
  };

  const newBounty = async () => {
    const id = randomUUID();
    await db.query(
      `INSERT INTO bounties (id, repo_id, issue_number, amount_minor, currency, mint, network, status, created_by,
                             applications_open_at, applications_close_at)
       VALUES ($1,$2,$3,1000000,'USDC','mint','solana-mainnet','posted','test',$4,$4)`,
      [id, repoId, Math.floor(Math.random() * 100000), new Date(now.getTime() - 3600_000).toISOString()],
    );
    return id;
  };

  /** An applicant in the pool, with no history. */
  const applied = async (bountyId: string, id: number, login: string) => {
    await person(id, login);
    await db.query(
      `INSERT INTO bounty_applications (bounty_id, github_user_id, github_login, status) VALUES ($1,$2,$3,'applied')`,
      [bountyId, id, login]);
  };

  const assignment = async (bountyId: string) =>
    (await db.query('SELECT * FROM bounty_assignments WHERE bounty_id = $1 ORDER BY created_at DESC', [bountyId])).rows[0];

  beforeAll(async () => {
    db = await freshDatabase(dbUrl!, 'test_unassign_controls');
  });
  beforeEach(async () => {
    gh = new FakeGitHub();
    svc = new DrawService({ db, gh, now: () => now });
    await db.query('TRUNCATE submissions, bounty_deadline_changes, bounty_events, bounty_assignments, bounty_draws, bounty_applications, bounties, wallet_links, contributors, repos, audit_log CASCADE');
    const r = await db.query<{ id: number }>(
      `INSERT INTO repos (owner, name, installation_id, enabled) VALUES ('Grainlify','test-repo',1,true) RETURNING id`);
    repoId = r.rows[0]!.id;
  });
  afterAll(async () => { await db?.end(); });

  async function drawnBounty() {
    const b = await newBounty();
    await applied(b, 1, 'first-dev');
    await applied(b, 2, 'second-dev');
    const r = await svc.runDrawFor(b, { triggeredBy: 'test' });
    expect('drawId' in r).toBe(true);
    return { bountyId: b, winner: (await assignment(b)).github_login as string };
  }

  it('records no abandon, and leaves the draw weight alone', async () => {
    const { bountyId, winner } = await drawnBounty();
    const r = await svc.unassignByDecision({ bountyId, actor: 'Jagadeeshftw', reason: 'Changed the plan on our side.' });
    expect(r.ok).toBe(true);

    const a = await assignment(bountyId);
    expect(a.status).toBe('released_voluntary');
    expect(a.counts_as_abandon).toBe(false);          // the point of the whole feature
    expect(a.released_by).toBe('Jagadeeshftw');
    expect(a.release_reason).toBe('Changed the plan on our side.');

    // The stale sweeper's abandon count is what the draw weights on, and it
    // filters on counts_as_abandon - so this must not appear in it.
    const abandons = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM bounty_assignments
        WHERE github_login = $1 AND status = 'released_stale' AND counts_as_abandon`, [winner]);
    expect(abandons.rows[0]!.n).toBe('0');
  });

  it('puts the application back in the pool, and tells the contributor why', async () => {
    const { bountyId, winner } = await drawnBounty();
    await svc.unassignByDecision({ bountyId, actor: 'admin', reason: 'We need a faster turnaround.' });

    const app = await db.query<{ status: string }>(
      'SELECT status FROM bounty_applications WHERE bounty_id = $1 AND github_login = $2', [bountyId, winner]);
    expect(app.rows[0]!.status).toBe('lost');          // back in the pool, not removed

    const ev = await db.query<{ kind: string; payload: { reason: string } }>(
      "SELECT kind, payload FROM bounty_events WHERE kind = 'bounty_unassigned'");
    expect(ev.rowCount).toBe(1);
    expect(ev.rows[0]!.payload.reason).toBe('We need a faster turnaround.');

    const audit = await db.query("SELECT 1 FROM audit_log WHERE action = 'assignment.unassigned'");
    expect(audit.rowCount).toBe(1);
  });

  it('refuses without a reason', async () => {
    const { bountyId } = await drawnBounty();
    expect(await svc.unassignByDecision({ bountyId, actor: 'admin', reason: '   ' }))
      .toMatchObject({ ok: false, error: 'reason_required' });
  });

  // The funded-bounty rule, applied here too rather than only there.
  it('refuses once a pull request is open, because that takes both sides', async () => {
    const { bountyId } = await drawnBounty();
    await db.query("UPDATE bounty_assignments SET status = 'pr_submitted' WHERE bounty_id = $1", [bountyId]);
    const r = await svc.unassignByDecision({ bountyId, actor: 'admin', reason: 'changed our minds' });
    expect(r).toMatchObject({ ok: false, error: 'pr_open' });
    expect((await assignment(bountyId)).status).toBe('pr_submitted');   // nothing moved
  });

  describe('a pull request from the holder', () => {
    // #35 on 30 September: PR #37 was open, the assignment still said active,
    // and the sweep was on course to warn them and then release them with an
    // abandon. Nobody who opened a PR may ever be counted as abandoning.
    const submit = (bountyId: string, prNumber: number, githubUserId: number, login: string, state = 'open') =>
      db.query(
        `INSERT INTO submissions (id, bounty_id, pr_number, author_github_user_id, author_login, head_sha, state)
         VALUES ($1,$2,$3,$4,$5,'sha',$6)`,
        [randomUUID(), bountyId, prNumber, githubUserId, login, state]);
    const holderId = async (bountyId: string) => Number((await assignment(bountyId)).github_user_id);

    it('is recorded on the assignment by the sweep, with an audit entry', async () => {
      const { bountyId, winner } = await drawnBounty();
      await submit(bountyId, 37, await holderId(bountyId), winner);
      const r = await svc.recordSubmittedPullRequests();
      expect(r).toEqual([{ bountyId, githubLogin: winner, prNumber: 37 }]);
      const a = await assignment(bountyId);
      expect(a.status).toBe('pr_submitted');
      expect(a.qualifying_pr_number).toBe(37);
      const audit = await db.query("SELECT 1 FROM audit_log WHERE action = 'assignment.pr_recorded'");
      expect(audit.rowCount).toBe(1);
      expect(await svc.recordSubmittedPullRequests()).toEqual([]);   // idempotent
    });

    it('gets no expiry warning and is not released when the deadline passes', async () => {
      const { bountyId, winner } = await drawnBounty();
      await submit(bountyId, 37, await holderId(bountyId), winner);
      await db.query(`UPDATE bounty_assignments SET stale_at = $2 WHERE bounty_id = $1`, [bountyId, new Date(now.getTime() + 3600_000).toISOString()]);
      expect((await svc.releaseStaleAssignments()).warned).toEqual([]);

      await db.query(`UPDATE bounty_assignments SET stale_at = $2 WHERE bounty_id = $1`, [bountyId, new Date(now.getTime() - 3600_000).toISOString()]);
      expect((await svc.releaseStaleAssignments()).released).toEqual([]);
      const a = await assignment(bountyId);
      expect(a.status).toBe('pr_submitted');
      expect(a.counts_as_abandon).toBe(false);
    });

    it('is protected even if the assignment was never marked, because the PR is open', async () => {
      // The safety net under the record: the release itself checks for an
      // open PR, so a missed webhook cannot cost anybody an abandon.
      const { bountyId, winner } = await drawnBounty();
      await db.query(`UPDATE bounty_assignments SET stale_at = $2 WHERE bounty_id = $1`, [bountyId, new Date(now.getTime() - 3600_000).toISOString()]);
      await submit(bountyId, 37, await holderId(bountyId), winner);
      const r = await svc.releaseStaleAssignments();
      expect(r.released).toEqual([]);
    });

    it('never costs an abandon, even when the PR was closed unmerged and the deadline then passed', async () => {
      const { bountyId, winner } = await drawnBounty();
      await submit(bountyId, 37, await holderId(bountyId), winner, 'closed');
      await db.query(`UPDATE bounty_assignments SET stale_at = $2 WHERE bounty_id = $1`, [bountyId, new Date(now.getTime() - 3600_000).toISOString()]);
      const r = await svc.releaseStaleAssignments();
      expect(r.released).toHaveLength(1);
      const a = await assignment(bountyId);
      expect(a.status).toBe('released_stale');
      expect(a.counts_as_abandon).toBe(false);
      expect(a.release_reason).toMatch(/closed unmerged/);
    });

    it('does not protect the holder with somebody else\'s PR', async () => {
      const { bountyId } = await drawnBounty();
      await person(99, 'someone-else');
      await submit(bountyId, 38, 99, 'someone-else');
      await db.query(`UPDATE bounty_assignments SET stale_at = $2 WHERE bounty_id = $1`, [bountyId, new Date(now.getTime() - 3600_000).toISOString()]);
      expect((await svc.releaseStaleAssignments()).released).toHaveLength(1);
      expect((await assignment(bountyId)).counts_as_abandon).toBe(true);   // went quiet: unchanged
    });
  });

  describe('closing a bounty by decision', () => {
    it('cancels the bounty so the sweep never draws it again', async () => {
      const { bountyId } = await drawnBounty();
      const r = await svc.closeByDecision({ bountyId, actor: 'Jagadeeshftw', reason: 'Closing this round.' });
      expect(r).toMatchObject({ ok: true, notified: true });

      const b = await db.query<{ status: string }>('SELECT status FROM bounties WHERE id = $1', [bountyId]);
      expect(b.rows[0]!.status).toBe('cancelled');
      const swept = await svc.closeDueWindows();
      expect(swept.drawn).toEqual([]);
      const live = await db.query(
        "SELECT 1 FROM bounty_assignments WHERE bounty_id = $1 AND status IN ('active','pr_submitted')", [bountyId]);
      expect(live.rowCount).toBe(0);
    });

    it('releases the holder as our decision: no abandon, told why, with nothing about a next draw', async () => {
      const { bountyId } = await drawnBounty();
      await svc.closeByDecision({ bountyId, actor: 'Jagadeeshftw', reason: 'Closing this round.' });

      const a = await assignment(bountyId);
      expect(a.status).toBe('released_voluntary');
      expect(a.counts_as_abandon).toBe(false);
      expect(a.released_by).toBe('Jagadeeshftw');

      const ev = await db.query<{ payload: { reason: string; closed?: boolean } }>(
        "SELECT payload FROM bounty_events WHERE kind = 'bounty_unassigned'");
      expect(ev.rows[0]!.payload).toMatchObject({ reason: 'Closing this round.', closed: true });
      const audit = await db.query("SELECT 1 FROM audit_log WHERE action = 'bounty.closed'");
      expect(audit.rowCount).toBe(1);
    });

    it('refuses a bounty with a pull request under review, and leaves it exactly as it was', async () => {
      const { bountyId } = await drawnBounty();
      await db.query("UPDATE bounties SET status = 'in_review' WHERE id = $1", [bountyId]);
      const r = await svc.closeByDecision({ bountyId, actor: 'admin', reason: 'Closing this round.' });
      expect(r).toMatchObject({ ok: false, error: 'not_open' });
      expect((await assignment(bountyId)).status).toBe('active');
      const b = await db.query<{ status: string }>('SELECT status FROM bounties WHERE id = $1', [bountyId]);
      expect(b.rows[0]!.status).toBe('in_review');
    });

    it('refuses an open pull request even on a bounty still marked open', async () => {
      const { bountyId } = await drawnBounty();
      await db.query("UPDATE bounty_assignments SET status = 'pr_submitted' WHERE bounty_id = $1", [bountyId]);
      expect(await svc.closeByDecision({ bountyId, actor: 'admin', reason: 'Closing.' }))
        .toMatchObject({ ok: false, error: 'pr_open' });
      const b = await db.query<{ status: string }>('SELECT status FROM bounties WHERE id = $1', [bountyId]);
      expect(b.rows[0]!.status).toBe('posted');          // rolled back, not half-closed
    });

    it('refuses without a reason', async () => {
      const { bountyId } = await drawnBounty();
      expect(await svc.closeByDecision({ bountyId, actor: 'admin', reason: ' ' }))
        .toMatchObject({ ok: false, error: 'reason_required' });
    });
  });

  it('keeps the person out of the next draw only, then lets them back in', async () => {
    const { bountyId, winner } = await drawnBounty();
    await svc.unassignByDecision({ bountyId, actor: 'admin', reason: 'faster turnaround' });

    // The immediate redraw cannot land on them again.
    const second = await svc.runDrawFor(bountyId, { triggeredBy: 'test' });
    expect('drawId' in second).toBe(true);
    const other = (await assignment(bountyId)).github_login;
    expect(other).not.toBe(winner);

    // The exclusion was consumed by the draw that honoured it.
    const b = await db.query<{ exclude_login_next_draw: string | null }>(
      'SELECT exclude_login_next_draw FROM bounties WHERE id = $1', [bountyId]);
    expect(b.rows[0]!.exclude_login_next_draw).toBeNull();

    // So a LATER redraw of the same bounty can pick them again.
    await svc.unassignByDecision({ bountyId, actor: 'admin', reason: 'again' });
    await db.query('UPDATE bounties SET exclude_login_next_draw = NULL WHERE id = $1', [bountyId]);
    const third = await svc.runDrawFor(bountyId, { triggeredBy: 'test' });
    expect('drawId' in third).toBe(true);
    const pool = await db.query<{ github_login: string }>(
      "SELECT github_login FROM bounty_applications WHERE bounty_id = $1 AND status IN ('applied','lost','won')", [bountyId]);
    expect(pool.rows.map((x) => x.github_login)).toContain(winner);
  });

  it('honours a deadline chosen at draw time', async () => {
    const b = await newBounty();
    await applied(b, 1, 'first-dev');
    await svc.runDrawFor(b, { triggeredBy: 'test', staleHours: 96 });
    const a = await assignment(b);
    const hours = (new Date(a.stale_at).getTime() - now.getTime()) / 3600_000;
    expect(Math.round(hours)).toBe(96);
  });
});

describe.skipIf(!dbUrl)('moving a deadline', () => {
  let db: pg.Pool;
  let svc: DrawService;
  let repoId: number;
  const now = new Date('2026-09-30T12:00:00Z');

  beforeAll(async () => { db = await freshDatabase(dbUrl!, 'test_deadline_control'); });
  beforeEach(async () => {
    svc = new DrawService({ db, gh: new FakeGitHub(), now: () => now });
    await db.query('TRUNCATE bounty_deadline_changes, bounty_events, bounty_assignments, bounties, contributors, repos, audit_log CASCADE');
    const r = await db.query<{ id: number }>(
      `INSERT INTO repos (owner, name, installation_id, enabled) VALUES ('Grainlify','test-repo',1,true) RETURNING id`);
    repoId = r.rows[0]!.id;
  });
  afterAll(async () => { await db?.end(); });

  async function assigned() {
    const id = randomUUID();
    await db.query(
      `INSERT INTO bounties (id, repo_id, issue_number, amount_minor, currency, mint, network, status, created_by)
       VALUES ($1,$2,7,1000000,'USDC','mint','solana-mainnet','posted','test')`, [id, repoId]);
    await db.query('INSERT INTO contributors (github_user_id, login) VALUES (9,\'dev\') ON CONFLICT DO NOTHING');
    await db.query(
      `INSERT INTO bounty_assignments (bounty_id, github_user_id, github_login, status, stale_at)
       VALUES ($1,9,'dev','active',$2)`, [id, new Date(now.getTime() + 24 * 3600_000).toISOString()]);
    return id;
  }

  it('moves it, records the change and tells the contributor', async () => {
    const b = await assigned();
    const to = new Date(now.getTime() + 96 * 3600_000);
    const r = await svc.setAssignmentDeadline({ bountyId: b, newAt: to, actor: 'Jagadeeshftw', reason: 'They asked for more time.' });
    expect(r.ok).toBe(true);

    const a = await db.query<{ stale_at: Date }>('SELECT stale_at FROM bounty_assignments WHERE bounty_id = $1', [b]);
    expect(new Date(a.rows[0]!.stale_at).toISOString()).toBe(to.toISOString());

    // Recorded twice on purpose: the audit log, and the table the
    // contributor's own page reads.
    const ch = await db.query<{ reason: string; changed_by: string }>(
      'SELECT reason, changed_by FROM bounty_deadline_changes');
    expect(ch.rows[0]).toMatchObject({ reason: 'They asked for more time.', changed_by: 'Jagadeeshftw' });
    expect((await db.query("SELECT 1 FROM audit_log WHERE action = 'assignment.deadline_changed'")).rowCount).toBe(1);
    expect((await db.query("SELECT 1 FROM bounty_events WHERE kind = 'bounty_deadline_changed'")).rowCount).toBe(1);
  });

  it('refuses a deadline in the past, and one with no reason', async () => {
    const b = await assigned();
    expect(await svc.setAssignmentDeadline({ bountyId: b, newAt: new Date(now.getTime() - 3600_000), actor: 'a', reason: 'x' }))
      .toMatchObject({ ok: false, error: 'deadline_in_past' });
    expect(await svc.setAssignmentDeadline({ bountyId: b, newAt: new Date(now.getTime() + 3600_000), actor: 'a', reason: '' }))
      .toMatchObject({ ok: false, error: 'reason_required' });
  });

  it('tells the contributor twice if it moves twice, and not at all if it does not move', async () => {
    const b = await assigned();
    const first = new Date(now.getTime() + 48 * 3600_000);
    await svc.setAssignmentDeadline({ bountyId: b, newAt: first, actor: 'a', reason: 'one' });
    await svc.setAssignmentDeadline({ bountyId: b, newAt: first, actor: 'a', reason: 'same again' });
    await svc.setAssignmentDeadline({ bountyId: b, newAt: new Date(now.getTime() + 72 * 3600_000), actor: 'a', reason: 'two' });
    // Keyed to the assignment AND the new value, so the repeat is silent.
    expect((await db.query("SELECT 1 FROM bounty_events WHERE kind = 'bounty_deadline_changed'")).rowCount).toBe(2);
  });
});
