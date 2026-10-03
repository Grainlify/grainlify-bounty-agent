// Erasing an account at its owner's request: what goes, what stays, and what
// the public ledger shows afterwards. Needs TEST_DATABASE_URL.

import { randomBytes, randomUUID, sign } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase } from '../../../packages/db/src/testing.ts';
import { SESSION_APPLY_DOMAIN, SESSION_ERASURE_DOMAIN } from '../../../packages/gate/src/session-action.ts';
import { grainlifyKey } from '../../../packages/gate/test/session-support.ts';
import { p2Config } from '../src/config.ts';
import { ERASED_LOGIN, eraseAccount, finishRetainedErasures } from '../src/erasure-service.ts';
import { PublicApi } from '../src/public.ts';
import { createAgentServer } from '../src/server.ts';
import { BountyService } from '../src/service.ts';
import { FakeGitHub } from './fake-github.ts';

const dbUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!dbUrl)('erasing an account', () => {
  const key = grainlifyKey();
  let db: pg.Pool;
  let api: PublicApi;
  let url: string;
  let server: Server;
  let repoId: number;
  const now = () => new Date('2026-10-03T10:00:00Z');
  const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

  // The exact text Grainlify-Backend's AgentErasureMessage signs.
  const erasureBody = (id: number, login: string, domain = SESSION_ERASURE_DOMAIN, action = 'erase') => {
    const at = new Date(now().getTime() - 60_000);
    const message = [
      'Grainlify: erase account',
      `Action: ${action}`,
      `GitHub: ${login} (id ${id})`,
      'Subject: ',
      `Nonce: ${randomBytes(16).toString('hex')}`,
      `Issued: ${iso(at)}`,
      `Expires: ${iso(new Date(at.getTime() + 600_000))}`,
    ].join('\n');
    return { message, countersignature: sign(null, Buffer.from(domain + message, 'utf8'), key.privateKey).toString('base64') };
  };
  const post = async (body: unknown) => {
    const r = await fetch(`${url}/account/erase`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const count = async (sql: string, args: unknown[]) => Number((await db.query<{ n: string }>(sql, args)).rows[0]!.n);

  // A contributor with a wallet link, an application, a snapshot, a draw they
  // won and a confirmed payout - i.e. something in every table erasure touches.
  const contributor = async (id: number, login: string) => {
    await db.query(`INSERT INTO contributors (github_user_id, login) VALUES ($1,$2)`, [id, login]);
    await db.query(`INSERT INTO wallet_links (github_user_id, address, message, signature, source) VALUES ($1,$2,'m','s','t')`, [id, `wallet${id}`]);
    await db.query(`INSERT INTO link_nonces (nonce, github_user_id) VALUES ($1,$2)`, [randomBytes(16).toString('hex'), id]);
    await db.query(`INSERT INTO contributor_snapshots (github_user_id, login, evidence) VALUES ($1,$2,'{"repos":["x"]}')`, [id, login]);
    const bountyId = randomUUID();
    await db.query(
      `INSERT INTO bounties (id, repo_id, issue_number, amount_minor, currency, mint, network, status, created_by)
       VALUES ($1,$2,$3,1000000,'USDC','mint','solana-mainnet','paid','agent')`,
      [bountyId, repoId, Math.floor(Math.random() * 1_000_000)],
    );
    await db.query(
      `INSERT INTO bounty_applications (bounty_id, github_user_id, github_login, status, application_text) VALUES ($1,$2,$3,'won','I am Ada and I will fix it')`,
      [bountyId, id, login],
    );
    await db.query(
      `INSERT INTO bounty_draws (bounty_id, seed, pool, pool_size, winner_github_user_id, winner_login, triggered_by)
       VALUES ($1, 7, $2::jsonb, 2, $3, $4, 'automatic')`,
      [bountyId, JSON.stringify([{ githubLogin: login, githubUserId: id, tickets: 2 }, { githubLogin: 'someone-else', githubUserId: 999, tickets: 1 }]), id, login],
    );
    await db.query(
      `INSERT INTO bounty_assignments (bounty_id, github_user_id, github_login, status, stale_at) VALUES ($1,$2,$3,'completed', now())`,
      [bountyId, id, login],
    );
    const sub = randomUUID();
    await db.query(
      `INSERT INTO submissions (id, bounty_id, pr_number, author_github_user_id, author_login, state) VALUES ($1,$2,1,$3,$4,'merged')`,
      [sub, bountyId, id, login],
    );
    await db.query(
      `INSERT INTO payouts (id, bounty_id, submission_id, recipient, recipient_github_user_id, amount_minor, currency, mint, network, gate_result, status, tx_signature)
       VALUES ($1,$2,$3,$4,$5,1000000,'USDC','mint','solana-mainnet','{}','confirmed',$6)`,
      [randomUUID(), bountyId, sub, `wallet${id}`, id, `sig${id}${randomBytes(4).toString('hex')}`],
    );
    return bountyId;
  };

  beforeAll(async () => {
    db = await freshDatabase(dbUrl!, 'test_erasure');
    const cfg = p2Config({ mints: {}, trustedApprovers: [] });
    api = new PublicApi(db, cfg);
    const service = new BountyService({ db, gh: new FakeGitHub(), x402: {} as never, payoutSigner: {} as never, cfg, linkCountersignKey: key.publicB64, now });
    server = createAgentServer({ db, service, webhookSecret: 'x'.repeat(32), publicApi: api, linkCountersignKey: key.publicB64, now });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  beforeEach(async () => {
    await db.query(`TRUNCATE account_erasures, payouts, submissions, bounty_assignments, bounty_draws, bounty_applications, bounties,
                    wallet_links, link_nonces, contributor_snapshots, contributors, bounty_events, audit_log CASCADE`);
    await db.query(`INSERT INTO repos (owner, name, enabled, bounties_enabled, registered_project) VALUES ('Grainlify','test-repo', true, true, true)
                    ON CONFLICT (owner,name) DO UPDATE SET enabled = true`);
    repoId = (await db.query<{ id: string }>(`SELECT id FROM repos WHERE owner='Grainlify' AND name='test-repo'`)).rows[0]!.id as unknown as number;
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
    await db?.end();
  });

  it('removes what is about the person and keeps the payout and draw records', async () => {
    const bountyId = await contributor(70, 'ada');
    await contributor(71, 'grace');

    const r = await post(erasureBody(70, 'ada'));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ erased: true, alreadyErased: false });

    for (const t of ['wallet_links', 'link_nonces', 'contributor_snapshots', 'bounty_applications', 'contributors']) {
      expect(await count(`SELECT count(*) AS n FROM ${t} WHERE github_user_id = $1`, [70]), t).toBe(0);
    }
    // Kept, unchanged: the rows the public ledger is built from.
    expect(await count(`SELECT count(*) AS n FROM payouts WHERE recipient_github_user_id = $1 AND status = 'confirmed'`, [70])).toBe(1);
    expect(await count(`SELECT count(*) AS n FROM submissions WHERE author_github_user_id = $1 AND author_login = 'ada'`, [70])).toBe(1);
    expect(await count(`SELECT count(*) AS n FROM bounty_draws WHERE winner_github_user_id = $1 AND winner_login = 'ada'`, [70])).toBe(1);
    // Inside the stored pool only the name goes; tickets and the other entrant are untouched.
    const pool = (await db.query<{ pool: { githubLogin: string; githubUserId: number; tickets: number }[] }>(`SELECT pool FROM bounty_draws WHERE bounty_id = $1`, [bountyId])).rows[0]!.pool;
    expect(pool).toEqual([
      { githubLogin: 'erased-account', githubUserId: 70, tickets: 2 },
      { githubLogin: 'someone-else', githubUserId: 999, tickets: 1 },
    ]);

    // Somebody else is untouched.
    expect(await count(`SELECT count(*) AS n FROM wallet_links WHERE github_user_id = $1`, [71])).toBe(1);
    expect(await count(`SELECT count(*) AS n FROM bounty_applications WHERE github_user_id = $1`, [71])).toBe(1);
  });

  it('the public ledger hides the login and records the erasure, without editing any row', async () => {
    await contributor(72, 'ada');
    await contributor(73, 'grace');
    await post(erasureBody(72, 'ada'));

    const ledger = await api.ledger();
    const payouts = ledger.events.filter((e) => e.kind === 'payout').map((e) => e.detail);
    expect(payouts.some((d) => d.endsWith(`→ ${ERASED_LOGIN}`))).toBe(true);
    expect(payouts.some((d) => d.endsWith('→ grace'))).toBe(true);
    expect(payouts.some((d) => d.includes('ada'))).toBe(false);

    const erasures = ledger.events.filter((e) => e.kind === 'erasure');
    expect(erasures).toHaveLength(1);
    // The erasure event names nobody.
    expect(JSON.stringify(erasures[0])).not.toContain('ada');
    expect(JSON.stringify(erasures[0])).not.toContain('72');

    const bounties = await api.bounties();
    const drawn = bounties.flatMap((b) => b.history.filter((h) => h.kind === 'draw').map((h) => (h as { drawn: string | null }).drawn));
    expect(drawn).toContain(ERASED_LOGIN);
    expect(drawn).toContain('grace');
    expect(drawn).not.toContain('ada');
  });

  it('is idempotent', async () => {
    await contributor(74, 'ada');
    expect((await post(erasureBody(74, 'ada'))).status).toBe(200);
    const again = await post(erasureBody(74, 'ada'));
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ erased: true, alreadyErased: true });
    expect(await count(`SELECT count(*) AS n FROM account_erasures WHERE github_user_id = $1`, [74])).toBe(1);
    expect((await api.ledger()).events.filter((e) => e.kind === 'erasure')).toHaveLength(1);
  });

  it('refuses while a bounty assignment or payout is in flight, and changes nothing', async () => {
    const b = await contributor(75, 'busy');
    await db.query(`UPDATE bounty_assignments SET status = 'active' WHERE bounty_id = $1`, [b]);
    const r = await post(erasureBody(75, 'busy'));
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: 'in_flight' });
    expect(await count(`SELECT count(*) AS n FROM wallet_links WHERE github_user_id = $1`, [75])).toBe(1);
    expect(await count(`SELECT count(*) AS n FROM account_erasures WHERE github_user_id = $1`, [75])).toBe(0);

    const direct = await eraseAccount(db, 75);
    expect(direct).toMatchObject({ ok: false, inFlight: ['a bounty assignment in progress'] });
  });

  it('only an erasure signature can erase', async () => {
    await contributor(76, 'ada');
    const forged = await post(erasureBody(76, 'ada', SESSION_APPLY_DOMAIN));
    expect(forged.status).toBe(400);
    expect(forged.body).toMatchObject({ error: 'bad_countersignature' });
    const unsigned = await post({ ...erasureBody(76, 'ada'), countersignature: Buffer.alloc(64).toString('base64') });
    expect(unsigned.status).toBe(400);
    expect(await count(`SELECT count(*) AS n FROM wallet_links WHERE github_user_id = $1`, [76])).toBe(1);
  });

  // Grainlify waits 30 days at most for money in flight, then sends this
  // action: the erasure goes ahead and keeps only what that money needs.
  it('past Grainlify\'s 30-day limit, erases anyway and keeps what the assignment still needs', async () => {
    const b = await contributor(77, 'late');
    await db.query(`UPDATE bounty_assignments SET status = 'active' WHERE bounty_id = $1`, [b]);

    const r = await post(erasureBody(77, 'late', SESSION_ERASURE_DOMAIN, 'erase_retaining_in_flight'));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ erased: true, retainedInFlight: ['a bounty assignment in progress'] });
    // Gone: everything that is about the person and not the money.
    for (const t of ['link_nonces', 'contributor_snapshots', 'bounty_applications']) {
      expect(await count(`SELECT count(*) AS n FROM ${t} WHERE github_user_id = $1`, [77]), t).toBe(0);
    }
    // Kept: the assignment, and the wallet its payout would go to (with the
    // contributor row the link hangs from).
    expect(await count(`SELECT count(*) AS n FROM bounty_assignments WHERE github_user_id = $1 AND status = 'active'`, [77])).toBe(1);
    expect(await count(`SELECT count(*) AS n FROM wallet_links WHERE github_user_id = $1 AND revoked_at IS NULL`, [77])).toBe(1);
    expect(await count(`SELECT count(*) AS n FROM contributors WHERE github_user_id = $1`, [77])).toBe(1);
    expect(await count(`SELECT count(*) AS n FROM account_erasures WHERE github_user_id = $1 AND cardinality(retained_in_flight) = 1`, [77])).toBe(1);
    // The public ledger already shows the account as erased.
    const payouts = (await api.ledger()).events.filter((e) => e.kind === 'payout').map((e) => e.detail);
    expect(payouts.some((d) => d.includes('late'))).toBe(false);

    // Still in flight: the finisher leaves it alone.
    expect(await finishRetainedErasures(db)).toEqual([]);
    expect(await count(`SELECT count(*) AS n FROM wallet_links WHERE github_user_id = $1`, [77])).toBe(1);

    // Once it is no longer in flight, the rest goes.
    await db.query(`UPDATE bounty_assignments SET status = 'completed' WHERE bounty_id = $1`, [b]);
    expect(await finishRetainedErasures(db)).toEqual([77]);
    expect(await count(`SELECT count(*) AS n FROM wallet_links WHERE github_user_id = $1`, [77])).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM contributors WHERE github_user_id = $1`, [77])).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM account_erasures WHERE github_user_id = $1 AND cardinality(retained_in_flight) = 0`, [77])).toBe(1);
    expect(await finishRetainedErasures(db)).toEqual([]);
  });

  it('past the limit with only a payout in flight, keeps the payout row and nothing else', async () => {
    const b = await contributor(78, 'owed');
    await db.query(`UPDATE payouts SET status = 'approved', tx_signature = NULL WHERE bounty_id = $1`, [b]);
    expect((await post(erasureBody(78, 'owed'))).status).toBe(409);

    const r = await post(erasureBody(78, 'owed', SESSION_ERASURE_DOMAIN, 'erase_retaining_in_flight'));
    expect(r.status).toBe(200);
    // The payout carries its own recipient, so the wallet link is not needed.
    expect(await count(`SELECT count(*) AS n FROM wallet_links WHERE github_user_id = $1`, [78])).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM payouts WHERE recipient_github_user_id = $1 AND status = 'approved' AND recipient = 'wallet78'`, [78])).toBe(1);
  });

  it('refuses an erasure action it does not know', async () => {
    await contributor(79, 'ada');
    const r = await post(erasureBody(79, 'ada', SESSION_ERASURE_DOMAIN, 'erase_everything'));
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: 'unknown_action' });
    expect(await count(`SELECT count(*) AS n FROM wallet_links WHERE github_user_id = $1`, [79])).toBe(1);
  });
});
