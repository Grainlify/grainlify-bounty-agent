// Housekeeping for link_nonces.
//
// A nonce is spent once and then only ever refused. Its security value expires
// with the message that carries it: the agent refuses anything whose Expires
// line has passed (ten minutes), and that check runs BEFORE the nonce is
// looked at. So a row older than the retention window below can no longer
// change any outcome - a replay of that message is refused as expired whether
// the row is there or not.
//
// Kept for a week rather than deleted at expiry, because the rows answer
// "did this person's link attempt reach us, and when" while anybody is still
// asking. After that they are only a table that grows for ever.

import type pg from 'pg';

export const LINK_NONCE_RETENTION_DAYS = 7;

/** Deletes spent nonces older than the retention window. Returns how many went. */
export async function pruneLinkNonces(db: pg.Pool, retentionDays = LINK_NONCE_RETENTION_DAYS): Promise<number> {
  const r = await db.query(`DELETE FROM link_nonces WHERE used_at < now() - ($1 || ' days')::interval`, [String(retentionDays)]);
  return r.rowCount ?? 0;
}

/**
 * Prunes now and then hourly. Returns a stop function.
 *
 * unref() so a pending timer never holds the process open - a CLI command that
 * finished its work should exit, not wait an hour.
 */
export function startLinkNoncePruning(db: pg.Pool, log: (m: string) => void = console.log, everyMs = 60 * 60_000): () => void {
  const sweep = () => {
    pruneLinkNonces(db)
      .then((n) => n > 0 && log(`pruned ${n} spent link nonce(s) older than ${LINK_NONCE_RETENTION_DAYS} days`))
      .catch((e) => log(`link nonce pruning failed, continuing: ${e instanceof Error ? e.message : String(e)}`));
  };
  sweep();
  const timer = setInterval(sweep, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
