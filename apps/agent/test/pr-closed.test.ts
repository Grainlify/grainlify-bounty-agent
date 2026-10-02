// A pull request closed without merging, and the bounty it was for. Needs
// TEST_DATABASE_URL.
//
// #35 on 1 October: PR #37 was closed unmerged, the holder was made live
// again, and the bounty kept saying "PR in review". The draw sweep and apply()
// only act on 'posted', so once the holder's deadline released them the bounty
// was held by nobody and could never be drawn again.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase } from '../../../packages/db/src/testing.ts';
import { p2Config } from '../src/config.ts';
import { DrawService, REOPEN_REASON } from '../src/draw-service.ts';
import { PublicApi } from '../src/public.ts';
import { BountyService } from '../src/service.ts';
import { FakeGitHub } from './fake-github.ts';

const dbUrl = process.env.TEST_DATABASE_URL;
const REPO = 'Grainlify/test-repo';

describe.skipIf(!dbUrl)('a pull request closed without merging', () => {
  let db: pg.Pool;
  let gh: FakeGitHub;
  let draw: DrawService;
  let service: BountyService;
  let api: PublicApi;
  let repoId: number;
  let now = new Date('2026-10-01T16:00:00Z');
  const cfg = p2Config({ mints: {}, trustedApprovers: [] });
  // Closing a pull request buys nothing; anything that tries is a bug here.
  const x402 = { call: async () => { throw new Error('no inference should be bought on a close'); } };

  const person = async (id: number, login: string) => {
    gh.addUser(login, id, '2020-01-01T00:00:00Z');
    await db.query('INSERT INTO contributors (github_user_id, login) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, login]);
  };

  /** A bounty whose window has closed, with two applicants, drawn. */
  const drawnBounty = async (issue: number, o: { fundedBy?: string } = {}) => {
    const id = randomUUID();
    await db.query(
      `INSERT INTO bounties (id, repo_id, issue_number, amount_minor, currency, mint, network, status, created_by,
                             applications_open_at, applications_close_at, funded_by)
       VALUES ($1,$2,$3,1000000,'USDC','mint','solana-mainnet','posted','test',$4,$4,$5)`,
      [id, repoId, issue, new Date(now.getTime() - 3600_000).toISOString(), o.fundedBy ?? null]);
    for (const [uid, login] of [[1, 'holder'], [2, 'other-dev']] as const) {
      await person(uid, login);
      await db.query(`INSERT INTO bounty_applications (bounty_id, github_user_id, github_login, status) VALUES ($1,$2,$3,'applied')`, [id, uid, login]);
    }
    // The holder is fixed rather than drawn, so the test reads the same every run.
    await db.query(`UPDATE bounty_applications SET status = CASE WHEN github_user_id = 1 THEN 'won' ELSE 'lost' END WHERE bounty_id = $1`, [id]);
    await db.query(
      `INSERT INTO bounty_assignments (bounty_id, github_user_id, github_login, status, stale_at)
       VALUES ($1, 1, 'holder', 'active', $2)`,
      [id, new Date(now.getTime() + 2 * 86_400_000).toISOString()]);
    return id;
  };

  /** What the PR-opened webhook leaves behind, without buying the advisory review. */
  const prOpened = async (bountyId: string, n: number, issue: number, author = { id: 1, login: 'holder' }) => {
    gh.pulls.set(gh.key(REPO, n), {
      number: n, state: 'open', merged: false, mergedByLogin: null, mergedAt: null, authorId: author.id, authorLogin: author.login,
      authorType: 'User', headSha: `sha-${n}`, title: `Fix #${issue}`, body: `Closes #${issue}`, closes: [issue], diff: '',
    });
    await db.query(
      `INSERT INTO submissions (id, bounty_id, pr_number, author_github_user_id, author_login, head_sha, state)
       VALUES ($1,$2,$3,$4,$5,$6,'open')`,
      [randomUUID(), bountyId, n, author.id, author.login, `sha-${n}`]);
    await db.query(`UPDATE bounties SET status = 'in_review' WHERE id = $1 AND status = 'posted'`, [bountyId]);
    await draw.recordSubmittedPullRequests();
  };
  const closeUnmerged = (n: number) => Object.assign(gh.pulls.get(gh.key(REPO, n))!, { state: 'closed' });

  const bounty = async (id: string) => (await db.query('SELECT * FROM bounties WHERE id = $1', [id])).rows[0];
  const assignment = async (id: string) =>
    (await db.query('SELECT * FROM bounty_assignments WHERE bounty_id = $1 ORDER BY created_at DESC', [id])).rows[0];
  const reopens = async (id: string) =>
    (await db.query<{ actor: string; detail: Record<string, unknown> }>(
      `SELECT actor, detail FROM audit_log WHERE action = 'bounty.reopened' AND subject = $1 ORDER BY id`, [id])).rows;

  beforeAll(async () => {
    db = await freshDatabase(dbUrl!, 'test_pr_closed');
  });
  beforeEach(async () => {
    now = new Date('2026-10-01T16:00:00Z');
    gh = new FakeGitHub();
    draw = new DrawService({ db, gh, now: () => now });
    service = new BountyService({ db, gh, x402: x402 as never, payoutSigner: {} as never, cfg, now: () => now });
    api = new PublicApi(db, cfg);
    await db.query('TRUNCATE submissions, bounty_events, bounty_assignments, bounty_draws, bounty_applications, bounties, contributors, repos, audit_log CASCADE');
    const r = await db.query<{ id: number }>(
      `INSERT INTO repos (owner, name, installation_id, enabled, bounties_enabled, registered_project)
       VALUES ('Grainlify','test-repo',1,true,true,true) RETURNING id`);
    repoId = r.rows[0]!.id;
  });
  afterAll(async () => { await db?.end(); });

  it('puts the bounty back to open, keeps the holder live on their deadline, and says why in public', async () => {
    const id = await drawnBounty(35);
    const deadline = new Date((await assignment(id)).stale_at).toISOString();
    await prOpened(id, 37, 35);
    expect((await bounty(id)).status).toBe('in_review');
    expect((await assignment(id)).status).toBe('pr_submitted');

    closeUnmerged(37);
    await service.onPullRequestClosed(REPO, 37);

    expect((await bounty(id)).status).toBe('posted');
    const a = await assignment(id);
    expect(a.status).toBe('active');                                  // they can still submit another
    expect(new Date(a.stale_at).toISOString()).toBe(deadline);        // on the deadline they were given

    expect(await reopens(id)).toEqual([{
      actor: 'agent',
      detail: expect.objectContaining({ reason: REOPEN_REASON, prNumber: 37, contributor: 'holder', previousStatus: 'in_review', source: 'webhook' }),
    }]);
    const [pub] = await api.bounties(id);
    expect(pub).toMatchObject({ status: 'posted', assignedTo: 'holder' });
    expect(pub!.history).toEqual([
      { kind: 'reopened', at: expect.any(String), by: 'agent', reason: 'pull request closed without merging', prNumber: 37, contributor: 'holder' },
    ]);
  });

  it('is not stranded: at the deadline the holder is released with no abandon and the pool is drawn again', async () => {
    const id = await drawnBounty(35);
    await prOpened(id, 37, 35);
    closeUnmerged(37);
    await service.onPullRequestClosed(REPO, 37);

    now = new Date(now.getTime() + 3 * 86_400_000);
    const r = await draw.closeDueWindows();
    expect(r.released).toEqual([id]);
    expect(r.drawn).toEqual([id]);

    const released = (await db.query(`SELECT * FROM bounty_assignments WHERE bounty_id = $1 AND status = 'released_stale'`, [id])).rows[0];
    expect(released.counts_as_abandon).toBe(false);
    expect(released.release_reason).toBe('deadline passed after their pull request was closed unmerged');
    expect((await assignment(id)).status).toBe('active');            // whoever the redraw picked
  });

  it('records the reopening once, however often the close is delivered', async () => {
    const id = await drawnBounty(35);
    await prOpened(id, 37, 35);
    closeUnmerged(37);
    await service.onPullRequestClosed(REPO, 37);
    await service.onPullRequestClosed(REPO, 37);
    expect(await reopens(id)).toHaveLength(1);
  });

  it('stays in review while somebody else\'s pull request on it is still open', async () => {
    const id = await drawnBounty(35);
    await prOpened(id, 37, 35);
    await person(3, 'third-dev');
    await prOpened(id, 38, 35, { id: 3, login: 'third-dev' });
    closeUnmerged(37);
    await service.onPullRequestClosed(REPO, 37);

    expect((await bounty(id)).status).toBe('in_review');
    expect((await assignment(id)).status).toBe('active');            // the holder's own PR closed, so they are live
    expect(await reopens(id)).toEqual([]);

    closeUnmerged(38);
    await service.onPullRequestClosed(REPO, 38);
    expect((await bounty(id)).status).toBe('posted');
    expect((await reopens(id))[0]!.detail).toMatchObject({ prNumber: 38, contributor: 'third-dev' });
  });

  it('reopens a funded bounty too, and leaves the next step to its funder', async () => {
    const id = await drawnBounty(36, { fundedBy: 'funder' });
    await prOpened(id, 40, 36);
    closeUnmerged(40);
    await service.onPullRequestClosed(REPO, 40);
    expect((await bounty(id)).status).toBe('posted');               // what the funder's assign and draw need

    // No clock on a funded bounty: nothing is released or drawn by the sweep.
    now = new Date(now.getTime() + 3 * 86_400_000);
    const r = await draw.closeDueWindows();
    expect(r).toMatchObject({ released: [], drawn: [] });
    expect((await assignment(id)).status).toBe('active');
  });

  describe('repairing a bounty already stranded, the way #35 is', () => {
    /** #35 as the deployed code leaves it: closed PR, holder released at their deadline, bounty still in_review. */
    const stranded = async () => {
      const id = await drawnBounty(35);
      await prOpened(id, 37, 35);
      await db.query(`UPDATE submissions SET state = 'closed' WHERE bounty_id = $1`, [id]);
      await db.query(
        `UPDATE bounty_assignments SET status = 'released_stale', released_at = now(), counts_as_abandon = false,
                release_reason = 'deadline passed after their pull request was closed unmerged' WHERE bounty_id = $1`, [id]);
      await db.query(`UPDATE bounty_applications SET status = 'lost' WHERE bounty_id = $1`, [id]);
      closeUnmerged(37);
      return id;
    };

    it('is what the deployed code does today: nothing ever draws it', async () => {
      const id = await stranded();
      const r = await draw.closeDueWindows();
      expect(r.drawn).toEqual([]);
      expect((await bounty(id)).status).toBe('in_review');
    });

    it('reopens it through the same path, on the record, and the sweep then draws from the existing pool', async () => {
      const id = await stranded();
      const r = await draw.reopenAfterClosedPullRequest({ bountyId: id, actor: 'Jagadeeshftw' });
      expect(r).toMatchObject({ reopened: true, prNumber: 37, contributor: 'holder', holder: null, held: false });
      expect(await reopens(id)).toEqual([{
        actor: 'Jagadeeshftw',
        detail: expect.objectContaining({ reason: REOPEN_REASON, prNumber: 37, source: 'repair', holder: null }),
      }]);
      expect((await api.bounties(id))[0]!.history).toContainEqual(
        expect.objectContaining({ kind: 'reopened', by: 'Jagadeeshftw', reason: REOPEN_REASON, prNumber: 37 }));

      const swept = await draw.closeDueWindows();
      expect(swept.drawn).toEqual([id]);
      // Both applicants were in it: the person whose PR was closed is not
      // excluded by this. That is a decision for a person, not for this code.
      const pool = (await db.query<{ pool: { githubLogin: string }[] }>('SELECT pool FROM bounty_draws WHERE bounty_id = $1', [id])).rows[0]!.pool;
      expect(pool.map((p) => p.githubLogin).sort()).toEqual(['holder', 'other-dev']);
    });

    it('with --hold, waits for somebody to press Redraw', async () => {
      const id = await stranded();
      expect(await draw.reopenAfterClosedPullRequest({ bountyId: id, actor: 'Jagadeeshftw', hold: true })).toMatchObject({ reopened: true, held: true });
      expect((await bounty(id)).awaiting_redraw).toBe(true);
      expect((await draw.closeDueWindows()).drawn).toEqual([]);
    });

    it('is idempotent', async () => {
      const id = await stranded();
      await draw.reopenAfterClosedPullRequest({ bountyId: id, actor: 'Jagadeeshftw' });
      expect(await draw.reopenAfterClosedPullRequest({ bountyId: id, actor: 'Jagadeeshftw' })).toMatchObject({ reopened: false, why: 'not_in_review' });
      expect(await reopens(id)).toHaveLength(1);
    });

    it('asks GitHub about a pull request we still think is open, in case the close never reached us', async () => {
      const id = await drawnBounty(35);
      await prOpened(id, 37, 35);
      closeUnmerged(37);                                              // closed on GitHub; no webhook arrived
      const r = await draw.reopenAfterClosedPullRequest({ bountyId: id, actor: 'Jagadeeshftw' });
      expect(r).toMatchObject({ reopened: true, prNumber: 37, holder: 'holder', holderReset: true });
      expect((await db.query(`SELECT state FROM submissions WHERE bounty_id = $1`, [id])).rows[0]!.state).toBe('closed');
      expect((await assignment(id)).status).toBe('active');
    });

    it('leaves a pull request that is really open, or merged, alone and names it', async () => {
      const id = await drawnBounty(35);
      await prOpened(id, 37, 35);
      expect(await draw.reopenAfterClosedPullRequest({ bountyId: id, actor: 'x' })).toMatchObject({ reopened: false, why: 'pr_open', prNumber: 37 });
      Object.assign(gh.pulls.get(gh.key(REPO, 37))!, { state: 'closed', merged: true });
      expect(await draw.reopenAfterClosedPullRequest({ bountyId: id, actor: 'x' })).toMatchObject({ reopened: false, why: 'pr_merged', prNumber: 37 });
      expect((await bounty(id)).status).toBe('in_review');
      expect(await reopens(id)).toEqual([]);
    });
  });
});
