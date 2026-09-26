// POST /link/session end to end against Postgres: the two signatures, the
// single-use nonce, one wallet per account, and the CORS surface. Needs
// TEST_DATABASE_URL.

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Keypair } from '@solana/web3.js';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase } from '../../../packages/db/src/testing.ts';
import { grainlifyKey, linkRequest } from '../../../packages/gate/test/session-support.ts';
import { p2Config } from '../src/config.ts';
import { createAgentServer } from '../src/server.ts';
import { BountyService } from '../src/service.ts';
import { PublicApi } from '../src/public.ts';
import { FakeGitHub } from './fake-github.ts';

const dbUrl = process.env.TEST_DATABASE_URL;
const ORIGIN = 'https://grainlify.com';

describe.skipIf(!dbUrl)('wallet link from a Grainlify session (HTTP + Postgres)', () => {
  const key = grainlifyKey();
  let db: pg.Pool;
  let now = new Date('2026-09-19T14:05:00Z');
  const issued = () => new Date(now.getTime() - 60_000);
  const servers: Server[] = [];

  async function serve(linkCountersignKey: string | undefined) {
    const cfg = p2Config({ mints: {}, trustedApprovers: [] });
    const service = new BountyService({ db, gh: new FakeGitHub(), x402: {} as never, payoutSigner: {} as never, cfg, linkCountersignKey, now: () => now });
    const s = createAgentServer({ db, service, webhookSecret: 'x'.repeat(32), publicApi: new PublicApi(db, cfg), publicOrigins: [ORIGIN] });
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  }
  let url: string;
  const post = async (body: unknown, origin = ORIGIN) => {
    const r = await fetch(`${url}/link/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown>, headers: r.headers };
  };
  const live = async (githubUserId: number) =>
    (await db.query(`SELECT address, source FROM wallet_links WHERE github_user_id = $1 AND revoked_at IS NULL`, [githubUserId])).rows as { address: string; source: string }[];

  beforeAll(async () => {
    db = await freshDatabase(dbUrl!, 'test_session_link');
    url = await serve(key.publicB64);
  });
  beforeEach(async () => {
    now = new Date('2026-09-19T14:05:00Z');
    await db.query('TRUNCATE wallet_links, link_nonces, contributors CASCADE');
  });
  afterAll(async () => {
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
    await db.end();
  });

  it('links the wallet to the countersigned account and stores it atomically', async () => {
    const wallet = Keypair.generate();
    const r = await post(linkRequest(key, wallet, { login: 'Octocat', id: 583231, issued: issued() }));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ linked: true, wallet: wallet.publicKey.toBase58(), githubLogin: 'Octocat', replaced: null });
    expect(r.headers.get('cache-control')).toBe('no-store');
    const rows = await live(583231);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ address: wallet.publicKey.toBase58(), source: expect.stringMatching(/^grainlify-session:[0-9a-f]{32}$/) });
    expect((await db.query(`SELECT login FROM contributors WHERE github_user_id = 583231`)).rows[0]).toEqual({ login: 'Octocat' });
  });

  it('refuses a replayed request: the nonce is single-use', async () => {
    const req = linkRequest(key, Keypair.generate(), { login: 'Octocat', id: 583231, issued: issued() });
    expect((await post(req)).status).toBe(201);
    const again = await post(req);
    expect(again).toMatchObject({ status: 409, body: { error: 'nonce_used' } });
  });

  it('lets exactly one of two simultaneous replays through', async () => {
    const req = linkRequest(key, Keypair.generate(), { login: 'Octocat', id: 583231, issued: issued() });
    const codes = (await Promise.all([post(req), post(req), post(req)])).map((r) => r.status).sort();
    expect(codes).toEqual([201, 409, 409]);
  });

  it('refuses an expired request and stores nothing', async () => {
    const req = linkRequest(key, Keypair.generate(), { login: 'Octocat', id: 583231, issued: issued() });
    now = new Date(now.getTime() + 11 * 60_000);
    expect(await post(req)).toMatchObject({ status: 400, body: { error: 'expired' } });
    expect(await live(583231)).toEqual([]);
    expect((await db.query('SELECT count(*)::int AS n FROM link_nonces')).rows[0].n).toBe(0);
  });

  it('refuses one wallet on two GitHub accounts', async () => {
    const wallet = Keypair.generate();
    expect((await post(linkRequest(key, wallet, { login: 'Octocat', id: 583231, issued: issued() }))).status).toBe(201);
    const second = await post(linkRequest(key, wallet, { login: 'baskarayelu', id: 777, issued: issued() }));
    expect(second).toMatchObject({ status: 409, body: { error: 'wallet_linked_to_another_account' } });
    expect(await live(777)).toEqual([]);
    expect((await live(583231))[0]?.address).toBe(wallet.publicKey.toBase58());
  });

  it('replaces an account’s earlier wallet, and treats the same wallet as unchanged', async () => {
    const first = Keypair.generate();
    const second = Keypair.generate();
    await post(linkRequest(key, first, { login: 'Octocat', id: 583231, issued: issued() }));
    const same = await post(linkRequest(key, first, { login: 'Octocat', id: 583231, issued: issued() }));
    expect(same).toMatchObject({ status: 200, body: { unchanged: true } });
    const swap = await post(linkRequest(key, second, { login: 'Octocat', id: 583231, issued: issued() }));
    expect(swap).toMatchObject({ status: 201, body: { replaced: first.publicKey.toBase58() } });
    expect((await live(583231)).map((r) => r.address)).toEqual([second.publicKey.toBase58()]);
  });

  it('refuses bad signatures and junk bodies without storing anything', async () => {
    const other = grainlifyKey();
    expect(await post(linkRequest(other, Keypair.generate(), { login: 'Octocat', id: 583231, issued: issued() }))).toMatchObject({ status: 400, body: { error: 'bad_countersignature' } });
    const req = linkRequest(key, Keypair.generate(), { login: 'Octocat', id: 583231, issued: issued() });
    expect(await post({ ...req, walletSignature: linkRequest(key, Keypair.generate(), { login: 'x', id: 1, issued: issued() }).walletSignature })).toMatchObject({ status: 400, body: { error: 'bad_wallet_signature' } });
    const junk = await fetch(`${url}/link/session`, { method: 'POST', body: 'not json' });
    expect(junk.status).toBe(400);
    const big = await fetch(`${url}/link/session`, { method: 'POST', body: JSON.stringify({ message: 'x'.repeat(20_000) }) });
    expect(big.status).toBe(400);
    expect((await db.query('SELECT count(*)::int AS n FROM wallet_links')).rows[0].n).toBe(0);
    expect((await db.query('SELECT count(*)::int AS n FROM link_nonces')).rows[0].n).toBe(0);
  });

  it('allows the browser call from grainlify.com only, POST only', async () => {
    const pre = await fetch(`${url}/link/session`, { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'POST' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(pre.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS');
    expect(pre.headers.get('access-control-allow-headers')).toBe('*');
    // An unrecognised origin gets a readable answer, not silence: it is still
    // refused by the signature checks, and withholding the header only ever
    // hid working replies from browser extensions that rewrite Origin.
    const other = await fetch(`${url}/link/session`, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    expect(other.headers.get('access-control-allow-origin')).toBe('*');
    expect((await fetch(`${url}/link/session`)).status).toBe(405);
    // The read-only public API is unchanged: still GET only.
    const pub = await fetch(`${url}/public/status`, { method: 'OPTIONS', headers: { origin: ORIGIN } });
    expect(pub.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS');
  });

  it('answers 503 when no Grainlify key is configured', async () => {
    const off = await serve(undefined);
    const r = await fetch(`${off}/link/session`, { method: 'POST', body: JSON.stringify(linkRequest(key, Keypair.generate(), { login: 'Octocat', id: 583231, issued: issued() })) });
    expect(r.status).toBe(503);
    expect(await live(583231)).toEqual([]);
  });
});
