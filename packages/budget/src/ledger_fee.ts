export interface LedgerTransactionFee {
  txHash: string;
  estimatedFee: number;
  actualNetworkFee: number;
  timestamp: string;
}

export class LedgerFeeTracker {
  private feeLogs: LedgerTransactionFee[] = [];

  public logFee(entry: LedgerTransactionFee): void {
    this.feeLogs.push(entry);
  }

  public getRealFeeSummary(): { totalRealFees: number; totalEstimatedFees: number } {
    return this.feeLogs.reduce(
      (acc, log) => ({
        totalRealFees: acc.totalRealFees + log.actualNetworkFee,
        totalEstimatedFees: acc.totalEstimatedFees + log.estimatedFee,
      }),
      { totalRealFees: 0, totalEstimatedFees: 0 }
    );
  }
}
