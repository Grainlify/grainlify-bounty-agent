// Aggregate cost maths for the public ledger: what a served inference call
// costs on average, how much of that is the inference itself versus Solana
// network fees, and what a merged PR costs in inference spend.
//
// Null discipline: a figure that cannot be computed is null, never 0. "No
// merged PR yet" and "zero cost per merged PR" are different claims, and only
// the second may be reported as 0.

export type ServedScheme = 'onchain' | 'balance';

/** The cost fields of one served inference call, as recorded in the ledger. */
export interface ServedCallCost {
  /** 'onchain': paid per request over x402. 'balance': drawn from surplus credit. */
  scheme: ServedScheme | (string & {}) | null;
  /** What the inference itself cost on-chain (onchain calls). */
  paidMicro: number | null;
  /** The Solana network fee for settling the payment (onchain calls). */
  feeMicro: number | null;
  /** What the inference itself cost against the surplus-credit balance (balance calls). */
  chargedMicro: number | null;
}

export interface InferenceMetrics {
  servedCalls: number;
  /** Served calls split by payment scheme: on-chain x402 vs surplus credit. */
  servedByScheme: Record<ServedScheme, number>;
  /** Total the inference itself cost: on-chain payments plus balance charges. */
  inferenceMicro: number | null;
  /** Total Solana network fees across all served on-chain calls. */
  networkFeesMicro: number | null;
  /** (inference + fees) per served call; null when no call has been served. */
  costPerServedCallMicro: number | null;
  /** (inference + fees) per merged PR; null when no PR has merged yet. */
  costPerMergedPrMicro: number | null;
}

/** A micro amount we can honestly add up: present, finite and non-negative. */
function knownMicro(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/** Whole-micro division; null when the total is unknown or there is nothing to divide by. */
function perUnit(totalMicro: number | null, units: number): number | null {
  if (!knownMicro(totalMicro)) return null;
  if (typeof units !== 'number' || !Number.isFinite(units) || units <= 0) return null;
  return Math.round(totalMicro / Math.floor(units));
}

/** Total inference cost per merged PR; null while no PR has merged — never 0. */
export function costPerMergedPr(totalMicro: number | null, mergedPrs: number): number | null {
  return perUnit(totalMicro, mergedPrs);
}

/**
 * Aggregates the cost of served inference calls. A component that was not
 * recorded (a null or invalid micro field where a real figure belongs) makes
 * its total null: a partially known sum is not a sum.
 */
export function computeMetrics(calls: ServedCallCost[], mergedPrs: number): InferenceMetrics {
  if (!Array.isArray(calls)) throw new TypeError(`computeMetrics expects an array of served calls, got ${typeof calls}`);
  const servedByScheme: Record<ServedScheme, number> = { onchain: 0, balance: 0 };
  let inference = 0;
  let inferenceKnown = true;
  let fees = 0;
  let feesKnown = true;

  for (const c of calls) {
    const scheme = c?.scheme === 'balance' ? 'balance' : c?.scheme === 'onchain' ? 'onchain' : null;
    if (scheme) servedByScheme[scheme] += 1;
    // The inference charge lives in charged_micro for surplus-credit calls and
    // in paid_micro for on-chain ones; an unknown scheme is read as on-chain.
    const charge = scheme === 'balance' ? c?.chargedMicro : c?.paidMicro;
    if (knownMicro(charge)) inference += charge;
    else inferenceKnown = false;
    // A surplus-credit call has no on-chain transaction, so there is provably
    // no network fee; an on-chain call with no fee recorded is unknown.
    const fee = scheme === 'balance' ? (c?.feeMicro ?? 0) : c?.feeMicro;
    if (knownMicro(fee)) fees += fee;
    else feesKnown = false;
  }

  const inferenceMicro = inferenceKnown ? inference : null;
  const networkFeesMicro = feesKnown ? fees : null;
  const totalMicro = inferenceMicro !== null && networkFeesMicro !== null ? inferenceMicro + networkFeesMicro : null;
  return {
    servedCalls: calls.length,
    servedByScheme,
    inferenceMicro,
    networkFeesMicro,
    costPerServedCallMicro: perUnit(totalMicro, calls.length),
    costPerMergedPrMicro: costPerMergedPr(totalMicro, mergedPrs),
  };
}
