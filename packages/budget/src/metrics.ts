export interface LedgerMetricAggregate {
  served_call_count: string | number;
  on_chain_call_count: string | number;
  surplus_credit_call_count: string | number;
  unclassified_call_count: string | number;
  inference_total_micro: string | number | null;
  network_fee_total_micro: string | number | null;
  merged_pr_count: string | number;
}

export interface PublicLedgerMetrics {
  servedCalls: {
    total: number;
    onChain: number;
    surplusCredit: number;
    unclassified: number;
  };
  /** Actual gateway charges from served receipts, in micro-USD. */
  inferenceTotalMicro: number | null;
  /** Sum of the ledger's fee_micro values, in its conservative micro-USD estimate. */
  networkFeeTotalMicro: number | null;
  costPerServedCallMicro: number | null;
  costPerMergedPrMicro: number | null;
}

function count(value: string | number, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ledger metric count for ${field}`);
  }
  return parsed;
}

function amount(value: string | number | null, field: string): number | null {
  if (value === null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ledger metric amount for ${field}`);
  }
  return parsed;
}

/** Convert one database aggregate row into the public ledger metrics. */
export function computeMetrics(row: LedgerMetricAggregate, inferenceIsMock: boolean): PublicLedgerMetrics {
  const servedCallCount = count(row.served_call_count, 'served calls');
  const mergedPrCount = count(row.merged_pr_count, 'merged PRs');
  const inferenceTotal = amount(row.inference_total_micro, 'inference total');
  const networkFeeTotal = amount(row.network_fee_total_micro, 'network fee total');
  const allCostsKnown = inferenceTotal !== null && networkFeeTotal !== null;
  const totalCost = allCostsKnown ? inferenceTotal + networkFeeTotal : null;

  return {
    servedCalls: {
      total: servedCallCount,
      onChain: count(row.on_chain_call_count, 'on-chain calls'),
      surplusCredit: count(row.surplus_credit_call_count, 'surplus-credit calls'),
      unclassified: count(row.unclassified_call_count, 'unclassified calls'),
    },
    // Mock gateway amounts are test values, not real spend.
    inferenceTotalMicro: inferenceIsMock ? null : inferenceTotal,
    networkFeeTotalMicro: inferenceIsMock ? null : networkFeeTotal,
    costPerServedCallMicro:
      inferenceIsMock || totalCost === null || servedCallCount === 0 ? null : totalCost / servedCallCount,
    // No merged PR means the average is undefined, not zero.
    costPerMergedPrMicro:
      inferenceIsMock || totalCost === null || mergedPrCount === 0 ? null : totalCost / mergedPrCount,
  };
}
