// The funded-bounty actions on the signed channels: which channel reaches
// which action, and that the agent's own draw controls refuse a funded bounty.
// Needs TEST_DATABASE_URL. The rules themselves are in funded-bounties.test.ts.
import { randomBytes, randomUUID, sign } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { Connection, Keypair } from '@solana/web3.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase } from '../../../packages/db/src/testing.ts';
import { SESSION_ADMIN_DOMAIN, SESSION_APPLY_DOMAIN, SESSION_MAINTAINER_DOMAIN } from '../../../packages/gate/src/session-action.ts';
import { grainlifyKey } from '../../../packages/gate/test/session-support.ts';
import { p2Config } from '../src/config.ts';
import { DrawService } from '../src/draw-service.ts';
import { EscrowService } from '../src/escrow-service.ts';
import { FundedService } from '../src/funded-service.ts';
import { PublicApi } from '../src/public.ts';
import { createAgentServer } from '../src/server.ts';
import { BountyService } from '../src/service.ts';
import { FakeGitHub } from './fake-github.ts';

const dbUrl = process.env.TEST_DATABASE_URL;
const ORIGIN = 'https://grainlify.com';

describe.skipIf(!dbUrl)('funded-bounty routes', () => {
  const key = grainlifyKey();
  let db: pg.Pool;
  let url: string;
  let server: Server;
  const gh = new FakeGitHub();
  const now = () => new Date('2026-10-02T10:00:00Z');
  const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const KIND = { apply: ['apply for a bounty', SESSION_APPLY_DOMAIN, '/bounties/apply'], admin: ['admin action', SESSION_ADMIN_DOMAIN, '/admin/draw'], maintainer: ['maintainer action', SESSION_MAINTAINER_DOMAIN, '/maintainer/draw'] } as const;

  const call = async (kind: keyof typeof KIND, action: string, subject: string, login: string, id: number, extra: Record<string, unknown> = {}) => {
    const [headline, domain, path] = KIND[kind];
    const at = new Date(now().getTime() - 60_000);
    const message = [`Grainlify: ${headline}`, `Action: ${action}`, `GitHub: ${login} (id ${id})`, `Subject: ${subject}`,
      `Nonce: ${randomBytes(16).toString('hex')}`, `Issued: ${iso(at)}`, `Expires: ${iso(new Date(at.getTime() + 600_000))}`].join('\n');
    const body = { message, countersignature: sign(null, Buffer.from(domain + message, 'utf8'), key.privateKey).toString('base64'), ...extra };
    const r = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };

  let bountyId: string;

  beforeAll(async () => {
    db = await freshDatabase(dbUrl!, 'test_funded_api');
    const cfg = p2Config({ mints: {}, trustedApprovers: [] });
    const service = new BountyService({ db, gh, x402: undefined as never, payoutSigner: {} as never, cfg, now });
    const draw = new DrawService({ db, gh, now });
    const escrow = new EscrowService({
      db, connection: new Connection('http://127.0.0.1:1', 'confirmed'), attestor: Keypair.generate().publicKey,
      feeDestination: Keypair.generate().publicKey, network: 'solana-devnet', mints: {}, now,
    });
    const funded = new FundedService({ db, gh, draw, escrow, caps: {}, now });
    server = createAgentServer({
      db, service, draw, escrow, funded, webhookSecret: 'x'.repeat(32), publicOrigins: [ORIGIN], linkCountersignKey: key.publicB64, now,
      publicApi: new PublicApi(db, cfg, { funded }), log: () => {},
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
    await db?.end();
  });
  beforeEach(async () => {
    await db.query('TRUNCATE bounty_escrows, bounty_assignments, bounty_applications, bounties, repos, bounty_config CASCADE');
    await db.query(`INSERT INTO bounty_config (key, value, updated_by, updated_at) VALUES ('funded_bounties_enabled','true','t',now())`);
    const repo = (await db.query<{ id: number }>(`INSERT INTO repos (owner, name, enabled) VALUES ('acme','widgets',true) RETURNING id`)).rows[0]!.id;
    bountyId = randomUUID();
    await db.query(
      `INSERT INTO bounties (id, repo_id, issue_number, amount_minor, currency, mint, network, status, created_by, funded_by, funded_by_github_user_id)
       VALUES ($1,$2,41,50000000,'USDC','mint','solana-devnet','posted','owen','owen',900)`, [bountyId, repo]);
    await db.query(
      `INSERT INTO bounty_escrows (bounty_id, escrow_pubkey, vault_pubkey, funder_wallet, mint, currency, network, amount_minor, fee_bps,
                                   fee_amount_minor, assignment_mode, state, deadline_at, created_by, fund_tx)
       VALUES ($1,$2,'v','f','mint','USDC','solana-devnet',50000000,250,1250000,'draw','funded','2026-10-20T00:00:00Z','owen','sig')`,
      [bountyId, Keypair.generate().publicKey.toBase58()]);
    gh.permissions.set('acme/widgets:co-maint', 'admin');
  });

  it('the funder\'s view is the funder\'s', async () => {
    expect((await call('maintainer', 'funded_view', bountyId, 'owen', 900)).status).toBe(200);
    const other = await call('maintainer', 'funded_view', bountyId, 'co-maint', 901);
    expect(other).toMatchObject({ status: 403, body: { error: 'not_the_funder' } });
  });

  it('the agent\'s own draw controls refuse a funded bounty, even for a repository admin', async () => {
    for (const action of ['run_draw', 'unassign', 'set_assignment_deadline']) {
      const r = await call('maintainer', action, bountyId, 'co-maint', 901, { reason: 'x', deadline: '2026-10-10T00:00:00Z' });
      expect(r).toMatchObject({ status: 409, body: { error: 'funded_bounty' } });
    }
  });

  it('the contributor answers on their own channel, and the service checks it is theirs', async () => {
    const r = await call('apply', 'unassign_propose', bountyId, 'jotel-dev', 1, { text: 'I cannot finish this' });
    expect(r).toMatchObject({ status: 409, body: { error: 'no_active_assignment' } });
  });

  it('disputes are the admin channel\'s and nobody else\'s', async () => {
    expect(await call('admin', 'dispute_list', '', 'admin', 2)).toMatchObject({ status: 200, body: { disputes: [] } });
    expect((await call('maintainer', 'dispute_list', '', 'owen', 900)).status).toBe(400);
  });

  it('publishes the funder\'s record', async () => {
    const r = await fetch(`${url}/public/funders/owen`, { headers: { origin: ORIGIN } });
    expect(await r.json()).toEqual({ profile: { login: 'owen', bountiesFunded: 1, unassignedBeforePr: 0, disputesRaised: 0 } });
  });
});
