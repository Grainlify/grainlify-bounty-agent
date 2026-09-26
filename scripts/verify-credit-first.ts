// Two real calls with a plain client: no forced estimate. The first pays
// on-chain and should leave credit; the second should spend that credit with no
// network fee, which is the whole point of the change.
import pg from 'pg';
import { budgetConfig, fmt } from '../packages/budget/src/governor.ts';
import { bindLedgerMode, migrate, PgReceiptStore, PgSpendLedger } from '../packages/db/src/pg.ts';
import { X402Client } from '../packages/x402/src/client.ts';
import { X402_PATHS } from '../packages/x402/src/protocol.ts';
import { SignerClient } from '../services/signer/src/client.ts';

const env = process.env;
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
await migrate(pool);
await bindLedgerMode(pool, 'live');
const ledger = new PgSpendLedger(pool, budgetConfig());
const client = new X402Client({
  baseUrl: env.USEPOD_BASE_URL!, payer: new SignerClient(env.SIGNER_URL!, env.SIGNER_TOKEN!),
  ledger, receipts: new PgReceiptStore(pool), solUsdCeilingPrice: 400,
});
for (const [i, prompt] of ['Reply with the single word: one', 'Reply with the single word: two'].entries()) {
  const { record } = await client.call({
    purpose: 'crosscheck', phase: 'P1', path: X402_PATHS.chat,
    body: { model: 'gpt-oss-120b', max_tokens: 3000, messages: [{ role: 'user', content: prompt }] },
    links: { repo: 'Grainlify/grainlify-bounty-agent', issueNumber: 100 + i },
  });
  console.log(`call ${i + 1}: scheme=${record.scheme} cap=${record.quoteCapMicro} charged=${record.chargedMicro} paid=${fmt(record.paidMicro ?? 0)} fee=${fmt(record.feeMicro ?? 0)}`);
}
const t = await ledger.totals();
console.log(`lifetime ${fmt(t.lifetimeMicro)} of $5.000000`);
await pool.end();
