import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { signApproval, type PayoutTerms } from '../../../packages/gate/src/approval.ts';
import { PayoutJournal } from '../src/payout/journal.ts';
import { PayoutSigner, type PullFacts } from '../src/payout/payout-signer.ts';
import type { PayoutRail } from '../src/payout/rail.ts';

const now = new Date('2026-09-20T12:00:00Z');
const approver = Keypair.generate();
const approverAddr = approver.publicKey.toBase58();
const MINT = 'TestUsdcMint11111111111111111111111111111111';
let n = 0;

class FakeRail implements PayoutRail {
  sent: { to: string; amountMinor: bigint }[] = [];
  address() {
    return 'PayoutFloat1111111111111111111111111111111';
  }
  async prepareTransfer(a: { to: string; amountMinor: bigint }) {
    return { signature: `sig-${++n}`, broadcast: async () => void this.sent.push({ to: a.to, amountMinor: a.amountMinor }) };
  }
}

function setup(pull: Partial<PullFacts> | Error = {}) {
  const journal = new PayoutJournal(join(mkdtempSync(join(tmpdir(), 'payout-')), 'j.sqlite'));
  const rail = new FakeRail();
  const signer = new PayoutSigner(
    { network: 'solana-devnet', mints: { USDC: { mint: MINT, decimals: 6 } }, caps: {}, allowedRepos: ['Grainlify/grainlify-agent-sandbox'], trustedApprovers: [approverAddr] },
    journal,
    rail,
    async () => {
      if (pull instanceof Error) throw pull;
      return { merged: true, authorLogin: 'contributor', mergedByLogin: 'maintainer', ...pull };
    },
    () => now,
  );
  return { signer, rail, journal };
}

function terms(over: Partial<PayoutTerms> = {}): PayoutTerms {
  const id = ++n;
  return {
    payout_id: `p${id}`, bounty_id: `b${id}`, repo: 'Grainlify/grainlify-agent-sandbox', issue_number: 3, pr_number: 7, author_login: 'contributor',
    recipient: Keypair.generate().publicKey.toBase58(), amount_minor: '20000000', currency: 'USDC', mint: MINT, network: 'solana-devnet', ...over,
  };
}
const approve = (t: PayoutTerms) => signApproval(t, approver.secretKey, approverAddr, now);

describe('payout signer', () => {
  it('pays an approved payout for a merged PR and journals it', async () => {
    const { signer, rail, journal } = setup();
    const t = terms();
    expect(await signer.pay(approve(t))).toMatchObject({ ok: true });
    expect(rail.sent).toEqual([{ to: t.recipient, amountMinor: 20_000_000n }]);
    expect(journal.all()[0]).toMatchObject({ payout_id: t.payout_id, status: 'confirmed' });
  });

  it('refuses a direct call without a valid human approval', async () => {
    const { signer, rail } = setup();
    const t = terms();
    const forged = signApproval(t, Keypair.generate().secretKey, approverAddr, now); // claims to be the approver
    expect(await signer.pay(forged)).toMatchObject({ ok: false, error: expect.stringMatching(/signature/) });
    const untrusted = Keypair.generate();
    expect(await signer.pay(signApproval(t, untrusted.secretKey, untrusted.publicKey.toBase58(), now))).toMatchObject({ ok: false, error: expect.stringMatching(/not trusted/) });
    expect(rail.sent).toHaveLength(0);
  });

  it('re-checks the merge on GitHub itself and refuses unmerged, self-merged or mismatched PRs', async () => {
    for (const pull of [{ merged: false }, { mergedByLogin: 'contributor' }, { mergedByLogin: null }, { authorLogin: 'someone-else' }]) {
      const { signer, rail } = setup(pull);
      expect((await signer.pay(approve(terms()))).ok).toBe(false);
      expect(rail.sent).toHaveLength(0);
    }
  });

  it('fails closed when GitHub cannot be reached', async () => {
    const { signer, rail } = setup(new Error('network down'));
    expect(await signer.pay(approve(terms()))).toMatchObject({ ok: false, status: 503 });
    expect(rail.sent).toHaveLength(0);
  });

  it('refuses the wrong network, mint, repo, or an amount over the $50 hard cap, even if approved', async () => {
    const { signer, rail } = setup();
    for (const over of [{ network: 'solana-mainnet' }, { mint: 'OtherMint' }, { repo: 'Grainlify/Grainlify-Backend' }, { amount_minor: '50000001' }, { amount_minor: '0' }, { currency: 'ANSEM' }]) {
      expect((await signer.pay(approve(terms(over)))).ok).toBe(false);
    }
    expect(rail.sent).toHaveLength(0);
  });

  it('pays a bounty at most once, and never reuses an approval', async () => {
    const { signer, rail } = setup();
    const t = terms();
    const a = approve(t);
    await signer.pay(a);
    expect(await signer.pay(a)).toMatchObject({ ok: true }); // idempotent replay, no second transfer
    expect(await signer.pay(approve({ ...terms(), bounty_id: t.bounty_id }))).toMatchObject({ ok: false, status: 409 });
    expect(rail.sent).toHaveLength(1);
  });

  it('enforces the $150 daily cap from its own journal', async () => {
    const { signer, rail } = setup();
    for (let i = 0; i < 3; i++) expect((await signer.pay(approve(terms({ amount_minor: '50000000' })))).ok).toBe(true);
    expect(await signer.pay(approve(terms({ amount_minor: '1000000' })))).toMatchObject({ ok: false, error: expect.stringMatching(/daily cap/) });
    expect(rail.sent).toHaveLength(3);
  });
});
