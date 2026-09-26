import { describe, expect, it } from "vitest";
import { buildLedgerMetrics } from "../src/ledger-metrics.js";

describe("ledger metrics response shape", () => {
  it("reports zeros for sums and nulls for ratios on an empty ledger", () => {
    const m = buildLedgerMetrics({ servedCalls: [], mergedPrCount: 0 });
    expect(m.servedCalls).toEqual({ onChain: 0, surplusCredit: 0, total: 0 });
    expect(m.inferenceTotal).toBe(0);
    expect(m.networkFeeTotal).toBe(0);
    expect(m.costPerServedCall).toBeNull();
    expect(m.costPerMergedPr).toBeNull();
  });

  it("splits schemes and averages; per-PR stays null when none merged", () => {
    const m = buildLedgerMetrics({
      servedCalls: [
        { scheme: "on-chain", inferenceCost: 0.001, networkFee: 0.099 },
        { scheme: "surplus-credit", inferenceCost: 0.002, networkFee: 0 },
      ],
      mergedPrCount: 0,
    });
    expect(m.servedCalls).toEqual({ onChain: 1, surplusCredit: 1, total: 2 });
    expect(m.inferenceTotal).toBeCloseTo(0.003);
    expect(m.networkFeeTotal).toBeCloseTo(0.099);
    expect(m.costPerServedCall).toBeCloseTo(0.051);
    expect(m.costPerMergedPr).toBeNull();
  });

  it("computes cost per merged PR when the denominator is non-zero", () => {
    const m = buildLedgerMetrics({
      servedCalls: [
        { scheme: "on-chain", inferenceCost: 0.001, networkFee: 0.099 },
      ],
      mergedPrCount: 2,
    });
    expect(m.costPerServedCall).toBeCloseTo(0.1);
    expect(m.costPerMergedPr).toBeCloseTo(0.05);
  });

  it("reports 0 per merged PR when PRs exist but spend is empty", () => {
    const m = buildLedgerMetrics({ servedCalls: [], mergedPrCount: 1 });
    expect(m.costPerServedCall).toBeNull();
    expect(m.costPerMergedPr).toBe(0);
  });
});
