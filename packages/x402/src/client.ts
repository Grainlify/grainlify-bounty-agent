// Pays for UsePod inference per request over x402 and leaves a receipt for
// every call.
//
// Order of preference for paying:
//   1. surplus credit ("balance" scheme): no on-chain transaction, no network fee;
//   2. an on-chain USDC transfer, reserved against the budget first.
// The client never holds a key: the Payer (the signer service) pays and signs.

import { createHash, randomUUID } from 'node:crypto';
import { lamportsToMicroCeil, type Phase } from '../../budget/src/governor.ts';
import type { SpendLedger } from '../../budget/src/ledger.ts';
import {
  balanceEnvelope,
  decodeQuoteHeader,
  encodeEnvelope,
  isBalanceInsufficient,
  isExpired,
  isTxNotYetVisible,
  onchainEnvelope,
  parseGatewayError,
  selectUsdcRail,
  type GatewayError,
  type SolanaUsdcRail,
  type X402Path,
} from './protocol.ts';
import type { CallLinks, CallPurpose, InferenceCallRecord, ReceiptStore } from './receipts.ts';

export interface Payer {
  address(): Promise<string>;
  payQuote(rail: SolanaUsdcRail & { amount_microunits: number }): Promise<PayOutcome>;
  balanceProof(quoteId: string): Promise<{ payer_wallet: string; proof: string }>;
}

export type PayOutcome =
  | { kind: 'paid'; payer_wallet: string; signature: string; amount_micro: number; fee_micro: number }
  /** The signer refused before sending anything. Certain: no money moved. */
  | { kind: 'refused'; error: string }
  /** Something went wrong after the transaction may have been sent. Money may have moved. */
  | { kind: 'unknown'; error: string };

export interface RoutingRequest {
  mode?: 'auto' | 'marketplace-only' | 'centralized-only';
  maxPriceInputPer1m?: number;
  maxPriceOutputPer1m?: number;
  providers?: string[];
}

export interface CallRequest {
  purpose: CallPurpose;
  phase: Phase;
  path: X402Path;
  body: Record<string, unknown>;
  routing?: RoutingRequest;
  links?: CallLinks;
}

export interface CallResult {
  record: InferenceCallRecord;
  /** Parsed JSON response from the model. */
  response: unknown;
}

export interface X402ClientOptions {
  baseUrl: string;
  payer: Payer;
  ledger: SpendLedger;
  receipts: ReceiptStore;
  /** Worst-case network fee we reserve per on-chain payment, in lamports. */
  feeReserveLamports?: number;
  solUsdCeilingPrice?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export class BudgetRefused extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'BudgetRefused';
  }
}

export class X402CallFailed extends Error {
  constructor(message: string, readonly record: InferenceCallRecord, readonly gatewayError?: GatewayError) {
    super(message);
    this.name = 'X402CallFailed';
  }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function routingHeaders(r: RoutingRequest | undefined): Record<string, string> {
  const h: Record<string, string> = {};
  if (!r) return h;
  if (r.mode) h['X-Pod-Routing-Mode'] = r.mode;
  if (r.maxPriceInputPer1m !== undefined) h['X-Pod-Max-Price-Input'] = String(r.maxPriceInputPer1m);
  if (r.maxPriceOutputPer1m !== undefined) h['X-Pod-Max-Price-Output'] = String(r.maxPriceOutputPer1m);
  if (r.providers?.length) h['X-Pod-Providers'] = r.providers.join(',');
  return h;
}

export class X402Client {
  /**
   * What we believe the wallet's x402 surplus credit is, in micro-units.
   *
   * It starts at Infinity, meaning "unknown, so try". A balance spend that
   * fails moves no money and is refused before anything is charged, so the
   * worst case of guessing high is one wasted round trip. The worst case of
   * guessing low is a real Solana fee, which on a small quote is ~99% of what
   * the call costs. So the unknown case rounds towards trying.
   */
  private surplusEstimateMicro = Number.POSITIVE_INFINITY;
  private readonly f: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;

  constructor(private readonly o: X402ClientOptions) {
    this.f = o.fetchImpl ?? fetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = o.now ?? (() => new Date());
  }

  get surplusEstimate() {
    return this.surplusEstimateMicro;
  }

