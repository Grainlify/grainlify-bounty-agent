// Inference budget governor.
//
// The whole project may spend at most $5.00 on inference, EVER. That covers
// x402 payments, the Solana network fees for them, and any API-key-path
// deposit. This file decides whether one more spend fits.
//
// Accounting is cash-basis: we count money leaving the inference wallet. A
// call paid from surplus credit moves no money and counts zero here; the
// credit was already counted when it was paid in.
//
// A spend is RESERVED before any money moves and stays reserved until we know
// the outcome. A reservation is released only when we are certain nothing was
// sent. "Unknown" stays counted, so the ceiling can never be crossed by a
// crash between paying and recording.

/** $5.00 in micro-USD. Configuration may lower this, never raise it. */
export const HARD_LIFETIME_CEILING_MICRO = 5_000_000;

export const PHASES = ['P1', 'P2P3', 'P4', 'LIVE'] as const;
export type Phase = (typeof PHASES)[number];

/** The allocation table agreed for the project, in micro-USD. It sums to exactly $5.00. */
export const PHASE_ALLOCATION_MICRO: Readonly<Record<Phase, number>> = {
  P1: 500_000, //   spike: routing, PAYMENT-RESPONSE, balance drawdown
  P2P3: 1_000_000, // end-to-end verification
  P4: 1_500_000, //   eval
  LIVE: 2_000_000, // live operation during judging
};

export type SpendKind = 'x402_payment' | 'apikey_deposit';

export interface BudgetConfig {
  lifetimeCeilingMicro: number;
  allocations: Readonly<Record<Phase, number>>;
}

export interface SpendTotals {
  lifetimeMicro: number;
  byPhase: Readonly<Record<Phase, number>>;
}

export interface SpendRequest {
  phase: Phase;
  kind: SpendKind;
  /** Payment amount plus the most the network fee could cost, in micro-USD. */
  amountMicro: number;
}

export type Decision =
  | { ok: true; lifetimeAfterMicro: number; phaseAfterMicro: number }
  | { ok: false; code: 'invalid_amount' | 'ceiling_reached' | 'over_lifetime' | 'over_phase' | 'unknown_phase'; reason: string };

export function budgetConfig(env: { lifetimeCeilingMicro?: number } = {}): BudgetConfig {
  const requested = env.lifetimeCeilingMicro ?? HARD_LIFETIME_CEILING_MICRO;
  if (!Number.isSafeInteger(requested) || requested < 0) throw new Error('lifetime ceiling must be a non-negative integer');
  return { lifetimeCeilingMicro: Math.min(requested, HARD_LIFETIME_CEILING_MICRO), allocations: PHASE_ALLOCATION_MICRO };
}

export function decide(cfg: BudgetConfig, totals: SpendTotals, req: SpendRequest): Decision {
  if (!Number.isSafeInteger(req.amountMicro) || req.amountMicro <= 0) {
    return { ok: false, code: 'invalid_amount', reason: `amount ${req.amountMicro} is not a positive integer` };
  }
  const allocation = cfg.allocations[req.phase];
  if (allocation === undefined) return { ok: false, code: 'unknown_phase', reason: `unknown phase ${String(req.phase)}` };

  const ceiling = Math.min(cfg.lifetimeCeilingMicro, HARD_LIFETIME_CEILING_MICRO);
  if (totals.lifetimeMicro >= ceiling) {
    return { ok: false, code: 'ceiling_reached', reason: `lifetime inference ceiling reached (${fmt(totals.lifetimeMicro)} of ${fmt(ceiling)}); no further calls` };
  }
  const lifetimeAfter = totals.lifetimeMicro + req.amountMicro;
  if (lifetimeAfter > ceiling) {
    return { ok: false, code: 'over_lifetime', reason: `would spend ${fmt(lifetimeAfter)} of the ${fmt(ceiling)} lifetime ceiling` };
  }
  const phaseAfter = (totals.byPhase[req.phase] ?? 0) + req.amountMicro;
  if (phaseAfter > allocation) {
    return { ok: false, code: 'over_phase', reason: `would spend ${fmt(phaseAfter)} of the ${fmt(allocation)} ${req.phase} allocation` };
  }
  return { ok: true, lifetimeAfterMicro: lifetimeAfter, phaseAfterMicro: phaseAfter };
}

export function fmt(micro: number): string {
  return `$${(micro / 1_000_000).toFixed(6)}`;
}

/** Converts a lamport fee to micro-USD at a deliberately high SOL price, rounding up. */
export function lamportsToMicroCeil(lamports: number, solUsdCeilingPrice: number): number {
  // 1 SOL = 1e9 lamports; micro-USD = lamports * price * 1e6 / 1e9
  return Math.ceil((lamports * solUsdCeilingPrice) / 1_000);
}
