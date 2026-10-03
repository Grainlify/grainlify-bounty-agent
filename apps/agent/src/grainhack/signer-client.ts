// The agent's side of the grainhack-signer. It forwards a human approval with
// the backend-signed statement; it cannot create either.

import type { GrainhackApproval } from '../../../../packages/gate/src/grainhack-approval.ts';

export type GrainhackPayResult =
  | { ok: true; signature: string }
  | { ok: false; status: number; error: string; unknown: boolean; existing?: { payout_id: string; status: string; tx_signature: string } };

export interface SignerJournalRow {
  payout_id: string;
  hackathon_id: string;
  pool: string;
  github_user_id: number;
  status: 'reserved' | 'sent' | 'confirmed' | 'unknown' | 'failed_unsent';
  tx_signature: string;
  resolved_by: string | null;
  resolved_reason: string | null;
}

export interface GrainhackSignerApi {
  pay(body: { approval: GrainhackApproval; statement: string; statement_signature: string }): Promise<GrainhackPayResult>;
  /** The signer's journal, or null when it cannot be read. */
  payouts(): Promise<SignerJournalRow[] | null>;
  config(): Promise<{ network: string; mints: Record<string, { mint: string; decimals: number }>; address: string } | null>;
}

export class GrainhackSignerClient implements GrainhackSignerApi {
  private readonly baseUrl: string;
  constructor(baseUrl: string, private readonly token: string, private readonly f: typeof fetch = fetch) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async pay(body: { approval: GrainhackApproval; statement: string; statement_signature: string }): Promise<GrainhackPayResult> {
    let r: Response;
    try {
      r = await this.f(`${this.baseUrl}/v1/grainhack/pay`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      // The request may or may not have reached the signer: unknown, never "refused".
      return { ok: false, status: 502, unknown: true, error: `grainhack-signer unreachable: ${String(e)}` };
    }
    const j = (await r.json().catch(() => ({}))) as { signature?: string; error?: string; unknown?: boolean; existing?: { payout_id: string; status: string; tx_signature: string } };
    if (r.ok && j.signature) return { ok: true, signature: j.signature };
    // A 5xx without a reason may have happened after a broadcast.
    const unknown = j.unknown === true || r.status >= 500 || (r.ok && !j.signature);
    return { ok: false, status: r.status, error: j.error ?? String(r.status), unknown, ...(j.existing ? { existing: j.existing } : {}) };
  }

  private async get<T>(path: string): Promise<T | null> {
    try {
      const r = await this.f(`${this.baseUrl}${path}`, { headers: { authorization: `Bearer ${this.token}` } });
      return r.ok ? ((await r.json()) as T) : null;
    } catch {
      return null;
    }
  }

  async payouts() {
    return (await this.get<{ payouts: SignerJournalRow[] }>('/v1/grainhack/payouts'))?.payouts ?? null;
  }

  async config() {
    return this.get<{ network: string; mints: Record<string, { mint: string; decimals: number }>; address: string }>('/v1/config');
  }
}
