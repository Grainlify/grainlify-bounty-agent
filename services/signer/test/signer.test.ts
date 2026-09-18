import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Journal } from '../src/journal.ts';
import type { PaymentRail, TransferResult } from '../src/rails.ts';
import { Signer, signerConfig } from '../src/signer.ts';

const PAY_TO = 'GXfqVnZENHzvim8rNN8TPwqxWXQe8EBbxhcEMYE8Z7BS';
const MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
let n = 0;
const quoteId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const req = (amount: number, over: Record<string, unknown> = {}) => ({ quote_id: quoteId(), network: MAINNET, asset: 'USDC', pay_to: PAY_TO, amount_microunits: amount, ...over });

class FakeRail implements PaymentRail {
  readonly kind = 'mock' as const;
  sent: { to: string; amountMicro: number }[] = [];
  failBuild = false;
  failBroadcast = false;
  address() {
    return 'FakePayer1111111111111111111111111111111111';
  }
  signMessage(m: string) {
    return `signed:${m}`;
  }
  async prepareUsdcTransfer(args: { to: string; amountMicro: number }) {
    if (this.failBuild) throw new Error('rpc down');
    const signature = `sig-${this.sent.length + 1}-${Math.random()}`;
    return {
      signature,
      broadcast: async (): Promise<TransferResult> => {
        this.sent.push(args);
        if (this.failBroadcast) throw new Error('timeout waiting for confirmation');
        return { signature, feeLamports: 5_010 };
      },
    };
  }
}

function setup(env: Record<string, string> = {}) {
  const journal = new Journal(join(mkdtempSync(join(tmpdir(), 'signer-')), 'j.sqlite'), 'mock');
  const rail = new FakeRail();
  const signer = new Signer(signerConfig({ SIGNER_SOL_USD_CEILING_PRICE: '400', ...env }), journal, rail);
  return { journal, rail, signer };
}

describe('signer policy', () => {
  it('pays an allowlisted UsePod quote and journals it', async () => {
    const { signer, rail, journal } = setup();
    const r = await signer.payQuote(req(35));
    expect(r).toMatchObject({ ok: true, amount_micro: 35, fee_lamports: 5_010 });
    expect(rail.sent).toEqual([{ to: PAY_TO, amountMicro: 35 }]);
    expect(journal.committedMicro()).toBe(35 + 2_004); // 5010 lamports at $400/SOL, rounded up
  });

  it('refuses anything that is not a UsePod USDC payment on mainnet', async () => {
    const { signer, rail } = setup();
    const bad = [
      req(35, { pay_to: 'Attacker1111111111111111111111111111111111' }),
      req(35, { network: 'solana:devnet' }),
      req(35, { asset: 'SOL' }),
      req(35, { quote_id: 'not-a-uuid' }),
      req(0),
      req(60_000), // above the default $0.05 per-call maximum
      req(35, { expires_at: new Date(Date.now() - 1_000).toISOString() }),
    ];
    for (const b of bad) expect((await signer.payQuote(b)).ok).toBe(false);
    expect(rail.sent).toHaveLength(0);
  });

  it('enforces its own lifetime ceiling, whatever the agent thinks', async () => {
    const { signer, rail } = setup({ SIGNER_LIFETIME_CEILING_MICRO: '30000' });
    expect((await signer.payQuote(req(20_000))).ok).toBe(true); // 20_000 + 4_000 fee reserve = 24_000
    const second = await signer.payQuote(req(5_000)); // would reach 29_000 + fee > 30_000
    expect(second).toMatchObject({ ok: false, status: 403 });
    expect(rail.sent).toHaveLength(1);
  });

  it('cannot be configured above $5.00', () => {
    expect(signerConfig({ SIGNER_LIFETIME_CEILING_MICRO: '999000000' }).lifetimeCeilingMicro).toBe(5_000_000);
  });

  it('pays each quote at most once and replays the same proof', async () => {
    const { signer, rail } = setup();
    const r = req(35);
    const a = await signer.payQuote(r);
    const b = await signer.payQuote(r);
    expect(a.ok && b.ok && a.signature === b.signature).toBe(true);
    expect(rail.sent).toHaveLength(1);
  });

  it('stops counting a payment only when nothing was sent', async () => {
    const { signer, rail, journal } = setup();
    rail.failBuild = true;
    expect(await signer.payQuote(req(35))).toMatchObject({ ok: false, status: 422 });
    expect(journal.committedMicro()).toBe(0);
  });

  it('keeps counting a payment whose broadcast outcome is unknown', async () => {
    const { signer, rail, journal } = setup();
    rail.failBroadcast = true;
    expect(await signer.payQuote(req(35))).toMatchObject({ ok: false, status: 502 });
    expect(journal.committedMicro()).toBe(35 + 4_000); // amount + full fee reserve
    expect(journal.all()[0]).toMatchObject({ status: 'sent' });
  });

  it('refuses balance proofs once the ceiling is reached', async () => {
    const { signer, rail } = setup({ SIGNER_LIFETIME_CEILING_MICRO: '4035' });
    expect(signer.balanceProof(quoteId()).ok).toBe(true);
    rail.failBroadcast = true; // outcome unknown, so the full 35 + 4000 reserve stays counted: exactly the ceiling
    await signer.payQuote(req(35));
    expect(signer.balanceProof(quoteId())).toMatchObject({ ok: false, status: 403 });
  });

  it('signs the exact balance message for the quote', () => {
    const { signer } = setup();
    const id = quoteId();
    expect(signer.balanceProof(id)).toMatchObject({ ok: true, proof: `signed:usepod-x402-spend:${id}` });
  });
});

describe('journal mode binding', () => {
  it('refuses to back a real signer with a journal of mock payments, and vice versa', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'bind-')), 'j.sqlite');
    new Journal(path, 'mock').close();
    expect(() => new Journal(path, 'solana')).toThrow(/mock journal/);
    const live = join(mkdtempSync(join(tmpdir(), 'bind-')), 'j.sqlite');
    new Journal(live, 'solana').close();
    expect(() => new Journal(live, 'mock')).toThrow(/solana journal/);
  });

  it('refuses a pre-binding journal that already has payments instead of guessing its rail', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const path = join(mkdtempSync(join(tmpdir(), 'bind-')), 'j.sqlite');
    new Journal(path, 'mock').close();
    const raw = new DatabaseSync(path);
    raw.exec(`DELETE FROM journal_meta; INSERT INTO inference_payments (quote_id, pay_to, amount_micro, fee_reserve_micro, status) VALUES ('q', 'x', 1, 0, 'confirmed')`);
    raw.close();
    expect(() => new Journal(path, 'solana')).toThrow(/refusing to guess/);
    expect(() => new Journal(path, 'mock')).toThrow(/refusing to guess/);
  });
});
