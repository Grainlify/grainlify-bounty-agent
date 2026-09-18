// Inference spend against the agreed allocation table, from the agent's ledger
// and, if reachable, the signer's independent journal.

import pg from 'pg';
import { budgetConfig, fmt, HARD_LIFETIME_CEILING_MICRO, PHASE_ALLOCATION_MICRO, PHASES } from '../packages/budget/src/governor.ts';
import { PgSpendLedger } from '../packages/db/src/pg.ts';

const env = process.env;
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const ledger = new PgSpendLedger(pool, budgetConfig());
const t = await ledger.totals();

console.log('Phase   Allocation   Spent        Left');
for (const p of PHASES) {
  const a = PHASE_ALLOCATION_MICRO[p];
  console.log(`${p.padEnd(7)} ${fmt(a).padEnd(12)} ${fmt(t.byPhase[p]).padEnd(12)} ${fmt(a - t.byPhase[p])}`);
}
console.log(`Total   ${fmt(HARD_LIFETIME_CEILING_MICRO).padEnd(12)} ${fmt(t.lifetimeMicro).padEnd(12)} ${fmt(HARD_LIFETIME_CEILING_MICRO - t.lifetimeMicro)}`);

const calls = await pool.query(`SELECT status, scheme, count(*)::int AS n, COALESCE(sum(paid_micro),0)::bigint AS paid, COALESCE(sum(fee_micro),0)::bigint AS fees FROM inference_calls GROUP BY 1,2 ORDER BY 1,2`);
console.log('\nCalls by status/scheme:');
for (const r of calls.rows) console.log(`  ${r.status}/${r.scheme ?? '-'}: ${r.n} calls, paid ${fmt(Number(r.paid))}, fees ${fmt(Number(r.fees))}`);

if (env.SIGNER_URL && env.SIGNER_TOKEN) {
  try {
    const r = await fetch(`${env.SIGNER_URL}/v1/spend`, { headers: { authorization: `Bearer ${env.SIGNER_TOKEN}` } });
    const s = (await r.json()) as { committed_micro: number; ceiling_micro: number };
    console.log(`\nSigner journal (independent): committed ${fmt(s.committed_micro)} of ${fmt(s.ceiling_micro)}`);
  } catch {
    console.log('\nSigner not reachable; journal not checked.');
  }
}
await pool.end();
