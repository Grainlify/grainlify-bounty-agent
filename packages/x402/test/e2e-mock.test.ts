// The whole payment path at $0: X402Client -> signer (real HTTP server, real
// ed25519 key, journal on disk) -> mock gateway (recorded behaviour).

import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { budgetConfig } from '../../budget/src/governor.ts';
import { InMemorySpendLedger } from '../../budget/src/ledger.ts';
import { createMockGateway, type MockOptions } from '../../mock-gateway/src/gateway.ts';
import { SignerClient } from '../../../services/signer/src/client.ts';
import { Journal } from '../../../services/signer/src/journal.ts';
import { MockRail } from '../../../services/signer/src/rails.ts';
import { createSignerServer } from '../../../services/signer/src/server.ts';
import { Signer, signerConfig } from '../../../services/signer/src/signer.ts';
import { BudgetRefused, type Payer, X402CallFailed, X402Client } from '../src/client.ts';
import { X402_PATHS } from '../src/protocol.ts';
import { InMemoryReceiptStore } from '../src/receipts.ts';

const TOKEN = 'test-token-0123456789abcdefghij';
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function listen(s: Server) {
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

async function harness(o: { mock?: MockOptions; signerEnv?: Record<string, string>; agentCeiling?: number; payer?: Payer } = {}) {
  const gw = createMockGateway(o.mock);
  const gatewayUrl = await listen(gw.server);
  const journal = new Journal(join(mkdtempSync(join(tmpdir(), 'e2e-')), 'j.sqlite'), 'mock');
  const signer = new Signer(signerConfig({ SIGNER_SOL_USD_CEILING_PRICE: '400', ...o.signerEnv }), journal, new MockRail(gatewayUrl));
  const signerUrl = await listen(createSignerServer(signer, TOKEN));
  const ledger = new InMemorySpendLedger(budgetConfig({ lifetimeCeilingMicro: o.agentCeiling }));
  const receipts = new InMemoryReceiptStore();
  const client = new X402Client({
    baseUrl: gatewayUrl,
    payer: o.payer ?? new SignerClient(signerUrl, TOKEN),
    ledger,
    receipts,
    sleep: async () => {},
  });
  return { gw, journal, ledger, receipts, client, signer };
}

const chat = (content: string, max_tokens = 32) => ({
  purpose: 'spike' as const,
  phase: 'P1' as const,
  path: X402_PATHS.chat,
  body: { model: 'gpt-oss-120b', max_tokens, messages: [{ role: 'user', content }] },
  links: { repo: 'Grainlify/sandbox', issueNumber: 1 },
});

describe('x402 end to end against the mock gateway', () => {
  it('quotes, pays on-chain through the signer, settles, and leaves a full receipt', async () => {
    const h = await harness();
    const { record, response } = await h.client.call(chat('classify this issue'));

    expect(record).toMatchObject({ status: 'served', scheme: 'onchain', purpose: 'spike', links: { repo: 'Grainlify/sandbox', issueNumber: 1 } });
    expect(record.quoteId).toMatch(/^[0-9a-f-]{36}$/);
    expect(record.payTxSignature).toBeTruthy();
    expect(record.paidMicro).toBe(record.quoteCapMicro);
    expect(record.paymentResponse).toMatchObject({ quote_id: record.quoteId, scheme: 'onchain' });
    expect(record.usageOut).toBeGreaterThan(0);
    expect((response as { choices: { message: { content: string } }[] }).choices[0]!.message.content).toContain('gpt-oss-120b');

    // Agent ledger and signer journal agree on what left the wallet.
    const totals = await h.ledger.totals();
    expect(totals.lifetimeMicro).toBe(h.journal.committedMicro());
    expect(h.gw.state.settlements).toHaveLength(1);
  });

  it('draws down surplus credit with a signed proof: no second on-chain payment, no second fee', async () => {
    const h = await harness();
    // Credit comes from the unused part of a cap: quote a large max_tokens and
    // answer briefly. This is the only way credit accrues -- overpaying does
    // not work, measured against the live gateway on 2026-09-25. The cap has to
    // stay under the signer's per-call maximum, which is the other guard.
    const first = await h.client.call(chat('first', 100_000));
    expect(first.record.scheme).toBe('onchain');
    expect(first.record.paidMicro).toBe(first.record.quoteCapMicro);
    const spentAfterFirst = (await h.ledger.totals()).lifetimeMicro;

    const second = await h.client.call(chat('second'));
    expect(second.record).toMatchObject({ status: 'served', scheme: 'balance', paidMicro: 0, feeMicro: 0, payTxSignature: null });
    expect((await h.ledger.totals()).lifetimeMicro).toBe(spentAfterFirst);
    expect(h.journal.all()).toHaveLength(1);
  });

  it('falls back to paying on-chain when the gateway says the credit is short', async () => {
    const h = await harness();
    await h.client.call(chat('first'));
    // The mock's receipt reports the balance; force a stale high estimate to exercise the fallback.
    (h.client as unknown as { surplusEstimateMicro: number }).surplusEstimateMicro = 1_000_000;
    const second = await h.client.call(chat('second'));
    expect(second.record.scheme).toBe('onchain');
    expect(h.journal.all()).toHaveLength(2);
  });

  it('refuses and records it if the signer ever pays above the quoted cap', async () => {
    // Nothing in the client can overpay any more, so the danger left is a
    // signer that pays the wrong amount. The excess is unrecoverable, so it
    // must fail loudly and still be counted -- the money did leave.
    const real = new SignerClient('http://127.0.0.1:1', TOKEN); // replaced below
    let capSeen = 0;
    const overpayer: Payer = {
      address: async () => 'HKMMpctYvofRCSF2uGnqfEGWcmMhD8A86xFqgmWTvcq9',
      balanceProof: (q) => real.balanceProof(q),
      payQuote: async (rail) => {
        capSeen = rail.amount_microunits;
        return { kind: 'paid', payer_wallet: 'HKMMpctYvofRCSF2uGnqfEGWcmMhD8A86xFqgmWTvcq9', signature: 'sig-overpaid', amount_micro: rail.amount_microunits + 20_000, fee_micro: 2_000 };
      },
    };
    const h = await harness({ payer: overpayer });
    // This test is about the on-chain path, so take credit out of the picture.
    (h.client as unknown as { surplusEstimateMicro: number }).surplusEstimateMicro = 0;
    await expect(h.client.call(chat('overpay'))).rejects.toThrow(/above the quoted cap/);
    // The client asked for exactly the cap; the signer is what went wrong.
    expect(capSeen).toBeGreaterThan(0);
    // Counted, not silently dropped: the money is gone either way.
    expect((await h.ledger.totals()).lifetimeMicro).toBeGreaterThanOrEqual(capSeen + 20_000);
  });

  it('hard-stops at the agent ceiling without asking the signer to pay', async () => {
    const h = await harness({ agentCeiling: 5_000 });
    await h.client.call(chat('one')); // cap + 4000 fee reserve
    await expect(h.client.call(chat('two'))).rejects.toBeInstanceOf(BudgetRefused);
    expect(h.journal.all()).toHaveLength(1);
    const refused = (await h.receipts.list()).find((r) => r.status === 'refused_budget');
    expect(refused?.error).toMatch(/lifetime/);
  });

  it('is stopped by the signer even when the agent ledger would allow it', async () => {
    const h = await harness({ signerEnv: { SIGNER_LIFETIME_CEILING_MICRO: '4100' } });
    await h.client.call(chat('one'));
    const err = await h.client.call(chat('two')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(X402CallFailed);
    expect((err as X402CallFailed).record.status).toBe('refused_signer');
    // The agent released its reservation because the signer proved nothing was sent.
    expect((await h.ledger.totals()).lifetimeMicro).toBe(h.journal.committedMicro());
  });

  it('retries settlement while the transaction is not yet visible', async () => {
    // Each gateway request advances the mock clock 1ms; the transfer becomes visible 3ms after posting.
    const base = Date.now();
    let t = 0;
    const h = await harness({ mock: { confirmationDelayMs: 3, now: () => base + (t += 1) } });
    const { record } = await h.client.call(chat('slow chain'));
    expect(record.status).toBe('served');
  });

  it('never pays when the quote is for a different request (body tampering)', async () => {
    const h = await harness();
    const realFetch = fetch;
    // A gateway that quotes one body and would settle another.
    (h.client as unknown as { f: typeof fetch }).f = (async (url: string, init: RequestInit) => {
      const r = await realFetch(url, { ...init, body: String(init.body).replace('tamper-me', 'tampered') });
      return r;
    }) as typeof fetch;
    await expect(h.client.call(chat('tamper-me'))).rejects.toThrow(/body_hash/);
    expect(h.journal.all()).toHaveLength(0);
  });

  it('surfaces the gateway errors verbatim', async () => {
    const h = await harness();
    const err = await h.client.call({ ...chat('x'), body: { model: 'nope', max_tokens: 5, messages: [] } }).catch((e: unknown) => e);
    expect((err as X402CallFailed).gatewayError).toMatchObject({ status: 503, type: 'no_provider', message: 'no healthy provider for model: nope' });
  });
});

describe('credit-first spending', () => {
  it('spends the credit a previous call left, without being told the balance', async () => {
    // The live gateway reports charged_microunits but no balance, so the client
    // has to derive its own estimate or it pays a network fee on every call
    // while its credit sits unused.
    // reportBalance:false reproduces the live gateway, which never tells the
    // client its balance.
    const h = await harness({ mock: { reportBalance: false } });
    const first = await h.client.call(chat('build credit', 100_000));
    expect(first.record.scheme).toBe('onchain');
    expect(first.record.chargedMicro!).toBeLessThan(first.record.quoteCapMicro!);

    const second = await h.client.call(chat('spend credit'));
    expect(second.record).toMatchObject({ scheme: 'balance', paidMicro: 0, feeMicro: 0 });
    // One on-chain payment total: the second call cost no network fee.
    expect(h.journal.all()).toHaveLength(1);
  });

  it('still pays on-chain when no credit has accrued', async () => {
    const h = await harness({ mock: { reportBalance: false } });
    // A tiny cap leaves nothing over, so there is no credit to spend.
    const first = await h.client.call(chat('a', 1));
    const second = await h.client.call(chat('b', 1));
    expect(first.record.scheme).toBe('onchain');
    expect(second.record.scheme).toBe('onchain');
    expect(h.journal.all()).toHaveLength(2);
  });
});