  async call(req: CallRequest): Promise<CallResult> {
    const started = Date.now();
    // Serialize once. The quote is bound to these exact bytes.
    const raw = JSON.stringify(req.body);
    const url = `${this.o.baseUrl}${req.path}`;
    const headers = { 'content-type': 'application/json', 'user-agent': 'grainlify-bounty-agent/0.1', ...routingHeaders(req.routing) };

    const record = await this.o.receipts.insert({
      id: randomUUID(),
      purpose: req.purpose,
      phase: req.phase,
      model: String(req.body.model ?? ''),
      path: req.path,
      links: req.links ?? {},
      routingRequested: { ...req.routing },
      maxTokens: Number(req.body.max_tokens ?? req.body.max_completion_tokens ?? 0),
      requestSha256: sha256(raw),
      status: 'quoting',
      createdAt: this.now(),
    });
    const update = (patch: Partial<InferenceCallRecord>) => this.o.receipts.update(record.id, patch);

    // 1. Quote.
    const q = await this.f(url, { method: 'POST', headers, body: raw });
    if (q.status !== 402) {
      const err = parseGatewayError(q.status, await q.text());
      const rec = await update({ status: 'failed', error: `expected 402, got ${q.status}: ${err.message}`, latencyMs: Date.now() - started });
      throw new X402CallFailed(rec.error!, rec, err);
    }
    const quote = decodeQuoteHeader(q.headers.get('payment-required'));
    const rail = selectUsdcRail(quote, { method: 'POST', path: req.path, body: raw });
    await update({ quoteId: quote.quote_id, quoteCapMicro: rail.amount_microunits, quoteExpiresAt: rail.expires_at ?? null, status: 'quoted' });
    if (isExpired(rail, this.now())) {
      const rec = await update({ status: 'failed', error: 'quote already expired' });
      throw new X402CallFailed('quote already expired', rec);
    }

    // 2a. Surplus credit, if we believe there is enough.
    if (this.surplusEstimateMicro >= rail.amount_microunits) {
      const { payer_wallet, proof } = await this.o.payer.balanceProof(rail.quote_id);
      const r = await this.f(url, { method: 'POST', headers: { ...headers, 'PAYMENT-SIGNATURE': encodeEnvelope(balanceEnvelope(rail, payer_wallet, proof)) }, body: raw });
      if (r.ok) return this.finish(record.id, r, { scheme: 'balance', payerWallet: payer_wallet, paidMicro: 0, feeMicro: 0, txSignature: null, cap: rail.amount_microunits }, started);
      const err = parseGatewayError(r.status, await r.text());
      if (!isBalanceInsufficient(err)) {
        const rec = await update({ status: 'failed', scheme: 'balance', error: err.message, latencyMs: Date.now() - started });
        throw new X402CallFailed(`balance spend failed: ${err.message}`, rec, err);
      }
      // Our estimate was high. Nothing was spent; fall through to paying
      // on-chain. The refusal is itself information: the balance is below this
      // cap, so record that rather than throwing the knowledge away.
      this.surplusEstimateMicro = Math.max(0, rail.amount_microunits - 1);
    }

    // 2b. On-chain. Reserve budget first; no reservation, no payment.
    //
    // The amount is the quoted cap, always. Paying above it was tried once, on
    // 2026-09-25, on the theory that the excess became surplus credit: it does
    // not. The gateway charges the cap, keeps the difference and credits
    // nothing, so $0.039990 bought ten micro-units of inference. Surplus credit
    // comes only from the unused part of a cap we were actually quoted.
    const amount = rail.amount_microunits;
    const feeReserveMicro = lamportsToMicroCeil(this.o.feeReserveLamports ?? 10_000, this.o.solUsdCeilingPrice ?? 400);
    const { decision, entryId } = await this.o.ledger.reserve({ phase: req.phase, kind: 'x402_payment', amountMicro: amount + feeReserveMicro, callId: record.id });
    if (!decision.ok || !entryId) {
      const reason = decision.ok ? 'no reservation id' : decision.reason;
      await update({ status: 'refused_budget', error: reason, latencyMs: Date.now() - started });
      throw new BudgetRefused(decision.ok ? 'unknown' : decision.code, reason);
    }

    const pay = await this.o.payer.payQuote({ ...rail, amount_microunits: amount });
    if (pay.kind === 'refused') {
      await this.o.ledger.release(entryId);
      const rec = await update({ status: 'refused_signer', error: pay.error, latencyMs: Date.now() - started });
      throw new X402CallFailed(`signer refused: ${pay.error}`, rec);
    }
    if (pay.kind === 'unknown') {
      // Leave the reservation counted: the money may be gone.
      const rec = await update({ status: 'payment_unknown', error: pay.error, latencyMs: Date.now() - started });
      throw new X402CallFailed(`payment outcome unknown: ${pay.error}`, rec);
    }
    // The signer is the thing that actually moves money, so check what it did
    // rather than trusting what it was asked to do. Anything above the cap is
    // money we cannot get back, and it must be visible in the ledger.
    if (pay.amount_micro > rail.amount_microunits) {
      await this.o.ledger.settle(entryId, { amountMicro: pay.amount_micro, feeMicro: pay.fee_micro, txSignature: pay.signature });
      const rec = await update({ status: 'paid', scheme: 'onchain', payerWallet: pay.payer_wallet, payTxSignature: pay.signature, paidMicro: pay.amount_micro, feeMicro: pay.fee_micro, error: 'overpaid' });
      throw new X402CallFailed(`signer paid ${pay.amount_micro} above the quoted cap ${rail.amount_microunits}; the excess is not recoverable`, rec);
    }
    await this.o.ledger.settle(entryId, { amountMicro: pay.amount_micro, feeMicro: pay.fee_micro, txSignature: pay.signature });
    await update({ status: 'paid', scheme: 'onchain', payerWallet: pay.payer_wallet, payTxSignature: pay.signature, paidMicro: pay.amount_micro, feeMicro: pay.fee_micro });

    // 3. Settle with the gateway. The transaction may take a moment to become visible.
    const env = encodeEnvelope(onchainEnvelope(rail, pay.payer_wallet, pay.signature));
    for (let attempt = 0; ; attempt++) {
      const r = await this.f(url, { method: 'POST', headers: { ...headers, 'PAYMENT-SIGNATURE': env }, body: raw });
      if (r.ok) return this.finish(record.id, r, { scheme: 'onchain', payerWallet: pay.payer_wallet, paidMicro: pay.amount_micro, feeMicro: pay.fee_micro, txSignature: pay.signature, cap: rail.amount_microunits }, started);
      const err = parseGatewayError(r.status, await r.text());
      if (isTxNotYetVisible(err) && attempt < 8 && !isExpired(rail, this.now())) {
        await this.sleep(Math.min(1_000 * 2 ** attempt, 15_000));
        continue;
      }
      // Paid but not served: the most important failure to keep visible.
      const rec = await update({ status: 'paid_not_served', error: err.message, latencyMs: Date.now() - started });
      throw new X402CallFailed(`paid ${pay.signature} but the gateway did not serve: ${err.message}`, rec, err);
    }
  }

