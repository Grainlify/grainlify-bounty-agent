// The UsePod x402 wire protocol: quote decoding, request binding and the
// PAYMENT-SIGNATURE envelopes. Pure functions only; no network, no keys.
//
// Sources: docs.usepod.ai/api/x402-payments plus live probes recorded in
// fixtures/usepod/. Where the docs and the live gateway disagree, the live
// gateway wins and the fixture says so.

import { createHash } from 'node:crypto';

export const SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
export const USDC_MINT_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDC_DECIMALS = 6;

/** The only Solana address the gateway has ever quoted. Paying anywhere else is refused. */
export const USEPOD_PAY_TO_ALLOWLIST: readonly string[] = ['GXfqVnZENHzvim8rNN8TPwqxWXQe8EBbxhcEMYE8Z7BS'];

export const X402_PATHS = {
  chat: '/proxy/x402/v1/chat/completions',
  messages: '/proxy/x402/v1/messages',
} as const;

export type X402Path = (typeof X402_PATHS)[keyof typeof X402_PATHS];

export interface QuoteAccept {
  x402_version?: number;
  quote_id: string;
  scheme: string;
  network: string;
  pay_to: string;
  asset: string;
  /** USDC microunits on the USDC rail, lamports on the SOL rail. */
  amount_microunits: number;
  mode?: string;
  expires_at?: string;
  method?: string;
  path?: string;
  body_hash?: string;
  model?: string;
  balance_hint?: string;
}

export interface Quote {
  x402_version: number;
  quote_id: string;
  accepts: QuoteAccept[];
  resource?: { url: string; description?: string; mimeType?: string };
}

export interface SolanaUsdcRail extends QuoteAccept {
  asset: 'USDC';
}

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

/** sha256("METHOD\nPATH\nBODY"), hex. The gateway binds each quote to exactly this. */
export function bodyHash(method: string, path: string, body: string): string {
  return createHash('sha256').update(`${method}\n${path}\n${body}`).digest('hex');
}

export function decodeQuoteHeader(headerValue: string | null | undefined): Quote {
  if (!headerValue) throw new ProtocolError('402 response has no PAYMENT-REQUIRED header');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(headerValue, 'base64').toString('utf8'));
  } catch {
    throw new ProtocolError('PAYMENT-REQUIRED is not base64 JSON');
  }
  const q = parsed as Partial<Quote>;
  if (typeof q.quote_id !== 'string' || !Array.isArray(q.accepts)) {
    throw new ProtocolError('PAYMENT-REQUIRED is missing quote_id or accepts');
  }
  return q as Quote;
}

/**
 * Picks the Solana USDC rail and checks it against what we actually sent.
 * These checks are why a hostile or buggy gateway can't make us pay for a
 * different request, to a different address, or on a different network.
 */
export function selectUsdcRail(quote: Quote, sent: { method: string; path: string; body: string }): SolanaUsdcRail {
  const rail = quote.accepts.find((a) => a.asset === 'USDC' && a.network === SOLANA_MAINNET);
  if (!rail) throw new ProtocolError('quote offers no Solana USDC rail');
  if (rail.quote_id !== quote.quote_id) throw new ProtocolError('rail quote_id differs from quote');
  if (!USEPOD_PAY_TO_ALLOWLIST.includes(rail.pay_to)) {
    throw new ProtocolError(`quote pay_to ${rail.pay_to} is not on the allowlist`);
  }
  if (!Number.isSafeInteger(rail.amount_microunits) || rail.amount_microunits <= 0) {
    throw new ProtocolError('quote amount is not a positive integer');
  }
  const expected = bodyHash(sent.method, sent.path, sent.body);
  if (rail.body_hash !== undefined && rail.body_hash !== expected) {
    throw new ProtocolError('quote body_hash does not match the request we sent');
  }
  if (rail.path !== undefined && rail.path !== sent.path) throw new ProtocolError('quote path differs from request path');
  return rail as SolanaUsdcRail;
}

export function isExpired(rail: QuoteAccept, now: Date, marginMs = 5_000): boolean {
  if (!rail.expires_at) return false;
  return Date.parse(rail.expires_at) - marginMs <= now.getTime();
}

/** The exact message the payer wallet signs to spend surplus credit instead of paying on-chain. */
export function balanceProofMessage(quoteId: string): string {
  return `usepod-x402-spend:${quoteId}`;
}

export interface OnchainEnvelope {
  quote_id: string;
  network: string;
  asset: 'USDC';
  payer_wallet: string;
  signature: string;
}

export interface BalanceEnvelope {
  quote_id: string;
  network: string;
  asset: 'USDC';
  payer_wallet: string;
  scheme: 'balance';
  /**
   * Top-level, NOT payload.proof. The gateway's own error text says
   * "payload.proof", but a nested payload is ignored (probed live, see
   * fixtures/usepod/x402-errors.json).
   */
  proof: string;
}

export type PaymentEnvelope = OnchainEnvelope | BalanceEnvelope;

export function encodeEnvelope(env: PaymentEnvelope): string {
  return Buffer.from(JSON.stringify(env), 'utf8').toString('base64');
}

export function decodeEnvelope(headerValue: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(headerValue, 'base64').toString('utf8')) as Record<string, unknown>;
}

export function onchainEnvelope(rail: SolanaUsdcRail, payerWallet: string, txSignature: string): OnchainEnvelope {
  return { quote_id: rail.quote_id, network: rail.network, asset: 'USDC', payer_wallet: payerWallet, signature: txSignature };
}

export function balanceEnvelope(rail: SolanaUsdcRail, payerWallet: string, proof: string): BalanceEnvelope {
  return { quote_id: rail.quote_id, network: rail.network, asset: 'USDC', payer_wallet: payerWallet, scheme: 'balance', proof };
}

/** Gateway error bodies are {"error":{"message","type"}}. */
export interface GatewayError {
  status: number;
  type: string;
  message: string;
}

export function parseGatewayError(status: number, text: string): GatewayError {
  try {
    const j = JSON.parse(text) as { error?: { message?: string; type?: string } };
    return { status, type: j.error?.type ?? 'unknown', message: j.error?.message ?? text.slice(0, 300) };
  } catch {
    return { status, type: 'unknown', message: text.slice(0, 300) };
  }
}

export const isBalanceInsufficient = (e: GatewayError) => e.message.includes('balance is below the quote cap');
export const isTxNotYetVisible = (e: GatewayError) => e.message.includes('not found or not yet confirmed');
