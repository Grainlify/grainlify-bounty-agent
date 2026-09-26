// Inference spend against the agreed allocation table, from the agent's ledger
// and, if reachable, the signer's independent journal.

import pg from 'pg';
import { budgetConfig, fmt, HARD_LIFETIME_CEILING_MICRO, PHASE_ALLOCATION_MICRO, PHASES } from '../packages/budget/src/governor.ts';
import { PgSpendLedger } from '../packages/db/src/pg.ts';
import { computeMetrics, costPerMergedPr, type CallRow, type ListPrice } from '../packages/budget/src/metrics.ts';
import { readFileSync } from 'node:fs';

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

// --- what a call actually costs, and what it would cost at list price ---
const raw = await pool.query(`
  SELECT scheme, status, model, paid_micro, fee_micro, charged_micro, usage_in, usage_out, links
  FROM inference_calls`);
const rows: CallRow[] = raw.rows.map((r) => ({
  scheme: r.scheme, status: r.status, model: r.model,
  paidMicro: r.paid_micro === null ? null : Number(r.paid_micro),
  feeMicro: r.fee_micro === null ? null : Number(r.fee_micro),
  chargedMicro: r.charged_micro === null ? null : Number(r.charged_micro),
  usageIn: r.usage_in, usageOut: r.usage_out, links: r.links,
}));

const list = new Map<string, ListPrice>();
try {
  const cat = JSON.parse(readFileSync('fixtures/usepod/marketplace-models.subset.json', 'utf8')) as {
    models: { model_id?: string; cheapest_input_per_1m?: number; cheapest_output_per_1m?: number }[];
  };
  for (const m of cat.models) {
    const id = m.model_id;
    if (id && m.cheapest_input_per_1m != null && m.cheapest_output_per_1m != null) {
      list.set(id, { inputPer1m: m.cheapest_input_per_1m, outputPer1m: m.cheapest_output_per_1m });
    }
  }
} catch { /* no catalogue: the list-price line is simply omitted */ }

const m = computeMetrics(rows, list);
// Money that left the wallet is not the same as service consumed. The gap is
// cap we paid but did not use: spendable credit, or -- for the one overpayment
// experiment -- forfeited. Showing it keeps the loss visible instead of buried.
const spentMicro = rows.reduce((a, r) => a + (r.paidMicro ?? 0) + (r.feeMicro ?? 0), 0);
console.log('\nWhat the calls cost:');
console.log(`  served               ${m.servedCalls}  (${m.paidCalls} paid on-chain, ${m.creditCalls} on surplus credit)`);
console.log(`  inference            ${fmt(m.inferenceMicro)}`);
console.log(`  Solana network fees  ${fmt(m.feeMicro)}`);
console.log(`  total                ${fmt(m.totalMicro)}`);
if (m.feeToInferenceRatio !== null) {
  console.log(`  fee : inference      ${m.feeToInferenceRatio.toFixed(0)}x  (fees are ${m.feeSharePct!.toFixed(1)}% of spend)`);
}
console.log(`  money that left      ${fmt(spentMicro)}  (paid + fees)`);
if (spentMicro > m.totalMicro) {
  console.log(`  paid but not used    ${fmt(spentMicro - m.totalMicro)}  (unused cap: surplus credit, or forfeited if it was an overpayment)`);
}
if (m.costPerServedCallMicro !== null) console.log(`  per served call      ${fmt(Math.round(m.costPerServedCallMicro))}`);
if (m.costPerPaidCallMicro !== null) console.log(`  per on-chain call    ${fmt(Math.round(m.costPerPaidCallMicro))}`);
if (m.listPriceMicro !== null) {
  const delta = m.listPriceMicro - m.inferenceMicro;
  console.log(`  same tokens at list  ${fmt(m.listPriceMicro)} across ${m.listPriceModels} call(s) -> x402 ${delta >= 0 ? 'saved' : 'cost'} ${fmt(Math.abs(delta))} on inference`);
} else {
  console.log('  same tokens at list  no priced model in the catalogue for these calls');
}

const merged = await pool.query(`
  SELECT DISTINCT b.repo, b.issue_number
  FROM submissions s JOIN bounties b ON b.id = s.bounty_id
  WHERE s.merged_at IS NOT NULL`).catch(() => ({ rows: [] as { repo: string; issue_number: number }[] }));
const keys = new Set(merged.rows.map((r) => `${r.repo}#${r.issue_number}`));
const pr = costPerMergedPr(rows, keys);
console.log(`\nCost per merged PR:`);
if (pr.perMergedMicro === null) {
  console.log(`  no merged PR yet; ${fmt(pr.unattributedMicro)} of spend is not yet attributable to one`);
} else {
  console.log(`  ${pr.merged} merged, ${fmt(pr.attributedMicro)} attributed -> ${fmt(Math.round(pr.perMergedMicro))} per merged PR`);
  console.log(`  ${fmt(pr.unattributedMicro)} not attributable to a merged PR`);
}

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
