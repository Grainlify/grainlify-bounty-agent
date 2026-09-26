// The agent's side of the signer: an HTTP client implementing Payer. It
// carries a bearer token and nothing else. No key material lives here.

import type { PayOutcome, Payer } from '../../../packages/x402/src/client.ts';
import type { SolanaUsdcRail } from '../../../packages/x402/src/protocol.ts';

export class SignerClient implements Payer {
  private cachedAddress: string | null = null;

  constructor(private readonly baseUrl: string, private readonly token: string, private readonly f: typeof fetch = fetch) {}

  private headers() {
    return { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' };
  }

  async address() {
    if (this.cachedAddress) return this.cachedAddress;
    const r = await this.f(`${this.baseUrl}/v1/wallet`, { headers: this.headers() });
    if (!r.ok) throw new Error(`signer /v1/wallet: ${r.status}`);
    this.cachedAddress = ((await r.json()) as { address: string }).address;
    return this.cachedAddress;
  }

  async payQuote(rail: SolanaUsdcRail & { amount_microunits: number }): Promise<PayOutcome> {
    let r: Response;
    try {
      r = await this.f(`${this.baseUrl}/v1/inference/pay`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ quote_id: rail.quote_id, network: rail.network, asset: rail.asset, pay_to: rail.pay_to, amount_microunits: rail.amount_microunits, expires_at: rail.expires_at }),
      });
    } catch (e) {
      // We don't know whether the signer got the request.
      return { kind: 'unknown', error: `signer unreachable: ${String(e)}` };
    }
    const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (r.ok) {
      return { kind: 'paid', payer_wallet: String(body.payer_wallet), signature: String(body.signature), amount_micro: Number(body.amount_micro), fee_micro: Number(body.fee_micro), fee_lamports: Number(body.feeLamports) };
    }
    // 4xx: refused before anything was sent. 5xx: sent or unknown.
    const error = String(body.error ?? r.status);
    return r.status >= 500 ? { kind: 'unknown', error } : { kind: 'refused', error };
  }

  async balanceProof(quoteId: string) {
    const r = await this.f(`${this.baseUrl}/v1/inference/balance-proof`, { method: 'POST', headers: this.headers(), body: JSON.stringify({ quote_id: quoteId }) });
    const body = (await r.json().catch(() => ({}))) as { payer_wallet?: string; proof?: string; error?: string };
    if (!r.ok || !body.proof || !body.payer_wallet) throw new Error(`signer refused balance proof: ${body.error ?? r.status}`);
    return { payer_wallet: body.payer_wallet, proof: body.proof };
  }
}
