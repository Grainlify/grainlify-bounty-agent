// Runs only when TEST_DATABASE_URL is set (docker compose up -d postgres).

import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { budgetConfig } from '../../budget/src/governor.ts';
import { bindLedgerMode, PgReceiptStore, PgSpendLedger } from '../src/pg.ts';
import { freshDatabase } from '../src/testing.ts';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('postgres receipts and spend ledger', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = await freshDatabase(url!, 'test_pg_ledger');
  });
  afterAll(async () => {
    await pool?.end();
  });

  it('round-trips a receipt through insert and update', async () => {
    const store = new PgReceiptStore(pool);
    const id = randomUUID();
    await store.insert({ id, purpose: 'spike', phase: 'P1', model: 'gpt-oss-120b', path: '/proxy/x402/v1/chat/completions', links: { repo: 'a/b', issueNumber: 7 }, routingRequested: { mode: 'marketplace-only' }, maxTokens: 32, requestSha256: 'ab', status: 'quoting', createdAt: new Date() });
    const rec = await store.update(id, { status: 'served', scheme: 'onchain', paidMicro: 35, feeMicro: 2_004, paymentResponse: { ok: true }, responseHeaders: { 'x-pod-route': 'marketplace' } });
    expect(rec).toMatchObject({ id, status: 'served', paidMicro: 35, feeMicro: 2_004, links: { repo: 'a/b', issueNumber: 7 }, paymentResponse: { ok: true } });
  });

  it('never lets concurrent reservations cross the ceiling', async () => {
    await pool.query('DELETE FROM inference_spend');
    const ledger = new PgSpendLedger(pool, budgetConfig({ lifetimeCeilingMicro: 10_000 }));
    const results = await Promise.all(Array.from({ length: 30 }, () => ledger.reserve({ phase: 'P1', kind: 'x402_payment', amountMicro: 1_000, callId: null })));
    expect(results.filter((r) => r.decision.ok)).toHaveLength(10);
    expect((await ledger.totals()).lifetimeMicro).toBe(10_000);
    const refused = results.find((r) => !r.decision.ok)!;
    expect(refused.decision).toMatchObject({ ok: false, code: 'ceiling_reached' });
  });

  it('binds a database to mock or live money once and refuses the other mode', async () => {
    const mockDb = await freshDatabase(url!, 'test_ledger_mode_mock');
    await bindLedgerMode(mockDb, 'mock');
    await bindLedgerMode(mockDb, 'mock'); // idempotent
    await expect(bindLedgerMode(mockDb, 'live')).rejects.toThrow(/mock ledger/);
    await mockDb.end();
    const liveDb = await freshDatabase(url!, 'test_ledger_mode_live');
    await bindLedgerMode(liveDb, 'live');
    await expect(bindLedgerMode(liveDb, 'mock')).rejects.toThrow(/live ledger/);
    await liveDb.end();
  });
});