  private async finish(
    id: string,
    r: Response,
    p: { scheme: 'onchain' | 'balance'; payerWallet: string; paidMicro: number; feeMicro: number; txSignature: string | null; cap: number },
    started: number,
  ): Promise<CallResult> {
    const text = await r.text();
    const prRaw = r.headers.get('payment-response');
    const pr = decodePaymentResponse(prRaw);
    const podHeaders: Record<string, string> = {};
    r.headers.forEach((v, k) => {
      if (k.startsWith('x-pod-') || k.startsWith('x-balance')) podHeaders[k] = v;
    });

    // Track surplus credit. Prefer the gateway's own balance figure if the receipt carries one.
    //
    // The live gateway does not carry one: a settled PAYMENT-RESPONSE reports
    // max_microunits and charged_microunits and no balance. So we keep our own
    // running estimate from those two numbers, because the alternative measured
    // on 2026-09-25 was an agent that paid a $0.002 network fee on every call
    // while ~16,000 micro-units of its own credit sat unspent.
    //
    // The estimate only has to be good enough to decide whether to *try* a
    // balance spend. Guessing high costs one rejected attempt, which moves no
    // money and is refused before anything is charged; guessing low costs a real
    // network fee. So we round towards trying.
    const reportedBalance = numberField(pr, ['balance_microunits', 'balance', 'remaining_balance_microunits']);
    const chargedMicro = numberField(pr, ['charged_microunits', 'charged']);
    if (reportedBalance !== null) {
      this.surplusEstimateMicro = reportedBalance;
    } else if (p.scheme === 'balance') {
      this.surplusEstimateMicro = Math.max(0, this.surplusEstimateMicro - (chargedMicro ?? p.cap));
    } else if (chargedMicro !== null && chargedMicro < p.cap) {
      // Paid the cap, used less: the remainder is credit we can spend next time.
      this.surplusEstimateMicro += p.cap - chargedMicro;
    }

    let response: unknown = null;
    try {
      response = JSON.parse(text);
    } catch {
      response = text;
    }
    const usage = extractUsage(response);
    const rec = await this.o.receipts.update(id, {
      status: 'served',
      scheme: p.scheme,
      payerWallet: p.payerWallet,
      payTxSignature: p.txSignature,
      paidMicro: p.paidMicro,
      feeMicro: p.feeMicro,
      paymentResponseRaw: prRaw,
      paymentResponse: pr,
      chargedMicro: numberField(pr, ['charged_microunits', 'charged', 'amount_microunits', 'cost_microunits']),
      responseHeaders: podHeaders,
      responseSha256: sha256(text),
      usageIn: usage.in,
      usageOut: usage.out,
      latencyMs: Date.now() - started,
    });
    return { record: rec, response };
  }
}

export function decodePaymentResponse(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  for (const decode of [(s: string) => Buffer.from(s, 'base64').toString('utf8'), (s: string) => s]) {
    try {
      const v = JSON.parse(decode(raw));
      if (v && typeof v === 'object') return v as Record<string, unknown>;
    } catch {
      /* try the next form */
    }
  }
  return { unparsed: raw };
}

function numberField(obj: Record<string, unknown> | null, keys: string[]): number | null {
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v !== '' && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

function extractUsage(resp: unknown): { in: number | null; out: number | null } {
  const u = (resp as { usage?: Record<string, number> } | null)?.usage;
  if (!u) return { in: null, out: null };
  return { in: u.prompt_tokens ?? u.input_tokens ?? null, out: u.completion_tokens ?? u.output_tokens ?? null };
}
