// One real call, credit first. A balance attempt that fails costs nothing, so
// trying it before paying on-chain is free downside and saves the network fee.
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
// The gateway does not advertise the balance, so tell the client to try credit.
(client as unknown as { surplusEstimateMicro: number }).surplusEstimateMicro = 1_000_000;

const { record, response } = await client.call({
  purpose: 'price', phase: 'P1', path: X402_PATHS.chat,
  body: { model: 'gpt-oss-120b', max_tokens: 120, messages: [{ role: 'user', content: process.argv[2] ?? 'Reply with the single word: ok' }] },
  links: { repo: 'Grainlify/grainlify-bounty-agent', issueNumber: 99 },
});
console.log(`scheme=${record.scheme} paid=${fmt(record.paidMicro ?? 0)} fee=${fmt(record.feeMicro ?? 0)} charged=${record.chargedMicro}`);
console.log('response keys:', JSON.stringify(Object.keys(response as object)));
const c = (response as { choices?: Record<string, unknown>[] })?.choices?.[0];
console.log('choice keys :', JSON.stringify(c ? Object.keys(c) : null));
console.log('message     :', JSON.stringify(c?.message).slice(0, 700));
const t = await ledger.totals();
console.log(`lifetime ${fmt(t.lifetimeMicro)} of $5.000000`);
await pool.end();
