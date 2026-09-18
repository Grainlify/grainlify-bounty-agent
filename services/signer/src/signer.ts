// The signer's decision logic, separate from HTTP so it can be tested
// directly. Every check here is independent of the agent: the agent can ask
// for anything, and this decides from its own journal and config.

import { HARD_LIFETIME_CEILING_MICRO, lamportsToMicroCeil } from '../../../packages/budget/src/governor.ts';
import { SOLANA_MAINNET, USEPOD_PAY_TO_ALLOWLIST, balanceProofMessage } from '../../../packages/x402/src/protocol.ts';
import type { Journal } from './journal.ts';
import type { PaymentRail } from './rails.ts';
import { FEE_RESERVE_LAMPORTS } from './solana-rail.ts';

export interface SignerConfig {
  lifetimeCeilingMicro: number;
  maxPerCallMicro: number;
  solUsdCeilingPrice: number;
}

export interface PayQuoteRequest {
  quote_id: string;
  network: string;
  asset: string;
  pay_to: string;
  amount_microunits: number;
  expires_at?: string;
}

export type PayResult =
  | { ok: true; payer_wallet: string; signature: string; amount_micro: number; fee_lamports: number; fee_micro: number }
  | { ok: false; status: number; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function signerConfig(env: NodeJS.ProcessEnv): SignerConfig {
  const num = (k: string, d: number) => {
    const v = env[k];
    if (v === undefined || v === '') return d;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${k} must be a non-negative number`);
    return n;
  };
  return {
    // Config can lower the ceiling, never raise it past $5.00.
    lifetimeCeilingMicro: Math.min(num('SIGNER_LIFETIME_CEILING_MICRO', HARD_LIFETIME_CEILING_MICRO), HARD_LIFETIME_CEILING_MICRO),
    maxPerCallMicro: num('SIGNER_MAX_PER_CALL_MICRO', 50_000),
    solUsdCeilingPrice: num('SIGNER_SOL_USD_CEILING_PRICE', 400),
  };
}

export class Signer {
  constructor(
    private readonly cfg: SignerConfig,
    private readonly journal: Journal,
    private readonly rail: PaymentRail,
    private readonly now: () => Date = () => new Date(),
  ) {}

  address() {
    return this.rail.address();
  }

  spend() {
    return { committed_micro: this.journal.committedMicro(), ceiling_micro: this.cfg.lifetimeCeilingMicro, payments: this.journal.all() };
  }

  async payQuote(req: PayQuoteRequest): Promise<PayResult> {
    const refuse = (error: string, status = 403): PayResult => ({ ok: false, status, error });

    if (typeof req.quote_id !== 'string' || !UUID.test(req.quote_id)) return refuse('quote_id must be a UUID', 400);
    if (req.network !== SOLANA_MAINNET) return refuse(`network ${req.network} is not Solana mainnet`);
    if (req.asset !== 'USDC') return refuse(`asset ${req.asset} is not USDC`);
    if (!USEPOD_PAY_TO_ALLOWLIST.includes(req.pay_to)) return refuse(`pay_to ${req.pay_to} is not an allowlisted UsePod address`);
    if (!Number.isSafeInteger(req.amount_microunits) || req.amount_microunits <= 0) return refuse('amount must be a positive integer', 400);
    if (req.amount_microunits > this.cfg.maxPerCallMicro) {
      return refuse(`amount ${req.amount_microunits} exceeds the per-call maximum ${this.cfg.maxPerCallMicro}`);
    }
    if (req.expires_at && Date.parse(req.expires_at) <= this.now().getTime() + 10_000) return refuse('quote has expired or is about to', 400);

    const feeReserveMicro = lamportsToMicroCeil(FEE_RESERVE_LAMPORTS, this.cfg.solUsdCeilingPrice);
    const reservation = this.journal.reserve({
      quoteId: req.quote_id,
      payTo: req.pay_to,
      amountMicro: req.amount_microunits,
      feeReserveMicro,
      ceilingMicro: this.cfg.lifetimeCeilingMicro,
    });
    if (!reservation.ok) {
      const ex = reservation.existing;
      if (ex?.status === 'confirmed' && ex.tx_signature) {
        // Idempotent replay of a payment that already landed: hand back the same proof, pay nothing.
        return { ok: true, payer_wallet: this.address(), signature: ex.tx_signature, amount_micro: ex.amount_micro, fee_lamports: 0, fee_micro: ex.fee_micro ?? 0 };
      }
      return refuse(reservation.reason, ex ? 409 : 403);
    }

    let prepared: Awaited<ReturnType<PaymentRail['prepareUsdcTransfer']>>;
    try {
      prepared = await this.rail.prepareUsdcTransfer({ to: req.pay_to, amountMicro: req.amount_microunits });
    } catch (e) {
      // Nothing was built or sent, so this reservation stops counting.
      this.journal.markFailedUnsent(reservation.id, String(e));
      // 4xx tells the agent nothing was sent, so it can release its own reservation.
      return refuse(`could not build transfer: ${String(e)}`, 422);
    }
    // Record the signature before broadcasting. From here on, the reservation stays counted even if we crash.
    this.journal.markSent(reservation.id, prepared.signature);
    try {
      const res = await prepared.broadcast();
      const feeMicro = lamportsToMicroCeil(res.feeLamports, this.cfg.solUsdCeilingPrice);
      this.journal.markConfirmed(reservation.id, feeMicro);
      return { ok: true, payer_wallet: this.address(), signature: res.signature, amount_micro: req.amount_microunits, fee_lamports: res.feeLamports, fee_micro: feeMicro };
    } catch (e) {
      // Possibly on-chain. It stays 'sent' and keeps counting until reconciled.
      this.journal.markError(reservation.id, String(e));
      return refuse(`broadcast outcome unknown for ${prepared.signature}: ${String(e)}`, 502);
    }
  }

  /** Signs the surplus-credit spend proof. Moves no money: the credit was counted when it was paid in. */
  balanceProof(quoteId: string): { ok: true; payer_wallet: string; proof: string } | { ok: false; status: number; error: string } {
    if (typeof quoteId !== 'string' || !UUID.test(quoteId)) return { ok: false, status: 400, error: 'quote_id must be a UUID' };
    // Refuse to sign once the ceiling is reached: "hard stop, no calls" means no calls on credit either.
    if (this.journal.committedMicro() >= this.cfg.lifetimeCeilingMicro) {
      return { ok: false, status: 403, error: 'signer lifetime ceiling reached; no further inference' };
    }
    this.journal.recordBalanceProof(quoteId);
    return { ok: true, payer_wallet: this.address(), proof: this.rail.signMessage(balanceProofMessage(quoteId)) };
  }
}
