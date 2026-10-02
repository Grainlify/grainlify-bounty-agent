// Erasing what the agent holds about a person, at Grainlify's request.
//
// Grainlify-Backend's erasure executor (internal/erasure) calls this once a
// person's deletion request has passed its grace period, signed under the
// erasure domain. The person never calls it directly.
//
// What goes: everything that is about the person rather than about a payment
// or a public decision - the wallet link (GitHub account <-> wallet), the
// nonces used to make it, their bounty applications including what they wrote,
// the GitHub profile snapshot the fit assessment read, undelivered outbox
// events, and the contributor row itself. Their login inside a stored draw
// pool is replaced, so the draw can still be re-run and checked.
//
// What stays: payouts, submissions, reviews, draws and assignments - the
// public ledger's rows. The ledger is a record of money paid and of public
// decisions, and it is never edited silently. Instead account_erasures records
// the erasure; the public API shows "erased account" wherever the login would
// have appeared, and lists the erasure as a ledger event of its own.
//
// Refused (409 at the route) while money or work is in flight: an active
// assignment, a payout not yet confirmed or failed, or an escrow the person
// funded that has not settled. Erasing then would strand the money; Grainlify
// holds the request and asks again later.
//
// Idempotent: a second call for the same account finds nothing to remove and
// succeeds, so a retry after a dropped response is harmless.

import type pg from 'pg';

/** What a login is replaced with wherever an erased account would be named. */
export const ERASED_LOGIN = 'erased account';
/** The same marker inside a stored draw pool, where a login-shaped value is expected. */
export const ERASED_POOL_LOGIN = 'erased-account';

export type EraseOutcome =
  | { ok: true; removed: Record<string, number>; alreadyErased: boolean }
  | { ok: false; inFlight: string[] };

export async function eraseAccount(db: pg.Pool, githubUserId: number): Promise<EraseOutcome> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // One erasure per account at a time; a concurrent retry waits here.
    await client.query('SELECT pg_advisory_xact_lock($1)', [githubUserId]);

    const inFlight: string[] = [];
    const q = async (sql: string) => (await client.query<{ n: boolean }>(sql, [githubUserId])).rows[0]?.n === true;
    if (await q(`SELECT EXISTS (SELECT 1 FROM bounty_assignments WHERE github_user_id = $1 AND status IN ('active','pr_submitted')) AS n`)) {
      inFlight.push('a bounty assignment in progress');
    }
    if (await q(`SELECT EXISTS (SELECT 1 FROM payouts WHERE recipient_github_user_id = $1 AND status IN ('awaiting_approval','approved','submitted')) AS n`)) {
      inFlight.push('a bounty payout not yet confirmed');
    }
    if (await q(`SELECT EXISTS (SELECT 1 FROM bounties b JOIN bounty_escrows e ON e.bounty_id = b.id
                  WHERE b.funded_by_github_user_id = $1 AND e.state IN ('funding','funded','assigned')) AS n`)) {
      inFlight.push('a bounty you funded whose escrow has not settled');
    }
    if (inFlight.length) {
      await client.query('ROLLBACK');
      return { ok: false, inFlight };
    }

    const prior = await client.query(`SELECT 1 FROM account_erasures WHERE github_user_id = $1`, [githubUserId]);

    // Every login the agent knew this account by, read before anything goes.
    const logins = await client.query<{ login: string }>(
      `SELECT DISTINCT lower(login) AS login FROM (
         SELECT login FROM contributors WHERE github_user_id = $1
         UNION SELECT author_login FROM submissions WHERE author_github_user_id = $1
         UNION SELECT github_login FROM bounty_applications WHERE github_user_id = $1
         UNION SELECT github_login FROM bounty_assignments WHERE github_user_id = $1
         UNION SELECT winner_login FROM bounty_draws WHERE winner_github_user_id = $1
       ) l WHERE login IS NOT NULL AND login <> ''`,
      [githubUserId],
    );

    const removed: Record<string, number> = {};
    const run = async (name: string, sql: string) => {
      removed[name] = (await client.query(sql, [githubUserId])).rowCount ?? 0;
    };
    await run('wallet_links', `DELETE FROM wallet_links WHERE github_user_id = $1`);
    await run('link_nonces', `DELETE FROM link_nonces WHERE github_user_id = $1`);
    await run('bounty_applications', `DELETE FROM bounty_applications WHERE github_user_id = $1`);
    await run('contributor_snapshots', `DELETE FROM contributor_snapshots WHERE github_user_id = $1`);
    await run('bounty_events', `DELETE FROM bounty_events WHERE github_user_id = $1`);
    await run('contributors', `DELETE FROM contributors WHERE github_user_id = $1`);
    // The pool is kept so a draw stays replayable; only the name inside it goes.
    await run(
      'bounty_draws.pool',
      `UPDATE bounty_draws d
          SET pool = (SELECT jsonb_agg(CASE WHEN (e->>'githubUserId')::bigint = $1
                                            THEN jsonb_set(e, '{githubLogin}', '"${ERASED_POOL_LOGIN}"')
                                            ELSE e END ORDER BY ord)
                        FROM jsonb_array_elements(d.pool) WITH ORDINALITY AS t(e, ord))
        WHERE d.pool @> jsonb_build_array(jsonb_build_object('githubUserId', $1::bigint))`,
    );

    await client.query(
      `INSERT INTO account_erasures (github_user_id, logins, removed) VALUES ($1, $2, $3)
       ON CONFLICT (github_user_id) DO UPDATE
         SET logins = (SELECT array_agg(DISTINCT x) FROM unnest(account_erasures.logins || EXCLUDED.logins) x)`,
      [githubUserId, logins.rows.map((r) => r.login), JSON.stringify(removed)],
    );
    await client.query('COMMIT');
    return { ok: true, removed, alreadyErased: (prior.rowCount ?? 0) > 0 };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** The erased accounts, for masking what the public API shows. */
export interface ErasedSet {
  ids: Set<string>;
  logins: Set<string>;
  erasures: { at: Date }[];
}

export async function loadErased(db: pg.Pool): Promise<ErasedSet> {
  try {
    const r = await db.query<{ github_user_id: string; logins: string[]; erased_at: Date }>(
      `SELECT github_user_id::text, logins, erased_at FROM account_erasures ORDER BY erased_at`,
    );
    return {
      ids: new Set(r.rows.map((x) => x.github_user_id)),
      logins: new Set(r.rows.flatMap((x) => x.logins.map((l) => l.toLowerCase()))),
      erasures: r.rows.map((x) => ({ at: new Date(x.erased_at) })),
    };
  } catch {
    // A missing table (an agent not yet migrated) must not take the public
    // pages down; it means nobody has been erased here yet.
    return { ids: new Set(), logins: new Set(), erasures: [] };
  }
}

/** The login to show: the real one, or ERASED_LOGIN for an erased account. */
export function shownLogin(erased: ErasedSet, login: string | null, githubUserId?: string | number | null): string | null {
  if (login === null || login === undefined) return login ?? null;
  if (githubUserId !== null && githubUserId !== undefined && erased.ids.has(String(githubUserId))) return ERASED_LOGIN;
  if (erased.logins.has(login.toLowerCase())) return ERASED_LOGIN;
  return login;
}
