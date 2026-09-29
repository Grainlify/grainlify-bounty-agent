// Delivers queued events to Grainlify, which owns notifications.
//
// Signed with HMAC-SHA256 over the exact body, the same shape as the GitHub
// webhook this service already verifies on the way in. A shared secret rather
// than the ed25519 pair used elsewhere, because that pair runs the other way:
// Grainlify holds the private half and this service only has the public one,
// so it can verify Grainlify's signatures and cannot make its own.
//
// Nothing here is allowed to lose an event or send one twice. A failed
// delivery leaves the row undelivered and is retried; a successful one stamps
// delivered_at in the same statement that would let it be picked up again.

import { createHmac } from 'node:crypto';
import type pg from 'pg';

export const EVENT_TICK_MS = 20_000;

export interface EventSenderDeps {
  db: pg.Pool;
  /** Grainlify's base URL. Absent switches delivery off. */
  backendUrl?: string;
  /** Shared with the backend as BOUNTY_EVENTS_SECRET. */
  secret?: string;
  log?: (line: string) => void;
  f?: typeof fetch;
}

export function signEventBody(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/**
 * Sends one batch. Returns how many were delivered.
 *
 * Small batches on purpose: a backend that is struggling should be asked
 * gently, and an event that cannot be delivered should not block the ones
 * behind it forever - after enough attempts it is left with its error
 * recorded, visible, and out of the way.
 */
export async function deliverOnce(d: EventSenderDeps, limit = 20): Promise<number> {
  if (!d.backendUrl || !d.secret) return 0;
  const f = d.f ?? fetch;
  const rows = await d.db.query<{ id: string; kind: string; github_user_id: string; payload: unknown; created_at: Date }>(
    `SELECT id, kind, github_user_id, payload, created_at
       FROM bounty_events
      WHERE delivered_at IS NULL AND attempts < 10
      ORDER BY created_at LIMIT $1`,
    [limit],
  );
  let sent = 0;
  for (const row of rows.rows) {
    const body = JSON.stringify({
      id: String(row.id),
      kind: row.kind,
      githubUserId: Number(row.github_user_id),
      payload: row.payload,
      occurredAt: new Date(row.created_at).toISOString(),
    });
    try {
      const res = await f(`${d.backendUrl.replace(/\/+$/, '')}/internal/bounty-events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-bounty-signature-256': signEventBody(d.secret, body) },
        body,
      });
      if (res.ok) {
        await d.db.query(`UPDATE bounty_events SET delivered_at = now(), last_error = NULL WHERE id = $1`, [row.id]);
        sent++;
      } else {
        const text = await res.text().catch(() => '');
        await d.db.query(
          `UPDATE bounty_events SET attempts = attempts + 1, last_error = $2 WHERE id = $1`,
          [row.id, `${res.status} ${text}`.slice(0, 500)],
        );
      }
    } catch (e) {
      await d.db.query(
        `UPDATE bounty_events SET attempts = attempts + 1, last_error = $2 WHERE id = $1`,
        [row.id, String(e instanceof Error ? e.message : e).slice(0, 500)],
      );
    }
  }
  return sent;
}

export function startEventSender(d: EventSenderDeps, tickMs = EVENT_TICK_MS): { stop: () => void } {
  const log = d.log ?? ((l: string) => console.log(l));
  if (!d.backendUrl || !d.secret) {
    // Said once, loudly. Silence here would mean contributors quietly never
    // hearing that they won, which is the exact failure this exists to fix.
    log('event sender: BOUNTY_EVENTS_URL or BOUNTY_EVENTS_SECRET not set; contributors will NOT be notified');
    return { stop: () => {} };
  }
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const n = await deliverOnce(d);
      if (n > 0) log(`event sender: delivered ${n}`);
    } catch (e) {
      log(`event sender: batch failed, will retry: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), tickMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
