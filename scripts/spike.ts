// P1 spike: the questions only a paid call can answer.
//
//   baseline  one cheap call paid on-chain at exactly the quote cap.
//             What does PAYMENT-RESPONSE contain? Do X-Pod-* headers come back?
//   overpay   pay above the cap. Is the excess credited to the wallet's surplus?
//   drawdown  spend surplus credit with a signed proof (no on-chain transaction).
//   surplus   build credit the documented way: a high max_tokens cap, a short answer.
//   routing   are X-Pod-* routing headers honoured on the x402 path?
//
// Every call goes through the same X402Client, governor and signer the agent
// uses, so the $5 lifetime ceiling and the P1 allocation apply here too.
//
// Usage: pnpm spike <experiment...>   (needs .env; see .env.example)

import { mkdirSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { budgetConfig, fmt, PHASE_ALLOCATION_MICRO } from '../packages/budget/src/governor.ts';
import { migrate, PgReceiptStore, PgSpendLedger } from '../packages/db/src/pg.ts';
import { X402CallFailed, X402Client, type CallRequest, type RoutingRequest } from '../packages/x402/src/client.ts';
import { X402_PATHS } from '../packages/x402/src/protocol.ts';
import { SignerClient } from '../services/signer/src/client.ts';

const env = process.env;
const baseUrl = env.USEPOD_BASE_URL ?? 'http://127.0.0.1:8402';
const real = baseUrl.includes('api.usepod.ai');
if (real && env.SPIKE_CONFIRM !== 'spend-real-money') {
  console.error('Refusing to call the real gateway without SPIKE_CONFIRM=spend-real-money.');
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
await migrate(pool);
const ledger = new PgSpendLedger(pool, budgetConfig({ lifetimeCeilingMicro: env.INFERENCE_LIFETIME_CEILING_MICRO ? Number(env.INFERENCE_LIFETIME_CEILING_MICRO) : undefined }));
const receipts = new PgReceiptStore(pool);
const signer = new SignerClient(env.SIGNER_URL ?? 'http://127.0.0.1:8787', env.SIGNER_TOKEN ?? '');

const mk = (prefundMicro = 0) =>
  new X402Client({ baseUrl, payer: signer, ledger, receipts, prefundMicro, solUsdCeilingPrice: Number(env.SIGNER_SOL_USD_CEILING_PRICE ?? 400) });

const outDir = `data/spike/${new Date().toISOString().replace(/[:.]/g, '-')}`;
mkdirSync(outDir, { recursive: true });

const cheap = (content: string, max_tokens = 24, model = 'gpt-oss-120b'): CallRequest => ({
  purpose: 'spike',
  phase: 'P1',
  path: X402_PATHS.chat,
  body: { model, max_tokens, messages: [{ role: 'user', content }] },
  links: { evalItemId: 'p1-spike' },
});

async function run(name: string, client: X402Client, req: CallRequest) {
  try {
    const { record, response } = await client.call(req);
    const out = { name, ok: true, record, response };
    writeFileSync(`${outDir}/${name}.json`, JSON.stringify(out, null, 2));
    console.log(`\n[${name}] served via ${record.scheme}; paid ${fmt(record.paidMicro ?? 0)} + fee ${fmt(record.feeMicro ?? 0)}; cap ${record.quoteCapMicro}`);
    console.log('  PAYMENT-RESPONSE:', JSON.stringify(record.paymentResponse));
    console.log('  pod headers:', JSON.stringify(record.responseHeaders));
    return out;
  } catch (e) {
    const rec = e instanceof X402CallFailed ? e.record : null;
    const out = { name, ok: false, error: String(e), record: rec, gatewayError: e instanceof X402CallFailed ? e.gatewayError : null };
    writeFileSync(`${outDir}/${name}.json`, JSON.stringify(out, null, 2));
    console.log(`\n[${name}] FAILED: ${String(e)}`);
    return out;
  }
}

const routing = (r: RoutingRequest, content: string): CallRequest => ({ ...cheap(content), routing: r });

const experiments: Record<string, () => Promise<unknown>> = {
  baseline: () => run('baseline', mk(), cheap('Reply with the single word: ok')),
  overpay: async () => {
    const c = mk(20_000); // pay $0.02 against a cap of a few micro-dollars
    await run('overpay-pay', c, cheap('Reply with the single word: ok'));
    return run('overpay-drawdown', forceEstimate(c, 1_000_000), cheap('Reply with the single word: yes'));
  },
  drawdown: () => run('drawdown', forceEstimate(mk(), 1_000_000), cheap('Reply with the single word: again')),
  surplus: async () => {
    // Cap is priced on max_tokens; a one-word answer leaves most of it as credit.
    const c = mk();
    await run('surplus-build', c, cheap('Reply with the single word: ok', 3_000, 'claude-haiku-4-5'));
    return run('surplus-drawdown', forceEstimate(c, 1_000_000), cheap('Reply with the single word: yes'));
  },
  routing: async () => {
    const c = forceEstimate(mk(), 1_000_000); // prefer credit so routing probes cost no network fees
    await run('routing-bogus-provider', c, routing({ providers: ['bogus-provider'] }, 'Reply: a'));
    await run('routing-price-floor', c, routing({ mode: 'marketplace-only', maxPriceInputPer1m: 1, maxPriceOutputPer1m: 1 }, 'Reply: b'));
    await run('routing-marketplace', c, routing({ mode: 'marketplace-only' }, 'Reply: c'));
    return run('routing-centralized', c, routing({ mode: 'centralized-only' }, 'Reply: d'));
  },
};

function forceEstimate(c: X402Client, micro: number) {
  (c as unknown as { surplusEstimateMicro: number }).surplusEstimateMicro = micro;
  return c;
}

const wanted = process.argv.slice(2);
if (!wanted.length || wanted.some((w) => !(w in experiments))) {
  console.error(`usage: pnpm spike <${Object.keys(experiments).join('|')}>...`);
  process.exit(2);
}
console.log(`gateway ${baseUrl}; payer ${await signer.address()}; output ${outDir}`);
for (const w of wanted) await experiments[w]!();

const t = await ledger.totals();
console.log(`\nspend: lifetime ${fmt(t.lifetimeMicro)} of $5.000000; P1 ${fmt(t.byPhase.P1)} of ${fmt(PHASE_ALLOCATION_MICRO.P1)}`);
await pool.end();
