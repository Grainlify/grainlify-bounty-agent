// Real paid UsePod calls doing the agent's production `price` task: ask whether
// a drafted bounty is scoped tightly enough for a stranger to finish at $1.
// Receipts land in the live ledger like every other call.
import { readFileSync } from 'node:fs';
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
  ledger, receipts: new PgReceiptStore(pool), solUsdCeilingPrice: Number(env.SIGNER_SOL_USD_CEILING_PRICE ?? 400),
});

const drafts = readFileSync(process.argv[2]!, 'utf8').split(/^## (?=\d\. )/m).slice(1);
for (const [i, d] of drafts.entries()) {
  const title = d.split('\n')[0]!;
  const { record, response } = await client.call({
    purpose: 'price', phase: 'P1', path: X402_PATHS.chat,
    body: {
      model: 'gpt-oss-120b', max_tokens: 160,
      messages: [{
        role: 'user',
        content: `You are reviewing a $1 open-source bounty before it is posted. Answer in at most 60 words: is the acceptance criteria objective enough that a reviewer cannot argue, and can a stranger with no prior context finish it in under an hour? If not, say exactly what is underspecified.\n\n${d.slice(0, 2200)}`,
      }],
    },
    links: { repo: 'Grainlify/grainlify-bounty-agent', issueNumber: i + 1 },
  });
  const text = (response as { choices?: { message?: { content?: string } }[] })?.choices?.[0]?.message?.content ?? '(no text)';
  console.log(`\n--- ${title}`);
  console.log(`    scheme=${record.scheme} charged=${record.chargedMicro ?? '?'} fee=${fmt(record.feeMicro ?? 0)} provider=${(record.responseHeaders as Record<string,string>)?.['x-pod-provider-id'] ?? '?'}`);
  console.log(`    ${text.trim().replace(/\n+/g, '\n    ')}`);
}
const t = await ledger.totals();
console.log(`\nlifetime ${fmt(t.lifetimeMicro)} of $5.000000`);
await pool.end();
