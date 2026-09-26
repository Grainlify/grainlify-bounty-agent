// GET-side of the wallet link: POST /link/session/read, end to end against
// Postgres. Needs TEST_DATABASE_URL.
//
// This file exists because the read query named a column that has never
// existed (linked_at; the column is verified_at). Every unit test around it
// passed, because they all stopped at the verifier or stubbed the database,
// so nothing ever ran the SQL. The failure reached production and showed up
// as an unexplained 400 with a browser CORS error stacked on top of it.
// The rule this encodes: a query is only tested by executing it.

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Keypair } from '@solana/web3.js';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase } from '../../../packages/db/src/testing.ts';
import { grainlifyKey, linkRequest, readRequest } from '../../../packages/gate/test/session-support.ts';
import { p2Config } from '../src/config.ts';
import { PublicApi } from '../src/public.ts';
import { createAgentServer } from '../src/server.ts';
import { BountyService } from '../src/service.ts';
import { FakeGitHub } from './fake-github.ts';

const dbUrl = process.env.TEST_DATABASE_URL;
const ORIGIN = 'https://grainlify.com';

describe.skipIf(!dbUrl)('reading a wallet link from a Grainlify session (HTTP + Postgres)', () => {
  const key = grainlifyKey();
  let db: pg.Pool;
  let now = new Date('2026-09-26T14:05:00Z');
  const issued = () => new Date(now.getTime() - 60_000);
  let url: string;
  const servers: Server[] = [];

  const post = async (path: string, body: unknown) => {
    const r = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown>, headers: r.headers };
  };

  beforeAll(async () => {
    db = await freshDatabase(dbUrl!, 'test_session_read');
    const cfg = p2Config({ mints: {}, trustedApprovers: [] });
    const service = new BountyService({
      db,
      gh: new FakeGitHub(),
      x402: {} as never,
      payoutSigner: {} as never,
      cfg,
      linkCountersignKey: key.publicB64,
      now: () => now,
    });
    const s = createAgentServer({ db, service, webhookSecret: 'x'.repeat(32), publicApi: new PublicApi(db, cfg), publicOrigins: [ORIGIN] });
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  });
  beforeEach(async () => {
    now = new Date('2026-09-26T14:05:00Z');
    await db.query('TRUNCATE wallet_links, link_nonces, contributors CASCADE');
  });
  afterAll(async () => {
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
    await db.end();
  });

  it('answers "no wallet" for an account that has never linked one', async () => {
    const r = await post('/link/session/read', readRequest(key, { login: 'Octocat', id: 583231, issued: issued() }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ linked: false, wallet: null, linkedAt: null, githubLogin: 'Octocat' });
  });

  it('returns the wallet and when it was linked, once one is linked', async () => {
    const wallet = Keypair.generate();
    const linked = await post('/link/session', linkRequest(key, wallet, { login: 'Octocat', id: 583231, issued: issued() }));
    expect(linked.status).toBe(201);

    const r = await post('/link/session/read', readRequest(key, { login: 'Octocat', id: 583231, issued: issued() }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ linked: true, wallet: wallet.publicKey.toBase58(), githubLogin: 'Octocat' });
    // Whatever the column is called underneath, the wire shape is an ISO
    // timestamp the page can render.
    expect(new Date(String(r.body.linkedAt)).toISOString()).toBe(String(r.body.linkedAt));
  });

  it('reads one account only: another account still has no wallet', async () => {
    const wallet = Keypair.generate();
    await post('/link/session', linkRequest(key, wallet, { login: 'Octocat', id: 583231, issued: issued() }));
    const r = await post('/link/session/read', readRequest(key, { login: 'Someone', id: 999001, issued: issued() }));
    expect(r.body).toMatchObject({ linked: false, wallet: null });
  });

  it('a revoked link reads as no wallet', async () => {
    const wallet = Keypair.generate();
    await post('/link/session', linkRequest(key, wallet, { login: 'Octocat', id: 583231, issued: issued() }));
    await db.query(`UPDATE wallet_links SET revoked_at = now() WHERE github_user_id = 583231`);
    const r = await post('/link/session/read', readRequest(key, { login: 'Octocat', id: 583231, issued: issued() }));
    expect(r.body).toMatchObject({ linked: false, wallet: null, linkedAt: null });
  });

  it('a read challenge cannot be replayed as a link: it carries no wallet', async () => {
    const read = readRequest(key, { login: 'Octocat', id: 583231, issued: issued() });
    const r = await post('/link/session', { ...read, walletSignature: 'AA' });
    expect(r.status).toBe(400);
    expect((await post('/link/session/read', readRequest(key, { login: 'Octocat', id: 583231, issued: issued() }))).body).toMatchObject({ linked: false });
  });

  it('a server fault answers 500 with CORS headers, not a bare 400', async () => {
    await db.query('ALTER TABLE wallet_links RENAME TO wallet_links_hidden');
    try {
      const r = await post('/link/session/read', readRequest(key, { login: 'Octocat', id: 583231, issued: issued() }));
      expect(r.status).toBe(500);
      expect(r.body).toMatchObject({ error: 'internal' });
      // A reference to join the caller's report to our log, without putting
      // the internal detail on the wire.
      expect(String(r.body.ref)).toMatch(/^[0-9a-f]{8}$/);
      expect(JSON.stringify(r.body)).not.toContain('wallet_links');
      expect(r.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    } finally {
      await db.query('ALTER TABLE wallet_links_hidden RENAME TO wallet_links');
    }
  });
});
