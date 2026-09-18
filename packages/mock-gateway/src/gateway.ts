// A local stand-in for UsePod's x402 gateway, built from recorded live
// behaviour (fixtures/usepod/). All development and tests run against this
// at $0. Anything the live gateway has not yet shown us is marked "assumed"
// in fixtures/usepod/x402-errors.json and gets replaced by what the paid spike
// records.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID, verify as edVerify, createPublicKey } from 'node:crypto';
import bs58 from 'bs58';
import errorsFixture from '../../../fixtures/usepod/x402-errors.json' with { type: 'json' };
import catalogFixture from '../../../fixtures/usepod/marketplace-models.subset.json' with { type: 'json' };
import { balanceProofMessage, bodyHash, SOLANA_MAINNET, USEPOD_PAY_TO_ALLOWLIST, X402_PATHS } from '../../x402/src/protocol.ts';

type ErrKey = keyof typeof errorsFixture.errors;

const PAY_TO = USEPOD_PAY_TO_ALLOWLIST[0]!;
const BASE_PAY_TO = '0x8715CBcE377293F83805F4B60F1490a6DC9DF19C';
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const QUOTE_TTL_MS = 5 * 60_000;

export interface MockOptions {
  /** What happens to on-chain payment above the quote cap. Unknown live; the spike settles it. */
  overpayPolicy?: 'credit' | 'forfeit';
  /** Transfers become visible to the gateway this long after they are posted. */
  confirmationDelayMs?: number;
  /** Produces the assistant text for a request. */
  responder?: (model: string, messages: unknown[]) => string;
  now?: () => number;
}

interface StoredQuote {
  quoteId: string;
  method: string;
  path: string;
  bodyHash: string;
  model: string;
  capMicro: number;
  inputTokens: number;
  expiresAt: number;
}

interface Transfer {
  signature: string;
  from: string;
  to: string;
  asset: string;
  amountMicro: number;
  visibleAt: number;
}

export interface MockState {
  quotes: Map<string, StoredQuote>;
  transfers: Map<string, Transfer>;
  usedSignatures: Set<string>;
  settledQuotes: Set<string>;
  balances: Map<string, number>;
  /** Every settled call, for assertions. */
  settlements: { quoteId: string; scheme: 'onchain' | 'balance'; wallet: string; chargedMicro: number; creditedMicro: number; headers: Record<string, string> }[];
}

const prices = new Map(
  catalogFixture.models.map((m) => [
    m.model_id,
    { in: (m.centralized_input_per_1m ?? m.cheapest_input_per_1m) as number, out: (m.centralized_output_per_1m ?? m.cheapest_output_per_1m) as number },
  ]),
);

export function priceMicro(model: string, inputTokens: number, outputTokens: number): number | null {
  const p = prices.get(model);
  if (!p) return null;
  return Math.max(1, Math.ceil((inputTokens * p.in + outputTokens * p.out) / 1_000_000));
}

export const estimateTokens = (text: string) => Math.max(1, Math.ceil(text.length / 4));

