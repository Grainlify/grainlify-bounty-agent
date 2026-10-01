// The HTTP surface of the draw: POST /bounties/apply and POST /admin/draw,
// against Postgres. Needs TEST_DATABASE_URL.

import { randomBytes, randomUUID, sign } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase } from '../../../packages/db/src/testing.ts';
import { SESSION_ADMIN_DOMAIN, SESSION_APPLY_DOMAIN, SESSION_MAINTAINER_DOMAIN } from '../../../packages/gate/src/session-action.ts';
import { grainlifyKey } from '../../../packages/gate/test/session-support.ts';
import { p2Config } from '../src/config.ts';
import { DrawService } from '../src/draw-service.ts';
import { PublicApi } from '../src/public.ts';
import { createAgentServer } from '../src/server.ts';
import { BountyService } from '../src/service.ts';
import { FakeGitHub } from './fake-github.ts';

const dbUrl = process.env.TEST_DATABASE_URL;
const ORIGIN = 'https://grainlify.com';

describe.skipIf(!dbUrl)('the draw over HTTP', () => {
  const key = grainlifyKey();
  let db: pg.Pool;
  let gh: FakeGitHub;
  let url: string;
  let repoId: number;
  const servers: Server[] = [];
  const now = () => new Date('2026-09-27T10:00:00Z');
  const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

  const message = (a: { kind: 'apply' | 'admin' | 'maintainer'; action: string; login: string; id: number; subject: string }) => {
    const at = new Date(now().getTime() - 60_000);
    return [
      `Grainlify: ${a.kind === 'apply' ? 'apply for a bounty' : `${a.kind} action`}`,
      `Action: ${a.action}`,
      `GitHub: ${a.login} (id ${a.id})`,
      `Subject: ${a.subject}`,
      `Nonce: ${randomBytes(16).toString('hex')}`,
      `Issued: ${iso(at)}`,
      `Expires: ${iso(new Date(at.getTime() + 600_000))}`,
    ].join('\n');
  };
  const signedBody = (a: Parameters<typeof message>[0], extra: Record<string, unknown> = {}) => {
    const msg = message(a);
    const domain = { apply: SESSION_APPLY_DOMAIN, admin: SESSION_ADMIN_DOMAIN, maintainer: SESSION_MAINTAINER_DOMAIN }[a.kind];
    return { message: msg, countersignature: sign(null, Buffer.from(domain + msg, 'utf8'), key.privateKey).toString('base64'), ...extra };
  };
  const post = async (path: string, body: unknown) => {
    const r = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown>, headers: r.headers };
  };

  const newBounty = async (over: { waived?: string[] } = {}) => {
    const id = randomUUID();
    await db.query(
      `INSERT INTO bounties (id, repo_id, issue_number, amount_minor, currency, mint, network, status, created_by, waived_eligibility_rules)
       VALUES ($1,$2,$3,1000000,'USDC','mint','solana-mainnet','posted','test',$4)`,
      [id, repoId, Math.floor(Math.random() * 100000), over.waived ?? []],
    );
    return id;
  };
  const person = async (id: number, login: string) => {
    gh.users.set(login.toLowerCase(), { id, login, type: 'User', createdAt: new Date(now().getTime() - 400 * 86_400_000) });
    await db.query(`INSERT INTO contributors (github_user_id, login) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, login]);
    await db.query(`INSERT INTO wallet_links (github_user_id, address, message, signature, source) VALUES ($1,$2,'m','s','t')`, [id, `w${id}`]);
  };

  beforeAll(async () => {
    db = await freshDatabase(dbUrl!, 'test_draw_api');
  });
  beforeEach(async () => {
    gh = new FakeGitHub();
    await db.query('TRUNCATE bounty_events, bounty_assignments, bounty_draws, bounty_applications, wallet_links, bounties, contributors, bounty_config, link_nonces CASCADE');
    await db.query(`INSERT INTO repos (owner, name, enabled, bounties_enabled, registered_project) VALUES ('Grainlify','test-repo', true, true, true)
                    ON CONFLICT (owner,name) DO UPDATE SET enabled = true, bounties_enabled = true, registered_project = true`);
    repoId = (await db.query<{ id: string }>(`SELECT id FROM repos WHERE owner='Grainlify' AND name='test-repo'`)).rows[0]!.id as unknown as number;
    for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
    const cfg = p2Config({ mints: {}, trustedApprovers: [] });
    const draw = new DrawService({ db, gh, now });
    const service = new BountyService({ db, gh, x402: {} as never, payoutSigner: {} as never, cfg, linkCountersignKey: key.publicB64, now });
    const s = createAgentServer({ db, service, webhookSecret: 'x'.repeat(32), publicApi: new PublicApi(db, cfg), publicOrigins: [ORIGIN], draw, linkCountersignKey: key.publicB64, now });
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
    await db?.end();
  });

  const openWindow = async (b: string) =>
    Promise.resolve()
      .then(() => db.query(`UPDATE bounties SET applications_open_at = $2, applications_close_at = $2::timestamptz + interval '6 hours' WHERE id = $1`, [b, now().toISOString()]));

  it('accepts an application carrying a countersigned message', async () => {
    const b = await newBounty();
    await openWindow(b);
    await person(50, 'octo');
    const r = await post('/bounties/apply', signedBody({ kind: 'apply', action: 'apply', login: 'octo', id: 50, subject: b }));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ applied: true });
    expect(r.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });

  it('refuses an application the browser signed itself', async () => {
    const b = await newBounty();
    await openWindow(b);
    await person(51, 'forger');
    const body = signedBody({ kind: 'apply', action: 'apply', login: 'forger', id: 51, subject: b });
    const r = await post('/bounties/apply', { ...body, countersignature: Buffer.alloc(64).toString('base64') });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: 'bad_countersignature' });
  });

  // The separation the whole design rests on, checked at the HTTP edge rather
  // than only in the verifier's own unit test.
  it('an apply message cannot run an admin action', async () => {
    const b = await newBounty();
    const r = await post('/admin/draw', signedBody({ kind: 'apply', action: 'run_draw', login: 'octo', id: 50, subject: b }));
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: 'wrong_domain' });
  });

  it('an admin message cannot be used to apply', async () => {
    const b = await newBounty();
    await openWindow(b);
    await person(52, 'sneaky');
    const r = await post('/bounties/apply', signedBody({ kind: 'admin', action: 'apply', login: 'sneaky', id: 52, subject: b }));
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: 'wrong_domain' });
  });

  it('a replayed message is spent, so one signature applies at most once', async () => {
    const b = await newBounty();
    await openWindow(b);
    await person(53, 'replay');
    const body = signedBody({ kind: 'apply', action: 'apply', login: 'replay', id: 53, subject: b });
    expect((await post('/bounties/apply', body)).status).toBe(201);
    const again = await post('/bounties/apply', body);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: 'nonce_used' });
  });

  it('runs a draw on request and returns the ticket breakdown', async () => {
    const b = await newBounty();
    await openWindow(b);
    for (const [id, login] of [[60, 'a'], [61, 'b'], [62, 'c']] as [number, string][]) {
      await person(id, login);
      await post('/bounties/apply', signedBody({ kind: 'apply', action: 'apply', login, id, subject: b }));
    }
    gh.permissions.set('grainlify/test-repo:jagadeeshftw', 'admin');
    const r = await post('/maintainer/draw', signedBody({ kind: 'maintainer', action: 'run_draw', login: 'Jagadeeshftw', id: 1, subject: b }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ poolSize: 3, triggeredBy: 'Jagadeeshftw' });
    expect((r.body.pool as unknown[]).length).toBe(3);
    expect(r.body.winner).not.toBeNull();
  });

  it('simulates without assigning anyone', async () => {
    const b = await newBounty();
    await openWindow(b);
    await person(70, 'solo');
    await post('/bounties/apply', signedBody({ kind: 'apply', action: 'apply', login: 'solo', id: 70, subject: b }));
    gh.permissions.set('grainlify/test-repo:maint', 'maintain');
    const r = await post('/maintainer/draw', signedBody({ kind: 'maintainer', action: 'run_draw', login: 'maint', id: 3, subject: b }, { simulate: true }));
    expect(r.body).toMatchObject({ simulation: true, winner: null, assignmentId: null });
    expect((await db.query(`SELECT 1 FROM bounty_assignments WHERE bounty_id = $1`, [b])).rowCount).toBe(0);
  });

  it('shows a maintainer the applications once the window has closed', async () => {
    const b = await newBounty();
    await openWindow(b);
    await person(80, 'seen');
    await post('/bounties/apply', signedBody({ kind: 'apply', action: 'apply', login: 'seen', id: 80, subject: b }));
    await db.query(`UPDATE bounties SET applications_close_at = $2 WHERE id = $1`, [b, new Date(now().getTime() - 1000).toISOString()]);
    gh.permissions.set('grainlify/test-repo:maint', 'write');
    const r = await post('/maintainer/draw', signedBody({ kind: 'maintainer', action: 'view', login: 'maint', id: 3, subject: b }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ applicantCount: 1, assignment: null, awaitingRedraw: false });
  });

  describe('who may act on a bounty', () => {
    // These were relayed on the admin channel for anybody signed in, so any
    // signed-in user could act on any bounty. They are now maintainer
    // actions, checked here against the bounty's own repository.
    it('refuses somebody who does not maintain the repository, and changes nothing', async () => {
      const b = await newBounty();
      await openWindow(b);
      await person(90, 'applicant');
      await post('/bounties/apply', signedBody({ kind: 'apply', action: 'apply', login: 'applicant', id: 90, subject: b }));
      for (const action of ['run_draw', 'unassign', 'set_assignment_deadline', 'view']) {
        const r = await post('/maintainer/draw', signedBody({ kind: 'maintainer', action, login: 'stranger', id: 91, subject: b }, { reason: 'x', deadline: '2030-01-01T00:00:00Z' }));
        expect(r.status).toBe(403);
        expect(r.body).toMatchObject({ error: 'not_your_bounty' });
      }
      expect((await db.query('SELECT 1 FROM bounty_draws WHERE bounty_id = $1', [b])).rowCount).toBe(0);
    });

    it('refuses read and triage permission: those are not maintaining it', async () => {
      const b = await newBounty();
      gh.permissions.set('grainlify/test-repo:triager', 'triage');
      const r = await post('/maintainer/draw', signedBody({ kind: 'maintainer', action: 'view', login: 'triager', id: 92, subject: b }));
      expect(r.status).toBe(403);
    });

    it('lets the person who funded the bounty act on it', async () => {
      const b = await newBounty();
      await db.query('UPDATE bounties SET funded_by = $2 WHERE id = $1', [b, 'Funder']);
      const r = await post('/maintainer/draw', signedBody({ kind: 'maintainer', action: 'view', login: 'funder', id: 93, subject: b }));
      expect(r.status).toBe(200);
    });

    it('a maintainer message cannot run an admin action, and an admin message cannot run a maintainer one', async () => {
      const b = await newBounty();
      gh.permissions.set('grainlify/test-repo:maint', 'admin');
      const asAdmin = await post('/admin/draw', signedBody({ kind: 'maintainer', action: 'list_settings', login: 'maint', id: 3, subject: '' }));
      expect(asAdmin.body).toMatchObject({ error: 'wrong_domain' });
      const asMaintainer = await post('/maintainer/draw', signedBody({ kind: 'admin', action: 'view', login: 'maint', id: 3, subject: b }));
      expect(asMaintainer.body).toMatchObject({ error: 'wrong_domain' });
    });

    it('the admin channel no longer runs per-bounty actions', async () => {
      const b = await newBounty();
      for (const action of ['run_draw', 'unassign', 'set_assignment_deadline', 'bounty_state', 'maintainer_view']) {
        const r = await post('/admin/draw', signedBody({ kind: 'admin', action, login: 'admin', id: 1, subject: b }, { reason: 'x' }));
        expect(r.status).toBe(400);
        expect(r.body).toMatchObject({ error: 'unknown_action' });
      }
    });
  });

  it('reads and writes settings, and refuses a value out of range', async () => {
    const list = await post('/admin/draw', signedBody({ kind: 'admin', action: 'list_settings', login: 'admin', id: 1, subject: '' }));
    expect((list.body.settings as { key: string }[]).some((s) => s.key === 'application_window_hours')).toBe(true);

    const ok = await post('/admin/draw', signedBody({ kind: 'admin', action: 'set_setting', login: 'admin', id: 1, subject: 'application_window_hours' }, { value: '12' }));
    expect(ok.status).toBe(200);
    expect((ok.body.settings as { key: string; value: string }[]).find((s) => s.key === 'application_window_hours')).toMatchObject({ value: '12', overridden: true });

    const bad = await post('/admin/draw', signedBody({ kind: 'admin', action: 'set_setting', login: 'admin', id: 1, subject: 'application_window_hours' }, { value: '0' }));
    expect(bad.status).toBe(400);
  });

  it('refuses an admin action it does not have a name for', async () => {
    const r = await post('/admin/draw', signedBody({ kind: 'admin', action: 'delete_everything', login: 'admin', id: 1, subject: '' }));
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: 'unknown_action' });
  });

  it('answers 503, not a crash, when the draw is not configured', async () => {
    const cfg = p2Config({ mints: {}, trustedApprovers: [] });
    const service = new BountyService({ db, gh, x402: {} as never, payoutSigner: {} as never, cfg, linkCountersignKey: key.publicB64, now });
    const s = createAgentServer({ db, service, webhookSecret: 'x'.repeat(32), publicOrigins: [ORIGIN], now });
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const bare = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    const r = await fetch(`${bare}/bounties/apply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(503);
  });
    // Client state cannot answer this: it does not survive a reload, which is
    // how someone ended up clicking Apply twice to learn they had applied once.
    it('answers from the server, keyed by bounty', async () => {
      const b = await newBounty();
      await openWindow(b);
      await person(90, 'asker');
      await post('/bounties/apply', signedBody({ kind: 'apply', action: 'apply', login: 'asker', id: 90, subject: b }));

      const r = await post('/bounties/mine', signedBody({ kind: 'apply', action: 'my_state', login: 'asker', id: 90, subject: '' }));
      expect(r.status).toBe(200);
      expect((r.body.applications as Record<string, { status: string }>)[b]).toMatchObject({ status: 'applied' });
    });

    it('answers the same twice in a row: a read does not spend the nonce', async () => {
      // Spending one would mean a page that reloads twice in a second refuses
      // the second time, and there is nothing to replay - the answer is fixed.
      const b = await newBounty();
      await openWindow(b);
      await person(91, 'twice');
      const body = signedBody({ kind: 'apply', action: 'my_state', login: 'twice', id: 91, subject: '' });
      expect((await post('/bounties/mine', body)).status).toBe(200);
      expect((await post('/bounties/mine', body)).status).toBe(200);
    });

    it('shows one person only', async () => {
      const b = await newBounty();
      await openWindow(b);
      await person(92, 'mine-only');
      await person(93, 'other');
      await post('/bounties/apply', signedBody({ kind: 'apply', action: 'apply', login: 'other', id: 93, subject: b }));

      const r = await post('/bounties/mine', signedBody({ kind: 'apply', action: 'my_state', login: 'mine-only', id: 92, subject: '' }));
      expect(r.body.applications).toEqual({});
    });

    it('carries the refusal reason, so the page can say which rule', async () => {
      const b = await newBounty();
      await openWindow(b);
      gh.users.set('nowallet', { id: 94, login: 'nowallet', type: 'User', createdAt: new Date(now().getTime() - 400 * 86_400_000) });
      await db.query(`INSERT INTO contributors (github_user_id, login) VALUES (94,'nowallet') ON CONFLICT DO NOTHING`);
      await post('/bounties/apply', signedBody({ kind: 'apply', action: 'apply', login: 'nowallet', id: 94, subject: b }));

      const r = await post('/bounties/mine', signedBody({ kind: 'apply', action: 'my_state', login: 'nowallet', id: 94, subject: '' }));
      expect((r.body.applications as Record<string, { gateFailureReason: string }>)[b]).toMatchObject({ gateFailureReason: 'no_linked_wallet' });
    });

    it('reports what the viewer holds', async () => {
      const b = await newBounty();
      await openWindow(b);
      await person(95, 'holder');
      await post('/bounties/apply', signedBody({ kind: 'apply', action: 'apply', login: 'holder', id: 95, subject: b }));
      gh.permissions.set('grainlify/test-repo:maint', 'admin');
      await post('/maintainer/draw', signedBody({ kind: 'maintainer', action: 'run_draw', login: 'maint', id: 3, subject: b }));

      const r = await post('/bounties/mine', signedBody({ kind: 'apply', action: 'my_state', login: 'holder', id: 95, subject: '' }));
      expect((r.body.assignments as Record<string, { status: string }>)[b]).toMatchObject({ status: 'active' });
      expect((r.body.applications as Record<string, { status: string }>)[b]).toMatchObject({ status: 'won' });
    });

    it('an admin message cannot read a contributor\'s state', async () => {
      const r = await post('/bounties/mine', signedBody({ kind: 'admin', action: 'my_state', login: 'admin', id: 1, subject: '' }));
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({ error: 'wrong_domain' });
    });
});
