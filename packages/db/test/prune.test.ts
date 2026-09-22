import type pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase } from '../src/testing.ts';
import { LINK_NONCE_RETENTION_DAYS, pruneLinkNonces, startLinkNoncePruning } from '../src/prune.ts';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('spent link nonces do not accumulate for ever', () => {
  let db: pg.Pool;
  const add = (nonce: string, ageDays: number) =>
    db.query(`INSERT INTO link_nonces (nonce, github_user_id, used_at) VALUES ($1, 1, now() - ($2 || ' days')::interval)`, [nonce, String(ageDays)]);
  const left = async () => (await db.query<{ nonce: string }>(`SELECT nonce FROM link_nonces ORDER BY nonce`)).rows.map((r) => r.nonce);

  beforeEach(async () => {
    db ??= await freshDatabase(url!, 'test_prune_nonces');
    await db.query('TRUNCATE link_nonces');
  });
  afterAll(async () => { await db?.end(); });

  it('deletes what is past the retention window and keeps the rest', async () => {
    await add('old', LINK_NONCE_RETENTION_DAYS + 1);
    await add('exactly-inside', LINK_NONCE_RETENTION_DAYS - 1);
    await add('fresh', 0);
    expect(await pruneLinkNonces(db)).toBe(1);
    expect(await left()).toEqual(['exactly-inside', 'fresh']);
  });

  it('is safe to run when there is nothing to do', async () => {
    expect(await pruneLinkNonces(db)).toBe(0);
    await add('fresh', 0);
    expect(await pruneLinkNonces(db)).toBe(0);
    expect(await left()).toEqual(['fresh']);
  });

  it('never removes a nonce that could still be replayed', async () => {
    // A message is refused once its ten-minute Expires has passed, before the
    // nonce is consulted. So anything the window keeps is far older than any
    // message that could still be accepted - checked here as an ordering fact.
    const tenMinutesInDays = 10 / (60 * 24);
    expect(LINK_NONCE_RETENTION_DAYS).toBeGreaterThan(tenMinutesInDays * 100);
  });

  it('sweeps on start and stops cleanly', async () => {
    await add('old', LINK_NONCE_RETENTION_DAYS + 2);
    const lines: string[] = [];
    const stop = startLinkNoncePruning(db, (m) => lines.push(m), 60_000);
    await new Promise((r) => setTimeout(r, 300));
    stop();
    expect(await left()).toEqual([]);
    expect(lines.join(' ')).toMatch(/pruned 1 spent link nonce/);
  });
});
