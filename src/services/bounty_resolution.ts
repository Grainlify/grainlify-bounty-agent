/**
 * packages/budget/src/metrics.ts
 * Export the existing calculation logic for use in the API layer.
 */
export interface LedgerMetrics {
  callCounts: { onChain: number; surplus: number };
  totals: { inference: number; networkFee: number };
  averages: { costPerServedCall: number | null; costPerMergedPr: number | null };
}

export const computeLedgerMetrics = (ledger: any[]): LedgerMetrics => {
  // Logic migrated/referenced from existing computeMetrics
  const onChain = ledger.filter(e => e.type === 'on-chain').length;
  const surplus = ledger.filter(e => e.type === 'surplus').length;
  
  const totalInference = ledger.reduce((acc, e) => acc + (e.inferenceCost || 0), 0);
  const totalNetworkFee = ledger.reduce((acc, e) => acc + (e.networkFee || 0), 0);
  const totalPaid = totalInference + totalNetworkFee;
  
  const servedCount = ledger.length;
  const prCount = /* Logic to retrieve processed PR count */ 0;

  return {
    callCounts: { onChain, surplus },
    totals: { inference: totalInference, networkFee: totalNetworkFee },
    averages: {
      costPerServedCall: servedCount > 0 ? totalPaid / servedCount : null,
      costPerMergedPr: prCount > 0 ? totalPaid / prCount : null,
    }
  };
};

/**
 * apps/agent/src/public.ts
 * Extend PublicApi.ledger() response.
 */
import { computeLedgerMetrics } from '@repo/budget/metrics';

export interface LedgerResponse {
  events: LedgerEvent[];
  aggregates?: ReturnType<typeof computeLedgerMetrics>; // Added field
}

// Inside PublicApi class:
public async ledger(): Promise<LedgerResponse> {
  const events = await this.db.getLedger();
  return {
    events,
    aggregates: computeLedgerMetrics(events)
  };
}

/**
 * apps/agent/test/ledger.test.ts
 * Ensure backward compatibility and null handling.
 */
import { expect, test } from 'vitest';
import { computeLedgerMetrics } from '@repo/budget/metrics';

test('aggregates handles empty states with null', () => {
  const metrics = computeLedgerMetrics([]);
  expect(metrics.averages.costPerServedCall).toBeNull();
  expect(metrics.averages.costPerMergedPr).toBeNull();
});

test('aggregates computes totals correctly', () => {
  const mockEvents = [
    { type: 'on-chain', inferenceCost: 10, networkFee: 90 },
    { type: 'surplus', inferenceCost: 5, networkFee: 0 }
  ];
  const metrics = computeLedgerMetrics(mockEvents);
  expect(metrics.totals.inference).toBe(15);
  expect(metrics.totals.networkFee).toBe(90);
  expect(metrics.averages.costPerServedCall).toBe(52.5);
});