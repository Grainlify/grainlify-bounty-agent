// The escrow attestor: the one key that can release a funded escrow.
//
// Every test here is a way the key could be talked into paying the wrong
// thing, and the refusal that stops it. The chain is faked as decoded escrow
// state; what is under test is what the attestor checks before it signs.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair, PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { signApproval, type PayoutTerms } from '../../../packages/gate/src/approval.ts';
import { EscrowAttestor, type EscrowChain, type EscrowState } from '../src/payout/escrow-attestor.ts';
import { PayoutJournal } from '../src/payout/journal.ts';
import { PayoutSigner, type PullFacts } from '../src/payout/payout-signer.ts';

const now = new Date('2026-10-02T12:00:00Z');
const approver = Keypair.generate();
const approverAddr = approver.publicKey.toBase58();
const attestor = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const REPO = 'acme/widgets';
const BOUNTY = '0b6c3a51-8f0e-4b8e-9a0b-3c1d2e3f4a5b';

class FakeChain implements EscrowChain {
  escrows = new Map<string, EscrowState>();
  sent: TransactionInstruction[][] = [];
  async read(e: string) {
    return this.escrows.get(e) ?? null;
  }
  async send(ixs: TransactionInstruction[]) {
    this.sent.push(ixs);
    return `sig-${this.sent.length}`;
  }
}

function escrowState(over: Partial<EscrowState> = {}): EscrowState {
  return {
    bountyId: Buffer.from(BOUNTY.replace(/-/g, ''), 'hex'), funder: Keypair.generate().publicKey, mint, amount: 50_000_000n,
    feeBps: 250, feeMinimum: 250_000n, feeAmount: 1_250_000n, feeDestination: Keypair.generate().publicKey, attestor,
    mode: 0, state: 'Assigned', contributor: null, everAssigned: true, deadline: 0n, mergeCommit: null, ...over,
  } as EscrowState;
}

function setup(pull: Partial<PullFacts> = {}) {
  const journal = new PayoutJournal(join(mkdtempSync(join(tmpdir(), 'escrow-')), 'j.sqlite'));
  const chain = new FakeChain();
  const a = new EscrowAttestor(
    { network: 'solana-devnet', attestor: attestor.toBase58(), allowedRepos: [REPO], trustedApprovers: [approverAddr], caps: {} },
    journal, chain,
    async () => ({ merged: true, authorLogin: 'jotel-dev', mergedByLogin: 'owen', mergeCommitSha: 'a'.repeat(40), ...pull }),
    () => now,
  );
  return { a, chain, journal };
}

let n = 0;
function terms(escrow: string, recipient: string, over: Partial<PayoutTerms> = {}): PayoutTerms {
  return {
    payout_id: `p${++n}`, bounty_id: BOUNTY, repo: REPO, issue_number: 41, pr_number: 58, author_login: 'jotel-dev',
    recipient, amount_minor: '50000000', currency: 'USDC', mint: mint.toBase58(), network: 'solana-devnet', escrow, ...over,
  };
}
const approve = (t: PayoutTerms) => signApproval(t, approver.secretKey, approverAddr, now);

