// One row per inference call: the receipt. It links the on-chain payment (or
// credit spend) to what it paid for.

import type { Phase } from '../../budget/src/governor.ts';

export type CallPurpose = 'triage' | 'price' | 'review' | 'crosscheck' | 'spike' | 'eval';

export type CallStatus =
  | 'quoting'
  | 'quoted'
  | 'paid'
  | 'served'
  | 'failed'
  | 'refused_budget'
  | 'refused_signer'
  | 'payment_unknown'
  | 'paid_not_served';

export interface CallLinks {
  bountyId?: string;
  submissionId?: string;
  repo?: string;
  issueNumber?: number;
  prNumber?: number;
  evalItemId?: string;
}

export interface InferenceCallRecord {
  id: string;
  purpose: CallPurpose;
  phase: Phase;
  model: string;
  path: string;
  links: CallLinks;
  routingRequested: Record<string, unknown>;
  maxTokens: number;
  requestSha256: string;
  status: CallStatus;
  createdAt: Date;
  quoteId?: string | null;
  quoteCapMicro?: number | null;
  quoteExpiresAt?: string | null;
  scheme?: 'onchain' | 'balance' | null;
  payerWallet?: string | null;
  payTxSignature?: string | null;
  paidMicro?: number | null;
  feeMicro?: number | null;
  chargedMicro?: number | null;
  paymentResponseRaw?: string | null;
  paymentResponse?: Record<string, unknown> | null;
  responseHeaders?: Record<string, string>;
  responseSha256?: string | null;
  usageIn?: number | null;
  usageOut?: number | null;
  latencyMs?: number | null;
  error?: string | null;
}

export interface ReceiptStore {
  insert(rec: InferenceCallRecord): Promise<InferenceCallRecord>;
  update(id: string, patch: Partial<InferenceCallRecord>): Promise<InferenceCallRecord>;
  list(): Promise<InferenceCallRecord[]>;
}

export class InMemoryReceiptStore implements ReceiptStore {
  private rows = new Map<string, InferenceCallRecord>();

  async insert(rec: InferenceCallRecord) {
    if (this.rows.has(rec.id)) throw new Error(`duplicate call ${rec.id}`);
    this.rows.set(rec.id, { ...rec });
    return { ...rec };
  }

  async update(id: string, patch: Partial<InferenceCallRecord>) {
    const cur = this.rows.get(id);
    if (!cur) throw new Error(`no call ${id}`);
    const next = { ...cur, ...patch, id };
    this.rows.set(id, next);
    return { ...next };
  }

  async list() {
    return [...this.rows.values()].map((r) => ({ ...r }));
  }
}
