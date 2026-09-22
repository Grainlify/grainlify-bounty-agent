// One line per request, and never a secret in it.
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
const TOKEN = 'payouts-token-0123456789abcdefghijklmn';

describe.skipIf(!dbUrl)('request log', () => {
  const key = grainlifyKey();
  let db: pg.Pool;
  let url: string;
  let lines: string[];
  const servers: Server[] = [];

  beforeAll(async () => {
    db = await freshDatabase(dbUrl!, 'test_request_log');
    lines = [];
    const cfg = p2Config({ mints: {}, trustedApprovers: [] });
    const service = new BountyService({ db, gh: new FakeGitHub(), x402: {} as never, payoutSigner: {} as never, cfg, linkCountersignKey: key.publicB64 });
    const s = createAgentServer({ db, service, webhookSecret: 'x'.repeat(32), publicApi: new PublicApi(db, cfg), publicOrigins: ['https://grainlify.com'], payoutsApiToken: TOKEN, log: (l) => lines.push(l) });
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  });
  beforeEach(async () => {
    lines.length = 0;
    await db.query('TRUNCATE wallet_links, link_nonces, contributors CASCADE');
  });
  afterAll(async () => {
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
    await db.end();
  });

  it('logs method, path, status and duration for an ordinary read', async () => {
    await fetch(`${url}/health`);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^GET \/health 200 \d+ms$/);
  });

  it('logs a successful link with its outcome and the GitHub id, and no secret', async () => {
    const wallet = Keypair.generate();
    const body = linkRequest(key, wallet, { login: 'octocat', id: 583231, issued: new Date(Date.now() - 60_000) });
    const r = await fetch(`${url}/link/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(r.status).toBe(201);
    const line = lines.find((l) => l.includes('/link/session'))!;
    expect(line).toMatch(/^POST \/link\/session 201 \d+ms link=linked github=583231$/);
    for (const secret of [body.countersignature, body.walletSignature, body.message, wallet.publicKey.toBase58()]) {
      expect(line).not.toContain(secret);
    }
  });

  it('logs a refusal with its reason, so a failed attempt is traceable', async () => {
    const body = linkRequest(grainlifyKey(), Keypair.generate(), { login: 'octocat', id: 583231, issued: new Date(Date.now() - 60_000) });
    await fetch(`${url}/link/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(lines.find((l) => l.includes('/link/session'))).toMatch(/^POST \/link\/session 400 \d+ms link=refused reason=bad_countersignature$/);
  });

  it('tells a replay apart from a first attempt', async () => {
    const body = linkRequest(key, Keypair.generate(), { login: 'octocat', id: 583231, issued: new Date(Date.now() - 60_000) });
    await fetch(`${url}/link/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    await fetch(`${url}/link/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const link = lines.filter((l) => l.includes('/link/session'));
    expect(link[0]).toContain('link=linked');
    expect(link[1]).toContain('link=refused reason=nonce_used');
  });

  it('never logs the payouts token or an Authorization header', async () => {
    await fetch(`${url}/api/payouts/11111111-2222-4333-8444-555555555555`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const line = lines.find((l) => l.includes('/api/payouts'))!;
    expect(line).toMatch(/^GET \/api\/payouts\/[0-9a-f-]+ 404 \d+ms$/);
    expect(line).not.toContain(TOKEN);
    expect(line.toLowerCase()).not.toContain('bearer');
  });

  it('keeps a caller-supplied query string out of the log', async () => {
    await fetch(`${url}/public/ledger?evil=<script>alert(1)</script>`);
    const line = lines.find((l) => l.includes('/public/ledger'))!;
    expect(line).toBe(line.split('?')[0]);
    expect(line).not.toContain('evil');
  });
});
