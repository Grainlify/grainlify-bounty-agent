// One-shot import of a recorded devnet test run into a MOCK-bound database, so
// the public pages can show it. The rows arrive as base64 SQL in an env var
// (never in git) and are applied once, in one transaction, only if:
//   - the database is bound to mock (a live ledger can never receive them);
//   - the rows touch no spend table (nothing can count against any budget);
//   - the run is not already present (idempotent across restarts).

import type pg from 'pg';

const ALLOWED = /^INSERT INTO public\.(repos|contributors|wallet_links|inference_calls|bounties|submissions|reviews|payouts) /;

export async function importDevnetRun(db: pg.Pool, b64: string | undefined, log: (m: string) => void = console.log) {
  if (!b64) return;
  // Split at statement starts, not lines: values (a signed link message) contain newlines.
  const statements = Buffer.from(b64, 'base64').toString('utf8').split(/\n(?=INSERT INTO )/).map((x) => x.trim()).filter(Boolean);
  const bad = statements.find((s) => !ALLOWED.test(s));
  if (bad) throw new Error(`devnet import refused: unexpected statement ${bad.slice(0, 60)}`);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const mode = (await client.query('SELECT mode FROM ledger_meta')).rows[0]?.mode;
    if (mode !== 'mock') throw new Error(`devnet import refused: database is bound to ${mode}, not mock`);
    const firstBounty = statements.find((s) => s.startsWith('INSERT INTO public.bounties '));
    const id = firstBounty && /VALUES \('([0-9a-f-]{36})'/.exec(firstBounty)?.[1];
    if (id && (await client.query('SELECT 1 FROM bounties WHERE id = $1', [id])).rowCount) {
      await client.query('ROLLBACK');
      log('devnet import: already present, nothing to do');
      return;
    }
    const spendBefore = (await client.query('SELECT count(*)::int AS n FROM inference_spend')).rows[0].n;
    for (const s of statements) await client.query(s);
    for (const t of ['repos', 'wallet_links']) {
      await client.query(`SELECT setval(pg_get_serial_sequence('${t}','id'), GREATEST((SELECT max(id) FROM ${t}), 1))`);
    }
    const spendAfter = (await client.query('SELECT count(*)::int AS n FROM inference_spend')).rows[0].n;
    if (spendAfter !== spendBefore) throw new Error('devnet import refused: spend table changed');
    await client.query('COMMIT');
    log(`devnet import: ${statements.length} rows into a mock-bound database; inference_spend ${spendBefore} -> ${spendAfter}`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
