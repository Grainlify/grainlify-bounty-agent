// GET /api/payouts/:id returns the recipient's wallet address and the whole
// gate result for a bounty that has not been paid yet. It was readable by
// anyone who knew the id. These tests pin that it is not.

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDatabase } from '../../../packages/db/src/testing.ts';
import { p2Config } from '../src/config.ts';
import { createAgentServer } from '../src/server.ts';
import { BountyService } from '../src/service.ts';
import { FakeGitHub } from './fake-github.ts';

const dbUrl = process.env.TEST_DATABASE_URL;
const TOKEN = 'payouts-token-0123456789abcdefghijklmn';
const ID = '11111111-2222-4333-8444-555555555555';

describe.skipIf(!dbUrl)('the payouts API is not public', () => {
  let db: pg.Pool;
  const servers: Server[] = [];

  async function serve(payoutsApiToken?: string) {
    const cfg = p2Config({ mints: {}, trustedApprovers: [] });
    const service = new BountyService({ db, gh: new FakeGitHub(), x402: {} as never, payoutSigner: {} as never, cfg });
    const s = createAgentServer({ db, service, webhookSecret: 'x'.repeat(32), payoutsApiToken });
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  }

  beforeAll(async () => {
    db = await freshDatabase(dbUrl!, 'test_payouts_api');
  });
  afterAll(async () => {
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
    await db.end();
  });

  it('refuses a read with no token, a wrong token, or a malformed header', async () => {
    const url = await serve(TOKEN);
    for (const headers of [undefined, { authorization: 'Bearer wrong-token-of-the-same-length!!' }, { authorization: TOKEN }, { authorization: 'Basic ' + TOKEN }, { authorization: 'Bearer ' }]) {
      const r = await fetch(`${url}/api/payouts/${ID}`, { headers: headers as HeadersInit });
      expect(r.status, JSON.stringify(headers)).toBe(401);
      expect(await r.json()).toEqual({ error: 'unauthorized' });
    }
  });

  it('refuses every read when no token is configured, rather than serving them', async () => {
    const url = await serve(undefined);
    const r = await fetch(`${url}/api/payouts/${ID}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: 'payouts_api_token_not_configured' });
  });

  it('answers a correct token, and says "not found" the same way for any unknown id', async () => {
    const url = await serve(TOKEN);
    const r = await fetch(`${url}/api/payouts/${ID}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(r.status).toBe(404); // authorised, but no such payout
    expect(await r.json()).toEqual({ error: 'not found' });
  });

  it('refuses before looking the payout up, so a refusal cannot confirm an id exists', async () => {
    // Both a real-looking and a nonsense id must give the identical 401.
    const url = await serve(TOKEN);
    const a = await fetch(`${url}/api/payouts/${ID}`);
    const b = await fetch(`${url}/api/payouts/99999999-8888-4777-8666-555555555555`);
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(await a.text()).toBe(await b.text());
  });
});
