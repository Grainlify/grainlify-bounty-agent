export type LedgerScheme = "on-chain" | "surplus-credit";

export interface ServedCall {
  scheme: LedgerScheme;
  inferenceCost: number;
  networkFee: number;
}

export interface LedgerMetrics {
  /** Served-call counts split by scheme. Always numbers; 0 when the ledger is empty. */
  servedCalls: { onChain: number; surplusCredit: number; total: number };
  /** Sum of inference cost for served calls. 0 when empty. */
  inferenceTotal: number;
  /** Sum of Solana network fees for served calls. 0 when empty. */
  networkFeeTotal: number;
  /** Mean of inference + network fee per served call, or null when none served. */
  costPerServedCall: number | null;
  /** Total spend per merged PR, or null when none have merged yet. */
  costPerMergedPr: number | null;
}

/**
 * Build the `metrics` object for the public ledger response.
 *
 * Counts and sums are 0 on an empty ledger. Ratios are null when the
 * denominator is 0 so "nothing served / nothing merged" is not reported
 * as zero cost.
 */
export function buildLedgerMetrics(opts: {
  servedCalls: readonly ServedCall[];
  mergedPrCount: number;
}): LedgerMetrics {
  let onChain = 0;
  let surplusCredit = 0;
  let inferenceTotal = 0;
  let networkFeeTotal = 0;

  for (const call of opts.servedCalls) {
    if (call.scheme === "on-chain") onChain += 1;
    else if (call.scheme === "surplus-credit") surplusCredit += 1;
    inferenceTotal += call.inferenceCost;
    networkFeeTotal += call.networkFee;
  }

  const total = opts.servedCalls.length;
  const grandTotal = inferenceTotal + networkFeeTotal;

  return {
    servedCalls: { onChain, surplusCredit, total },
    inferenceTotal,
    networkFeeTotal,
    costPerServedCall: total > 0 ? grandTotal / total : null,
    costPerMergedPr: opts.mergedPrCount > 0 ? grandTotal / opts.mergedPrCount : null,
  };
}