describe('escrow attestor', () => {
  const escrow = Keypair.generate().publicKey.toBase58();

  it('releases to the escrow\'s own contributor on an approval for a merged pull request', async () => {
    const { a, chain, journal } = setup();
    const who = Keypair.generate().publicKey;
    chain.escrows.set(escrow, escrowState({ contributor: who }));
    expect(await a.release(approve(terms(escrow, who.toBase58())))).toMatchObject({ ok: true });
    expect(chain.sent).toHaveLength(1);
    // Test tokens keep their own day: they never use up a real day's cap.
    expect(journal.all()[0]).toMatchObject({ status: 'confirmed', currency: 'USDC@solana-devnet' });
  });

  it('refuses to pay anybody but the contributor the escrow records', async () => {
    const { a, chain } = setup();
    chain.escrows.set(escrow, escrowState({ contributor: Keypair.generate().publicKey }));
    const r = await a.release(approve(terms(escrow, Keypair.generate().publicKey.toBase58())));
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/assigned to/) });
    expect(chain.sent).toHaveLength(0);
  });

  it('refuses an amount, mint or bounty that differs from what the escrow holds', async () => {
    const { a, chain } = setup();
    const who = Keypair.generate().publicKey;
    chain.escrows.set(escrow, escrowState({ contributor: who, amount: 10_000_000n }));
    expect(await a.release(approve(terms(escrow, who.toBase58())))).toMatchObject({ ok: false, error: expect.stringMatching(/holds 10000000/) });
    chain.escrows.set(escrow, escrowState({ contributor: who, mint: Keypair.generate().publicKey }));
    expect(await a.release(approve(terms(escrow, who.toBase58())))).toMatchObject({ ok: false, error: expect.stringMatching(/holds/) });
    chain.escrows.set(escrow, escrowState({ contributor: who, bountyId: Buffer.alloc(16, 7) }));
    expect(await a.release(approve(terms(escrow, who.toBase58())))).toMatchObject({ ok: false, error: expect.stringMatching(/different bounty/) });
    expect(chain.sent).toHaveLength(0);
  });

  it('refuses an unmerged or self-merged pull request, whatever the approval says', async () => {
    const who = Keypair.generate().publicKey;
    for (const pull of [{ merged: false }, { mergedByLogin: 'jotel-dev' }] as Partial<PullFacts>[]) {
      const { a, chain } = setup(pull);
      chain.escrows.set(escrow, escrowState({ contributor: who }));
      expect((await a.release(approve(terms(escrow, who.toBase58())))).ok).toBe(false);
      expect(chain.sent).toHaveLength(0);
    }
  });

  it('applies the hand-edited repository allowlist to releases too', async () => {
    const { a, chain } = setup();
    const who = Keypair.generate().publicKey;
    chain.escrows.set(escrow, escrowState({ contributor: who }));
    expect(await a.release(approve(terms(escrow, who.toBase58(), { repo: 'someone/else' })))).toMatchObject({ ok: false, error: expect.stringMatching(/allowlist/) });
  });

  it('refuses an escrow that trusts a different attestor', async () => {
    const { a, chain } = setup();
    const who = Keypair.generate().publicKey;
    chain.escrows.set(escrow, escrowState({ contributor: who, attestor: Keypair.generate().publicKey }));
    expect(await a.release(approve(terms(escrow, who.toBase58())))).toMatchObject({ ok: false, error: expect.stringMatching(/different attestor/) });
  });

  it('pays an escrow once', async () => {
    const { a, chain } = setup();
    const who = Keypair.generate().publicKey;
    chain.escrows.set(escrow, escrowState({ contributor: who }));
    expect((await a.release(approve(terms(escrow, who.toBase58())))).ok).toBe(true);
    expect((await a.release(approve(terms(escrow, who.toBase58())))).ok).toBe(false);
    expect(chain.sent).toHaveLength(1);
  });

  it('assigns and unassigns only draw-mode escrows, and only from the right state', async () => {
    const { a, chain } = setup();
    chain.escrows.set(escrow, escrowState({ state: 'Funded', contributor: null }));
    expect((await a.assign(escrow, Keypair.generate().publicKey.toBase58())).ok).toBe(true);
    chain.escrows.set(escrow, escrowState({ state: 'Funded', contributor: null, mode: 1 }));
    expect(await a.assign(escrow, Keypair.generate().publicKey.toBase58())).toMatchObject({ ok: false, error: expect.stringMatching(/only the funder/) });
    chain.escrows.set(escrow, escrowState({ state: 'Funded', contributor: null }));
    expect(await a.unassign(escrow)).toMatchObject({ ok: false, error: expect.stringMatching(/not Assigned/) });
  });
});

describe('the float and the escrows do not share approvals', () => {
  it('a payout approval for an escrow is refused by the float', async () => {
    const journal = new PayoutJournal(join(mkdtempSync(join(tmpdir(), 'float-')), 'j.sqlite'));
    const sent: unknown[] = [];
    const signer = new PayoutSigner(
      { network: 'solana-devnet', mints: { USDC: { mint: mint.toBase58(), decimals: 6 } }, caps: {}, allowedRepos: [REPO], trustedApprovers: [approverAddr] },
      journal,
      { address: () => 'Float1111111111111111111111111111111111111', prepareTransfer: async () => ({ signature: 's', broadcast: async () => void sent.push(1) }) },
      async () => ({ merged: true, authorLogin: 'jotel-dev', mergedByLogin: 'owen' }),
      () => now,
    );
    const t = terms(new PublicKey(attestor).toBase58(), Keypair.generate().publicKey.toBase58());
    expect(await signer.pay(approve(t))).toMatchObject({ ok: false, error: expect.stringMatching(/escrow release/) });
    expect(sent).toHaveLength(0);
  });

  it('an approval for the float is refused by the escrow route', async () => {
    const { a } = setup();
    const t = terms('', Keypair.generate().publicKey.toBase58());
    delete (t as Partial<PayoutTerms>).escrow;
    expect(await a.release(approve(t))).toMatchObject({ ok: false, error: expect.stringMatching(/not for an escrow/) });
  });
});
