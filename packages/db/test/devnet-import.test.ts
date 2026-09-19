import { afterAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { bindLedgerMode } from '../src/pg.ts';
import { freshDatabase } from '../src/testing.ts';
import { importDevnetRun } from '../src/devnet-import.ts';

const url = process.env.TEST_DATABASE_URL;
const repo = "INSERT INTO public.repos (id, owner, name, installation_id, enabled, created_at) VALUES (7, 'o', 'r', 1, true, now());";
const b64 = (s: string) => Buffer.from(s).toString('base64');

describe.skipIf(!url)('devnet import', () => {
  const pools: pg.Pool[] = [];
  afterAll(async () => { for (const p of pools) await p.end(); });

  it('imports into a mock-bound database, once', async () => {
    const db = await freshDatabase(url!, 'test_import_mock'); pools.push(db);
    await bindLedgerMode(db, 'mock');
    await importDevnetRun(db, b64(repo), () => {});
    expect((await db.query('SELECT count(*)::int n FROM repos')).rows[0].n).toBe(1);
  });

  it('refuses a live-bound database', async () => {
    const db = await freshDatabase(url!, 'test_import_live'); pools.push(db);
    await bindLedgerMode(db, 'live');
    await expect(importDevnetRun(db, b64(repo), () => {})).rejects.toThrow(/bound to live/);
    expect((await db.query('SELECT count(*)::int n FROM repos')).rows[0].n).toBe(0);
  });

  it('refuses anything that would touch spend', async () => {
    const db = await freshDatabase(url!, 'test_import_spend'); pools.push(db);
    await bindLedgerMode(db, 'mock');
    await expect(importDevnetRun(db, b64("INSERT INTO public.inference_spend (phase, kind, status, reserved_micro) VALUES ('P1','x402_payment','reserved',1);"), () => {})).rejects.toThrow(/unexpected statement/);
  });
});
