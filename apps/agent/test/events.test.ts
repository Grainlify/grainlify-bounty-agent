// The outbox and its delivery. Needs TEST_DATABASE_URL.

import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshDatabase } from '../../../packages/db/src/testing.ts';
import { dedupe, enqueueEvent } from '../src/events.ts';
import { deliverOnce, signEventBody, startEventSender } from '../src/event-sender.ts';

const dbUrl = process.env.TEST_DATABASE_URL;
const SECRET = 's'.repeat(40);

describe.skipIf(!dbUrl)('the event outbox', () => {
  let db: pg.Pool;

  beforeAll(async () => {
    db = await freshDatabase(dbUrl!, 'test_events');
  });
  beforeEach(async () => {
    await db.query('TRUNCATE bounty_events');
  });
  afterAll(async () => {
    await db?.end();
  });

  const ev = (over: Record<string, unknown> = {}) => ({
    kind: 'bounty_draw_won' as const,
    githubUserId: 42,
    dedupeKey: 'draw_won:b1:d1',
    payload: { repo: 'a/b' },
    ...over,
  });

  // The requirement: a re-run of the draw or the sweeper must not send
  // duplicates. It is a unique key rather than retry logic, so no emitter can
  // get it wrong on its own.
  it('records an event once however many times it is enqueued', async () => {
    expect(await enqueueEvent(db, ev())).toBe(true);
    expect(await enqueueEvent(db, ev())).toBe(false);
    expect(await enqueueEvent(db, ev())).toBe(false);
    const r = await db.query(`SELECT count(*)::int AS n FROM bounty_events`);
    expect(r.rows[0].n).toBe(1);
  });

  it('treats a different draw of the same bounty as a different event', async () => {
    await enqueueEvent(db, ev({ dedupeKey: dedupe.drawWon('b1', 'draw-1') }));
    await enqueueEvent(db, ev({ dedupeKey: dedupe.drawWon('b1', 'draw-2') }));
    expect((await db.query(`SELECT count(*)::int AS n FROM bounty_events`)).rows[0].n).toBe(2);
  });

  it('keys the expiry warning to the assignment, so a sweep every minute warns once', async () => {
    const id = randomUUID();
    for (let i = 0; i < 50; i++) {
      await enqueueEvent(db, ev({ kind: 'bounty_assignment_expiring', dedupeKey: dedupe.assignmentExpiring(id) }));
    }
    expect((await db.query(`SELECT count(*)::int AS n FROM bounty_events`)).rows[0].n).toBe(1);
  });

  // An emitter is always in the middle of something that matters more.
  it('never throws, so a notification cannot take down the thing that caused it', async () => {
    const broken = { query: async () => { throw new Error('db gone'); } } as unknown as pg.Pool;
    await expect(enqueueEvent(broken, ev())).resolves.toBe(false);
  });
});

describe.skipIf(!dbUrl)('delivering events', () => {
  let db: pg.Pool;

  beforeAll(async () => {
    db = await freshDatabase(dbUrl!, 'test_event_sender');
  });
  beforeEach(async () => {
    await db.query('TRUNCATE bounty_events');
    await enqueueEvent(db, { kind: 'bounty_draw_won', githubUserId: 7, dedupeKey: 'k1', payload: { repo: 'a/b' } });
  });
  afterAll(async () => {
    await db?.end();
  });

  const okFetch = () => vi.fn().mockResolvedValue({ ok: true, text: async () => '' }) as unknown as typeof fetch;

  it('signs the exact body it sends', async () => {
    const f = okFetch();
    await deliverOnce({ db, backendUrl: 'https://api.test', secret: SECRET, f });
    const [, init] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    const body = init.body as string;
    expect((init.headers as Record<string, string>)['x-bounty-signature-256']).toBe(signEventBody(SECRET, body));
  });

  it('marks delivered, and does not send the same event twice', async () => {
    const f = okFetch();
    expect(await deliverOnce({ db, backendUrl: 'https://api.test', secret: SECRET, f })).toBe(1);
    expect(await deliverOnce({ db, backendUrl: 'https://api.test', secret: SECRET, f })).toBe(0);
    expect((f as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1);
  });

  // A backend that is down must not lose the event.
  it('leaves a failed delivery to be retried, with the reason recorded', async () => {
    const f = vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => 'down' }) as unknown as typeof fetch;
    expect(await deliverOnce({ db, backendUrl: 'https://api.test', secret: SECRET, f })).toBe(0);
    const r = await db.query<{ attempts: number; last_error: string; delivered_at: Date | null }>(
      `SELECT attempts, last_error, delivered_at FROM bounty_events`,
    );
    expect(r.rows[0]).toMatchObject({ attempts: 1, delivered_at: null });
    expect(r.rows[0]!.last_error).toContain('503');

    const ok = okFetch();
    expect(await deliverOnce({ db, backendUrl: 'https://api.test', secret: SECRET, f: ok })).toBe(1);
  });

  it('survives the backend being unreachable entirely', async () => {
    const f = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    await expect(deliverOnce({ db, backendUrl: 'https://api.test', secret: SECRET, f })).resolves.toBe(0);
    expect((await db.query<{ last_error: string }>(`SELECT last_error FROM bounty_events`)).rows[0]!.last_error).toContain('ECONNREFUSED');
  });

  it('gives up after enough attempts rather than blocking everything behind it', async () => {
    await db.query(`UPDATE bounty_events SET attempts = 10`);
    const f = okFetch();
    expect(await deliverOnce({ db, backendUrl: 'https://api.test', secret: SECRET, f })).toBe(0);
    expect((f as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
  });

  it('sends nothing when it is not configured, and says so loudly', async () => {
    const lines: string[] = [];
    const s = startEventSender({ db, log: (l) => lines.push(l) });
    s.stop();
    expect(lines.join('\n')).toContain('contributors will NOT be notified');
  });
});
