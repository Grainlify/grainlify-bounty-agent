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
  | { kind: 'paid'; payer_wallet: string; signature: string; amount_micro: number; fee_micro: number; fee_lamports: number }
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
  /**
   * Pay at least this much on-chain when a payment is needed, so later calls
   * run on surplus credit without a network fee each. Only useful if the live
   * gateway credits overpayment; 0 (off) until the spike confirms that.
   */
  prefundMicro?: number;
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
  private surplusEstimateMicro = 0;
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
      if (r.ok) return this.finish(record.id, r, { scheme: 'balance', payerWallet: payer_wallet, paidMicro: 0, feeMicro: 0, feeLamports: 0, txSignature: null, cap: rail.amount_microunits }, started);
      const err = parseGatewayError(r.status, await r.text());
      if (!isBalanceInsufficient(err)) {
        const rec = await update({ status: 'failed', scheme: 'balance', error: err.message, latencyMs: Date.now() - started });
        throw new X402CallFailed(`balance spend failed: ${err.message}`, rec, err);
      }
      // Our estimate was high. Nothing was spent; fall through to paying on-chain.
      this.surplusEstimateMicro = 0;
    }

    // 2b. On-chain. Reserve budget first; no reservation, no payment.
    const amount = Math.max(rail.amount_microunits, this.o.prefundMicro ?? 0);
    const reserved = await this.o.ledger.reserve(req.phase, amount, (this.o.feeReserveLamports ?? 0) * (this.o.solUsdCeilingPrice ?? 400) * 1e6);
    const res = await this.o.payer.payQuote(rail);
    if (res.kind === 'refused') {
      await this.o.ledger.release(reserved.id);
      const rec = await update({ status: 'failed', error: `signer refused: ${res.error}`, latencyMs: Date.now() - started });
      throw new X402CallFailed(rec.error!, rec);
    }
    if (res.kind === 'unknown') {
      await this.o.ledger.confirm(reserved.id, { amountMicro: amount, feeMicro: 0, feeLamports: 0 }); // Unknown result: charge full reservation.
      const rec = await update({ status: 'failed', error: `payment unknown: ${res.error}`, latencyMs: Date.now() - started });
      throw new X402CallFailed(rec.error!, rec);
    }

    // 3. Finish call.
    const r = await this.f(url, { method: 'POST', headers: { ...headers, 'PAYMENT-SIGNATURE': encodeEnvelope(onchainEnvelope(rail, res.payer_wallet, res.signature)) }, body: raw });
    await this.o.ledger.confirm(reserved.id, { amountMicro: res.amount_micro, feeMicro: res.fee_micro, feeLamports: res.fee_lamports });
    return this.finish(record.id, r, { scheme: 'onchain', payerWallet: res.payer_wallet, paidMicro: res.amount_micro, feeMicro: res.fee_micro, feeLamports: res.fee_lamports, txSignature: res.signature, cap: amount }, started);
  }

  private async finish(id: string, r: Response, details: any, started: number): Promise<CallResult> {
    const record = await this.o.receipts.update(id, { ...details, status: 'complete', latencyMs: Date.now() - started });
    if (!r.ok) throw new X402CallFailed(`call failed: ${await r.text()}`, record);
    return { record, response: await r.json() };
  }
}