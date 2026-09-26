// What a paid call actually cost, and what the same tokens would have cost at
// list price. Read-only: it derives everything from inference_calls, so the
// numbers can be re-derived by anyone with the ledger.

export interface CallRow {
  scheme: string | null;
  status: string;
  model: string;
  paidMicro: number | null;
  feeMicro: number | null;
  chargedMicro: number | null;
  usageIn: number | null;
  usageOut: number | null;
  links: { repo?: string; issueNumber?: number } | null;
}

export interface ListPrice { inputPer1m: number; outputPer1m: number }

export interface Metrics {
  paidCalls: number;          // calls that moved money on-chain
  creditCalls: number;        // served from surplus credit, no transaction
  servedCalls: number;
  inferenceMicro: number;     // what the gateway charged for inference
  feeMicro: number;           // Solana network fees
  totalMicro: number;
  feeSharePct: number | null; // fees as a share of total spend
  feeToInferenceRatio: number | null;
  costPerServedCallMicro: number | null;
  costPerPaidCallMicro: number | null;
  listPriceMicro: number | null;  // same tokens at the cheapest list price
  listPriceModels: number;        // how many calls we could price
}

/** Rounds to a whole micro-unit the way a bill does: never under-state a cost. */
const up = (n: number) => Math.ceil(n - 1e-9);

export function computeMetrics(rows: CallRow[], list: Map<string, ListPrice>): Metrics {
  const served = rows.filter((r) => r.status === 'served');
  const paid = served.filter((r) => r.scheme === 'onchain');
  const credit = served.filter((r) => r.scheme === 'balance');

  // charged_micro is what the gateway billed. Fall back to paid_micro only when
  // the receipt did not report it, and never for a credit call, which paid 0.
  const inference = served.reduce((a, r) => a + (r.chargedMicro ?? (r.scheme === 'balance' ? 0 : (r.paidMicro ?? 0))), 0);
  const fee = served.reduce((a, r) => a + (r.feeMicro ?? 0), 0);
  const total = inference + fee;

  let listMicro = 0;
  let priced = 0;
  for (const r of served) {
    const p = list.get(r.model);
    if (!p || r.usageIn == null || r.usageOut == null) continue;
    priced++;
    listMicro += up((r.usageIn * p.inputPer1m + r.usageOut * p.outputPer1m) / 1_000_000);
  }

  return {
    paidCalls: paid.length,
    creditCalls: credit.length,
    servedCalls: served.length,
    inferenceMicro: inference,
    feeMicro: fee,
    totalMicro: total,
    feeSharePct: total ? (fee / total) * 100 : null,
    feeToInferenceRatio: inference ? fee / inference : null,
    costPerServedCallMicro: served.length ? total / served.length : null,
    costPerPaidCallMicro: paid.length ? total / paid.length : null,
    listPriceMicro: priced ? listMicro : null,
    listPriceModels: priced,
  };
}

/** Spend attributable to one merged pull request, via the bounty it served. */
export function costPerMergedPr(rows: CallRow[], mergedKeys: Set<string>): { merged: number; attributedMicro: number; perMergedMicro: number | null; unattributedMicro: number } {
  let attributed = 0;
  let unattributed = 0;
  for (const r of rows.filter((x) => x.status === 'served')) {
    const cost = (r.chargedMicro ?? (r.scheme === 'balance' ? 0 : (r.paidMicro ?? 0))) + (r.feeMicro ?? 0);
    const key = r.links?.repo && r.links?.issueNumber != null ? `${r.links.repo}#${r.links.issueNumber}` : null;
    if (key && mergedKeys.has(key)) attributed += cost;
    else unattributed += cost;
  }
  return {
    merged: mergedKeys.size,
    attributedMicro: attributed,
    perMergedMicro: mergedKeys.size ? attributed / mergedKeys.size : null,
    unattributedMicro: unattributed,
  };
}
