import type { Approval } from '../../../packages/gate/src/approval.ts';
import type { Attestor } from './funded-service.ts';
import type { PayoutSignerApi } from './service.ts';

/** The agent's side of the payout signer. It forwards a human approval; it cannot create one. */
export class PayoutSignerClient implements PayoutSignerApi, Attestor {
  constructor(private readonly baseUrl: string, private readonly token: string, private readonly f: typeof fetch = fetch) {}

  private async post(path: string, payload: unknown) {
    try {
      const r = await this.f(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = (await r.json().catch(() => ({}))) as { signature?: string; error?: string };
      return r.ok && body.signature ? { ok: true as const, signature: body.signature } : { ok: false as const, status: r.status, error: body.error ?? String(r.status) };
    } catch (e) {
      return { ok: false as const, status: 502, error: `payout signer unreachable: ${String(e)}` };
    }
  }

  pay(approval: Approval) {
    return this.post('/v1/payout/pay', { approval });
  }

  /** A funded bounty's release: the same approval, the escrow's route. */
  releaseEscrow(approval: Approval) {
    return this.post('/v1/escrow/release', { approval });
  }

  /** Draw mode's two non-monetary signatures. The signer re-reads the escrow before either. */
  assign(escrow: string, contributorWallet: string) {
    return this.post('/v1/escrow/assign', { escrow, contributor: contributorWallet });
  }

  unassign(escrow: string) {
    return this.post('/v1/escrow/unassign', { escrow });
  }
}
