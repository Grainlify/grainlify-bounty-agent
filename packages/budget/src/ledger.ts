// Spend ledger: where reservations and settled spends live. The governor's
// decision and the reservation insert happen atomically, so two concurrent
// calls cannot both squeeze under the ceiling.

import { decide, PHASES, type BudgetConfig, type Decision, type Phase, type SpendKind, type SpendRequest, type SpendTotals } from './governor.ts';

export type SpendStatus = 'reserved' | 'settled' | 'released';

export interface SpendEntry {
  id: string;
  callId: string | null;
  phase: Phase;
  kind: SpendKind;
  status: SpendStatus;
  reservedMicro: number;
  amountMicro: number | null;
  feeMicro: number | null;
  txSignature: string | null;
  createdAt: Date;
  settledAt: Date | null;
}

export interface Settlement {
  amountMicro: number;
  feeMicro: number;
  txSignature: string | null;
}

export interface SpendLedger {
  /** Checks the budget and, if it fits, records a reservation, as one atomic step. */
  reserve(req: SpendRequest & { callId: string | null }): Promise<{ decision: Decision; entryId: string | null }>;
  settle(entryId: string, s: Settlement): Promise<void>;
  /** Only when it is certain that no money moved. */
  release(entryId: string): Promise<void>;
  totals(): Promise<SpendTotals>;
  entries(): Promise<SpendEntry[]>;
}

/** What an entry counts against the budget right now. */
export function committedMicro(e: Pick<SpendEntry, 'status' | 'reservedMicro' | 'amountMicro' | 'feeMicro'>): number {
  if (e.status === 'released') return 0;
  if (e.status === 'reserved') return e.reservedMicro;
  return (e.amountMicro ?? 0) + (e.feeMicro ?? 0);
}

export function sumTotals(entries: SpendEntry[]): SpendTotals {
  const byPhase = Object.fromEntries(PHASES.map((p) => [p, 0])) as Record<Phase, number>;
  let lifetime = 0;
  for (const e of entries) {
    const c = committedMicro(e);
    lifetime += c;
    byPhase[e.phase] += c;
  }
  return { lifetimeMicro: lifetime, byPhase };
}

export class InMemorySpendLedger implements SpendLedger {
  private rows: SpendEntry[] = [];
  private seq = 0;

  constructor(private readonly cfg: BudgetConfig) {}

  async reserve(req: SpendRequest & { callId: string | null }) {
    // Synchronous from here to the push: no await, so no interleaving.
    const decision = decide(this.cfg, sumTotals(this.rows), req);
    if (!decision.ok) return { decision, entryId: null };
    const id = `spend-${++this.seq}`;
    this.rows.push({
      id, callId: req.callId, phase: req.phase, kind: req.kind, status: 'reserved', reservedMicro: req.amountMicro,
      amountMicro: null, feeMicro: null, txSignature: null, createdAt: new Date(), settledAt: null,
    });
    return { decision, entryId: id };
  }

  async settle(entryId: string, s: Settlement) {
    const row = this.mustGet(entryId);
    if (row.status !== 'reserved') throw new Error(`spend ${entryId} is ${row.status}, not reserved`);
    Object.assign(row, { status: 'settled', amountMicro: s.amountMicro, feeMicro: s.feeMicro, txSignature: s.txSignature, settledAt: new Date() });
  }

  async release(entryId: string) {
    const row = this.mustGet(entryId);
    if (row.status !== 'reserved') throw new Error(`spend ${entryId} is ${row.status}, not reserved`);
    row.status = 'released';
  }

  async totals() {
    return sumTotals(this.rows);
  }

  async entries() {
    return this.rows.map((r) => ({ ...r }));
  }

  private mustGet(id: string) {
    const row = this.rows.find((r) => r.id === id);
    if (!row) throw new Error(`no spend entry ${id}`);
    return row;
  }
}
