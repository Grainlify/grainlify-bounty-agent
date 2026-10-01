// The funded-bounty routes on the signed channels, against Postgres: the
// funder's actions on the maintainer channel, arbitration on the admin one.
// Needs TEST_DATABASE_URL.
//
// The point of most of these is the switch. A feature that is off should be
// unreachable, not merely unrendered: a disabled screen with a live endpoint
// behind it is how a half-shipped feature gets used before anyone meant it to.
import { randomBytes, randomUUID, sign } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { Connection, Keypair } from '@solana/web3.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase } from '../../../packages/db/src/testing.ts';
import { SESSION_ADMIN_DOMAIN, SESSION_MAINTAINER_DOMAIN } from '../../../packages/gate/src/session-action.ts';
import { grainlifyKey } from '../../../packages/gate/test/session-support.ts';
import { p2Config } from '../src/config.ts';
import { createAgentServer } from '../src/server.ts';
import { BountyService } from '../src/service.ts';
import { DrawService } from '../src/draw-service.ts';
import { EscrowService } from '../src/escrow-service.ts';
import { FakeGitHub } from './fake-github.ts';

const dbUrl = process.env.TEST_DATABASE_URL;
const ORIGIN = 'https://grainlify.com';

describe.skipIf(!dbUrl)('the funded-bounty routes', () => {
  const key = grainlifyKey();
  let db: pg.Pool;
  let url: string;
  const servers: Server[] = [];
  const now = () => new Date('2026-09-30T10:00:00Z');
  const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

  // The funder's actions travel on the maintainer channel; only the escrow
  // list and arbitration read are admin.
  const kindOf = (action: string) => (['escrow_list'].includes(action) ? 'admin' : 'maintainer');
  const signedBody = (action: string, subject: string, extra: Record<string, unknown> = {}, kind: 'admin' | 'maintainer' = kindOf(action), login = 'admin') => {
    const at = new Date(now().getTime() - 60_000);
    const msg = [
      `Grainlify: ${kind} action`,
      `Action: ${action}`,
      `GitHub: ${login} (id 1)`,
      `Subject: ${subject}`,
      `Nonce: ${randomBytes(16).toString('hex')}`,
      `Issued: ${iso(at)}`,
      `Expires: ${iso(new Date(at.getTime() + 600_000))}`,
    ].join('\n');
    const domain = kind === 'admin' ? SESSION_ADMIN_DOMAIN : SESSION_MAINTAINER_DOMAIN;
    return { message: msg, countersignature: sign(null, Buffer.from(domain + msg, 'utf8'), key.privateKey).toString('base64'), ...extra };
  };
  const channel = (body: { message: string }) => (body.message.startsWith('Grainlify: admin') ? '/admin/draw' : '/maintainer/draw');
  const send = (body: { message: string }) => post(channel(body), body);
  const post = async (path: string, body: unknown) => {
    const r = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };

  const setSwitch = (on: boolean) =>
    db.query(
      `INSERT INTO bounty_config (key, value, updated_by, updated_at) VALUES ('funded_bounties_enabled',$1,'test',now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [String(on)]);

  beforeAll(async () => {
    db = await freshDatabase(dbUrl!, 'test_escrow_api');
    const cfg = p2Config({ mints: { USDC: { mint: 'MintUSDC', decimals: 6 } }, trustedApprovers: [] });
    const service = new BountyService({ db, gh: new FakeGitHub(), x402: undefined as never, payoutSigner: {} as never, cfg, now });
    // No RPC call is made by the routes under test; the connection is here so
    // the service is constructed the way it is in production.
    const escrow = new EscrowService({
      db,
      connection: new Connection('http://127.0.0.1:1', 'confirmed'),
      attestor: Keypair.generate().publicKey,
      feeDestination: Keypair.generate().publicKey,
      now,
    });
    // The admin channel is one endpoint and refuses outright when the draw is
    // not wired, so the server is built the way production builds it.
    const draw = new DrawService({ db, gh: new FakeGitHub(), now });
    const s = createAgentServer({ db, service, draw, webhookSecret: 'x'.repeat(32), publicOrigins: [ORIGIN], escrow, linkCountersignKey: key.publicB64, now });
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
    await db?.end();
  });
  beforeEach(async () => {
    await db.query('TRUNCATE bounty_escrow_events, bounty_escrows, bounty_config CASCADE');
  });

  it('refuses a quote while the switch is off', async () => {
    await setSwitch(false);
    const r = await send(signedBody('escrow_quote', '', { amountMinor: '50000000' }));
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('funded_bounties_disabled');
  });

  it('refuses to confirm a funding while the switch is off', async () => {
    await setSwitch(false);
    const r = await send(signedBody('escrow_confirm', randomUUID(), { signature: 'abc' }));
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('funded_bounties_disabled');
  });

  it('quotes the fee on top, with the floor, once the switch is on', async () => {
    await setSwitch(true);
    const r = await send(signedBody('escrow_quote', '', { amountMinor: '50000000' }));
    expect(r.status).toBe(200);
    expect(r.body.amountMinor).toBe('50000000');
    expect(r.body.feeAmountMinor).toBe('1250000');     // 2.5% of 50
    expect(r.body.totalMinor).toBe('51250000');
    expect(r.body.flooredByMinimum).toBe(false);
  });

  it('quotes the floor on a small bounty, and says the rate it works out at', async () => {
    await setSwitch(true);
    const r = await send(signedBody('escrow_quote', '', { amountMinor: '1000000' }));
    expect(r.body.feeAmountMinor).toBe('250000');      // 25c, not 2.5c
    expect(r.body.flooredByMinimum).toBe(true);
    expect(r.body.effectiveRate).toBeCloseTo(0.25, 6);
  });

  it('refuses a zero or unreadable amount rather than quoting one', async () => {
    await setSwitch(true);
    expect((await send(signedBody('escrow_quote', '', { amountMinor: '0' }))).status).toBe(400);
    expect((await send(signedBody('escrow_quote', '', { amountMinor: 'lots' }))).status).toBe(400);
  });

  it('answers 404 for a bounty with no escrow rather than inventing one', async () => {
    await setSwitch(true);
    const r = await send(signedBody('escrow_state', randomUUID(), {}, 'admin'));
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('no_escrow');
  });

  it('lists nothing before anything is funded', async () => {
    await setSwitch(true);
    const r = await send(signedBody('escrow_list', ''));
    expect(r.status).toBe(200);
    expect(r.body.escrows).toEqual([]);
  });

  it('will not show a bounty\'s escrow to somebody who neither maintains nor funded it', async () => {
    // On the admin channel this answered for any escrow to anybody signed in.
    await setSwitch(true);
    const repo = await db.query<{ id: number }>(
      `INSERT INTO repos (owner, name, enabled) VALUES ('Grainlify','escrow-repo',true) ON CONFLICT DO NOTHING RETURNING id`);
    const repoId = repo.rows[0]?.id ?? (await db.query<{ id: number }>(`SELECT id FROM repos WHERE name = 'escrow-repo'`)).rows[0]!.id;
    const b = randomUUID();
    await db.query(
      `INSERT INTO bounties (id, repo_id, issue_number, amount_minor, currency, mint, network, status, created_by)
       VALUES ($1,$2,1,1000000,'USDC','mint','solana-devnet','posted','test')`, [b, repoId]);
    const r = await send(signedBody('escrow_state', b, {}, 'maintainer', 'stranger'));
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('not_your_bounty');
  });

  // An unsigned request must not reach these any more than it reaches the draw.
  it('refuses an unsigned request', async () => {
    await setSwitch(true);
    const r = await post('/admin/draw', { action: 'escrow_quote', amountMinor: '50000000' });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.body.totalMinor).toBeUndefined();
  });
});
