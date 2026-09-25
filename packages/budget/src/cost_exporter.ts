export interface InferenceCostMetric {
  model: string;
  tokensProcessed: number;
  costInUsd: number;
  timestamp: string;
}

export class InferenceCostExporter {
  private metrics: InferenceCostMetric[] = [];

  public recordMetric(metric: InferenceCostMetric): void {
    this.metrics.push(metric);
  }

  public getExportableMetrics(): { totalCost: number; metrics: InferenceCostMetric[] } {
    const totalCost = this.metrics.reduce((acc, m) => acc + m.costInUsd, 0);
    return {
      totalCost,
      metrics: [...this.metrics],
    };
  }
}