export function createMockGateway(opts: MockOptions = {}): { server: Server; state: MockState } {
  const now = opts.now ?? Date.now;
  const state: MockState = { quotes: new Map(), transfers: new Map(), usedSignatures: new Set(), settledQuotes: new Set(), balances: new Map(), settlements: [] };
  const respond = opts.responder ?? ((model: string) => `mock completion from ${model}`);

  const server = createServer(async (req, res) => {
    try {
      const raw = await readBody(req);
      const url = new URL(req.url ?? '/', 'http://mock');

      if (url.pathname === '/__mock/chain/transfers' && req.method === 'POST') {
        const t = JSON.parse(raw) as { signature: string; from: string; to: string; asset: string; amount_micro: number };
        if (state.transfers.has(t.signature)) return json(res, 409, { error: 'duplicate signature' });
        state.transfers.set(t.signature, { signature: t.signature, from: t.from, to: t.to, asset: t.asset, amountMicro: t.amount_micro, visibleAt: now() + (opts.confirmationDelayMs ?? 0) });
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/__mock/state' && req.method === 'GET') {
        return json(res, 200, { balances: Object.fromEntries(state.balances), settlements: state.settlements, quotes: state.quotes.size });
      }

      const path = url.pathname;
      if (req.method !== 'POST' || (path !== X402_PATHS.chat && path !== X402_PATHS.messages)) return json(res, 404, { error: { message: 'not found', type: 'not_found' } });

      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return fail(res, 'invalid_json_body');
      }
      const maxTokens = (body.max_tokens ?? body.max_completion_tokens) as number | undefined;
      if (typeof maxTokens !== 'number') return fail(res, 'missing_max_tokens');
      if (body.stream === true) return fail(res, 'stream_not_supported');
      const model = String(body.model ?? '');
      const inputTokens = estimateTokens(JSON.stringify(body.messages ?? []));
      const cap = priceMicro(model, inputTokens, maxTokens);
      if (cap === null) return fail(res, 'no_provider', { model });

      const hash = bodyHash('POST', path, raw);
      const paymentHeader = req.headers['payment-signature'] ?? req.headers['x-payment'];

      if (!paymentHeader) {
        const quoteId = randomUUID();
        const expiresAt = now() + QUOTE_TTL_MS;
        state.quotes.set(quoteId, { quoteId, method: 'POST', path, bodyHash: hash, model, capMicro: cap, inputTokens, expiresAt });
        return send402(res, { quoteId, path, hash, model, cap, expiresAt });
      }

      // --- settle ---
      let env: Record<string, unknown>;
      try {
        env = JSON.parse(Buffer.from(String(paymentHeader), 'base64').toString('utf8')) as Record<string, unknown>;
      } catch {
        return fail(res, 'invalid_payment_json');
      }
      const network = env.network as string | undefined;
      if (network !== undefined && network !== SOLANA_MAINNET && network !== 'eip155:8453') return fail(res, 'unsupported_network');
      const quote = state.quotes.get(String(env.quote_id ?? ''));
      if (!quote || state.settledQuotes.has(quote.quoteId)) return fail(res, 'unknown_quote');
      if (quote.bodyHash !== hash || quote.path !== path) return fail(res, 'quote_mismatch');
      if (quote.expiresAt <= now()) return fail(res, 'quote_expired');

      const wallet = String(env.payer_wallet ?? '');
      let scheme: 'onchain' | 'balance';
      let paidMicro = 0;

      if (env.scheme === 'balance') {
        scheme = 'balance';
        if (!env.payer_wallet) return fail(res, 'balance_missing_payer');
        if (typeof env.proof !== 'string') return fail(res, 'balance_missing_proof');
        const sig = decodeSig(env.proof);
        if (!sig) return fail(res, 'balance_proof_malformed');
        if (!verifyEd25519(wallet, balanceProofMessage(quote.quoteId), sig)) return fail(res, 'balance_proof_invalid');
        const bal = state.balances.get(wallet) ?? 0;
        if (bal < quote.capMicro) return fail(res, 'balance_insufficient', { cap: String(quote.capMicro) });
        state.balances.set(wallet, bal - quote.capMicro);
      } else {
        scheme = 'onchain';
        const txSig = env.signature;
        if (typeof txSig !== 'string' || !txSig) return fail(res, 'missing_tx_signature');
        const t = state.transfers.get(txSig);
        if (!t || t.visibleAt > now()) return fail(res, 'tx_not_found');
        if (state.usedSignatures.has(txSig)) return fail(res, 'signature_replayed');
        if (t.to !== PAY_TO || t.asset !== 'USDC' || t.amountMicro < quote.capMicro) return fail(res, 'underpaid');
        state.usedSignatures.add(txSig);
        paidMicro = t.amountMicro;
      }

      const text = respond(model, (body.messages as unknown[]) ?? []);
      const outputTokens = Math.min(maxTokens, estimateTokens(text));
      const actual = Math.min(quote.capMicro, priceMicro(model, quote.inputTokens, outputTokens) ?? quote.capMicro);
      let credited = quote.capMicro - actual;
      if (scheme === 'onchain' && (opts.overpayPolicy ?? 'credit') === 'credit') credited += paidMicro - quote.capMicro;
      state.balances.set(wallet, (state.balances.get(wallet) ?? 0) + credited);
      state.settledQuotes.add(quote.quoteId);

      // ASSUMED shape: the live PAYMENT-RESPONSE format is undocumented. The paid spike replaces this.
      const receipt = { quote_id: quote.quoteId, scheme, network: SOLANA_MAINNET, charged_microunits: actual, credited_microunits: credited, balance_microunits: state.balances.get(wallet), transaction: scheme === 'onchain' ? env.signature : null, mock: true };
      const headers = { 'payment-response': Buffer.from(JSON.stringify(receipt)).toString('base64') };
      state.settlements.push({ quoteId: quote.quoteId, scheme, wallet, chargedMicro: actual, creditedMicro: credited, headers });

      const usage = { prompt_tokens: quote.inputTokens, completion_tokens: outputTokens, total_tokens: quote.inputTokens + outputTokens };
      const payload =
        path === X402_PATHS.chat
          ? { id: `chatcmpl-mock-${quote.quoteId.slice(0, 8)}`, object: 'chat.completion', created: Math.floor(now() / 1000), model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage }
          : { id: `msg_mock_${quote.quoteId.slice(0, 8)}`, type: 'message', role: 'assistant', model, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens } };
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-expose-headers': '*', ...headers });
      res.end(JSON.stringify(payload));
    } catch (e) {
      json(res, 500, { error: { message: String(e), type: 'mock_internal' } });
    }
  });

  function send402(res: ServerResponse, q: { quoteId: string; path: string; hash: string; model: string; cap: number; expiresAt: number }) {
    const expires_at = new Date(q.expiresAt).toISOString();
    const url = `https://api.usepod.ai${q.path}`;
    const common = { x402_version: 2, quote_id: q.quoteId, scheme: 'exact', expires_at, method: 'POST', path: q.path, body_hash: q.hash, model: q.model };
    const header = {
      x402_version: 2,
      x402Version: 2,
      quote_id: q.quoteId,
      resource: { description: `UsePod inference: ${q.model}`, mimeType: 'application/json', url },
      accepts: [
        { ...common, network: SOLANA_MAINNET, pay_to: PAY_TO, asset: 'USDC', amount_microunits: q.cap, mode: 'cap-with-surplus-credit', balance_hint: `wallets with an x402 surplus balance may retry with scheme "balance": sign "usepod-x402-spend:${q.quoteId}" with the payer wallet and send it as payload.proof` },
        { ...common, network: SOLANA_MAINNET, pay_to: PAY_TO, asset: 'SOL', amount_microunits: q.cap * 9, mode: 'cap-with-surplus-credit' },
        { ...common, network: 'eip155:8453', pay_to: BASE_PAY_TO, asset: BASE_USDC, amount_microunits: q.cap, mode: 'exact', x402Version: 2, amount: String(q.cap), maxAmountRequired: String(q.cap), payTo: BASE_PAY_TO, maxTimeoutSeconds: 300, resource: url, description: `UsePod inference: ${q.model}`, mimeType: 'application/json', extra: { name: 'USD Coin', version: '2' } },
      ],
      extensions: {},
    };
    const v1Body = {
      accepts: [{ asset: BASE_USDC, description: `UsePod inference: ${q.model}`, extra: { name: 'USD Coin', version: '2' }, maxAmountRequired: String(q.cap), maxTimeoutSeconds: 300, mimeType: 'application/json', network: 'base', payTo: BASE_PAY_TO, resource: url, scheme: 'exact' }],
      error: 'Payment required. Retry the same request with an X-PAYMENT or PAYMENT-SIGNATURE header.',
      error_detail: { message: 'Payment required. Retry the same request with PAYMENT-SIGNATURE.', quote_id: q.quoteId, type: 'x402_payment_required' },
      quote_id: q.quoteId,
      x402Version: 1,
    };
    res.writeHead(402, { 'content-type': 'application/json', 'access-control-expose-headers': '*', 'payment-required': Buffer.from(JSON.stringify(header)).toString('base64') });
    res.end(JSON.stringify(v1Body));
  }

  return { server, state };
}

function fail(res: ServerResponse, key: ErrKey, vars: Record<string, string> = {}) {
  const e = errorsFixture.errors[key];
  const message = e.message.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? `{${k}}`);
  json(res, e.status, { error: { message, type: e.type } });
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function decodeSig(proof: string): Buffer | null {
  for (const dec of [(s: string) => Buffer.from(bs58.decode(s)), (s: string) => Buffer.from(s, 'base64')]) {
    try {
      const b = dec(proof);
      if (b.length === 64) return b;
    } catch {
      /* try next encoding */
    }
  }
  return null;
}

function verifyEd25519(walletB58: string, message: string, sig: Buffer): boolean {
  try {
    const pub = Buffer.from(bs58.decode(walletB58));
    if (pub.length !== 32) return false;
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pub]), format: 'der', type: 'spki' });
    return edVerify(null, Buffer.from(message, 'utf8'), key, sig);
  } catch {
    return false;
  }
}
