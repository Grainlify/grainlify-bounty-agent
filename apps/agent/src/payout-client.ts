import type { Approval } from '../../../packages/gate/src/approval.ts';
import type { PayoutSignerApi } from './service.ts';

/** The agent's side of the payout signer. It forwards a human approval; it cannot create one. */
export class PayoutSignerClient implements PayoutSignerApi {
  constructor(private readonly baseUrl: string, private readonly token: string, private readonly f: typeof fetch = fetch) {}

  async pay(approval: Approval) {
    try {
      const r = await this.f(`${this.baseUrl}/v1/payout/pay`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ approval }),
      });
      const body = (await r.json().catch(() => ({}))) as { signature?: string; error?: string };
      return r.ok && body.signature ? { ok: true as const, signature: body.signature } : { ok: false as const, status: r.status, error: body.error ?? String(r.status) };
    } catch (e) {
      return { ok: false as const, status: 502, error: `payout signer unreachable: ${String(e)}` };
    }
  }
}
