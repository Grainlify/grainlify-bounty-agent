// The attestor for maintainer-funded escrows. Lives in the payout signer, not
// the agent, for one reason: `release` needs only this key, so whoever holds
// it could release any escrow. Here it signs a release only with the same
// human approval a payout needs, after re-reading the merge from GitHub and the
// escrow from the chain - never the agent's word for either.
//
// assign and unassign (draw mode only) move no money, so they are signed on
// the agent's request without an approval. What they can do is bounded: the
// program pays only the contributor recorded on the escrow, and the release
// that would pay them still needs a human who sees that address first.

import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, type TransactionInstruction } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import bs58 from 'bs58';
import { verifyApproval, type Approval } from '../../../../packages/gate/src/approval.ts';
import { isSolanaAddress } from '../../../../packages/gate/src/ed25519.ts';
import { decodeEscrow, ixAssign, ixRelease, ixUnassign, MODE_DRAW, vaultPda } from '../../../../apps/agent/src/escrow-ix.ts';
import type { PayoutJournal } from './journal.ts';
import { capsFor, type FetchPull } from './payout-signer.ts';

export type EscrowState = ReturnType<typeof decodeEscrow>;

/** The chain, as far as the attestor needs it. A fake in tests; Solana in production. */
export interface EscrowChain {
  read(escrow: string): Promise<EscrowState | null>;
  /** Sign with the attestor and send. Resolves with the signature once confirmed. */
  send(ixs: TransactionInstruction[]): Promise<string>;
}

export interface EscrowAttestorConfig {
  /** The network escrows live on. An approval for another network is refused. */
  network: string;
  /** This attestor's public key: every escrow it acts on must name it. */
  attestor: string;
  /**
   * The same coarse allowlist payouts use, applied to releases too. Funded
   * bounties live on maintainers' own repositories, so each one has to be
   * added here by hand before its first release - deliberately, for now.
   */
  allowedRepos: string[];
  trustedApprovers: string[];
  caps: Record<string, { perBountyMaxMinor: bigint; dailyMaxMinor: bigint }>;
}

export type AttestOutcome = { ok: true; signature: string } | { ok: false; status: number; error: string };

export class EscrowAttestor {
  constructor(
    private readonly cfg: EscrowAttestorConfig,
    private readonly journal: PayoutJournal,
    private readonly chain: EscrowChain,
    private readonly fetchPull: FetchPull,
    private readonly now: () => Date = () => new Date(),
  ) {}

  address() {
    return this.cfg.attestor;
  }

  network() {
    return this.cfg.network;
  }

  private async drawEscrow(escrow: string, want: 'Funded' | 'Assigned'): Promise<EscrowState | AttestOutcome> {
    if (!isSolanaAddress(escrow)) return { ok: false, status: 400, error: 'escrow is not an address' };
    const e = await this.chain.read(escrow);
    if (!e) return { ok: false, status: 404, error: 'no such escrow on-chain' };
    if (e.attestor.toBase58() !== this.cfg.attestor) return { ok: false, status: 403, error: 'this escrow names a different attestor' };
    // The program refuses this too; refusing first saves a failed transaction
    // and says plainly why.
    if (e.mode !== MODE_DRAW) return { ok: false, status: 403, error: 'self-assign escrow: only the funder assigns and unassigns' };
    if (e.state !== want) return { ok: false, status: 409, error: `escrow is ${e.state}, not ${want}` };
    return e;
  }

  async assign(escrow: string, contributor: string): Promise<AttestOutcome> {
    if (!isSolanaAddress(contributor)) return { ok: false, status: 400, error: 'contributor is not an address' };
    const e = await this.drawEscrow(escrow, 'Funded');
    if ('ok' in e) return e;
    const signature = await this.chain.send([ixAssign({ signer: new PublicKey(this.cfg.attestor), escrow: new PublicKey(escrow), contributor: new PublicKey(contributor) })]);
    return { ok: true, signature };
  }

  async unassign(escrow: string): Promise<AttestOutcome> {
    const e = await this.drawEscrow(escrow, 'Assigned');
    if ('ok' in e) return e;
    const signature = await this.chain.send([ixUnassign({ signer: new PublicKey(this.cfg.attestor), escrow: new PublicKey(escrow) })]);
    return { ok: true, signature };
  }

  /**
   * Release an escrow to the contributor it records, on a human approval.
   *
   * The same re-checks a payout gets - approver, repo allowlist, caps, the
   * merge straight from GitHub, paid-once - and then the escrow itself, read
   * from the chain: it must name this attestor, hold exactly the approved
   * amount of the approved mint for the approved bounty, and be assigned to
   * the approved recipient. Any difference is a refusal, not a correction.
   */
  async release(approval: Approval): Promise<AttestOutcome> {
    const refuse = (error: string, status = 403): AttestOutcome => ({ ok: false, status, error });
    const t = approval?.terms;
    if (!t) return refuse('missing approval terms', 400);
    if (typeof t.escrow !== 'string' || !isSolanaAddress(t.escrow)) return refuse('this approval is not for an escrow release', 400);
    const now = this.now();
    const v = verifyApproval(approval, this.cfg.trustedApprovers, now);
    if (!v.ok) return refuse(`approval: ${v.reason}`);
    if (t.network !== this.cfg.network) return refuse(`network ${t.network} is not this attestor's network (${this.cfg.network})`);
    if (!this.cfg.allowedRepos.includes(t.repo)) return refuse(`repo ${t.repo} is not on the signer's allowlist`);
    if (!isSolanaAddress(t.recipient)) return refuse('recipient is not a Solana address', 400);

    let amount: bigint;
    try { amount = BigInt(t.amount_minor); } catch { return refuse('amount is not an integer', 400); }
    const caps = capsFor(t.currency, this.cfg.caps[t.currency]);
    if (!caps) return refuse(`no caps for ${t.currency}`);
    if (amount <= 0n || amount > caps.perBountyMaxMinor) return refuse(`amount ${amount} outside (0, ${caps.perBountyMaxMinor}]`);

    let pr: Awaited<ReturnType<FetchPull>>;
    try { pr = await this.fetchPull(t.repo, t.pr_number); } catch (e) {
      return refuse(`could not verify the PR on GitHub, refusing: ${String(e)}`, 503);
    }
    if (!pr.merged) return refuse(`${t.repo}#${t.pr_number} is not merged`);
    if (pr.authorLogin.toLowerCase() !== t.author_login.toLowerCase()) return refuse(`PR author is ${pr.authorLogin}, not ${t.author_login}`);
    if (!pr.mergedByLogin || pr.mergedByLogin.toLowerCase() === pr.authorLogin.toLowerCase()) return refuse('PR was self-merged or merged_by is unknown');
    if (!pr.mergeCommitSha || !/^[0-9a-f]{40}$/.test(pr.mergeCommitSha)) return refuse('GitHub did not report a merge commit', 503);

    const e = await this.chain.read(t.escrow);
    if (!e) return refuse('the escrow is not on-chain (already released or refunded?)', 409);
    if (e.attestor.toBase58() !== this.cfg.attestor) return refuse('this escrow names a different attestor');
    if (e.state !== 'Assigned') return refuse(`escrow is ${e.state}, not Assigned`, 409);
    if (e.contributor?.toBase58() !== t.recipient) return refuse(`escrow is assigned to ${e.contributor?.toBase58() ?? 'nobody'}, not ${t.recipient}`);
    if (e.mint.toBase58() !== t.mint) return refuse(`escrow holds ${e.mint.toBase58()}, not ${t.mint}`);
    if (e.amount !== amount) return refuse(`escrow holds ${e.amount}, approval says ${amount}`);
    if (Buffer.from(e.bountyId).toString('hex') !== t.bounty_id.replace(/-/g, '')) return refuse('escrow belongs to a different bounty');

    // Test tokens on devnet are not money and do not share a day's cap with
    // real payouts; the journal keeps them apart by network.
    const ledgerCurrency = this.cfg.network === 'solana-mainnet' ? t.currency : `${t.currency}@${this.cfg.network}`;
    const res = this.journal.reserve({
      payoutId: t.payout_id, bountyId: t.bounty_id, approvalSignature: approval.signature, recipient: t.recipient,
      currency: ledgerCurrency, amountMinor: amount, day: now.toISOString().slice(0, 10), dailyMaxMinor: caps.dailyMaxMinor,
    });
    if (!res.ok) {
      if (res.existing?.status === 'confirmed' && res.existing.payout_id === t.payout_id && res.existing.tx_signature) {
        return { ok: true, signature: res.existing.tx_signature };
      }
      return refuse(res.reason, res.existing ? 409 : 403);
    }

    const attestor = new PublicKey(this.cfg.attestor);
    const escrow = new PublicKey(t.escrow);
    const [vault] = vaultPda(escrow);
    const contributor = new PublicKey(t.recipient);
    const contributorToken = getAssociatedTokenAddressSync(e.mint, contributor, true);
    const feeToken = getAssociatedTokenAddressSync(e.mint, e.feeDestination, true);
    let signature: string;
    try {
      signature = await this.chain.send([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 120_000 }),
        // Either account may not exist yet; creating it is a no-op if it does.
        createAssociatedTokenAccountIdempotentInstruction(attestor, contributorToken, contributor, e.mint),
        createAssociatedTokenAccountIdempotentInstruction(attestor, feeToken, e.feeDestination, e.mint),
        ixRelease({
          attestor, funder: e.funder, escrow, vault, contributorToken, feeToken, mint: e.mint,
          mergeCommit: Buffer.from(pr.mergeCommitSha, 'hex'),
        }),
      ]);
    } catch (err) {
      this.journal.noteError(res.id, String(err));
      return refuse(`release outcome unknown: ${String(err)}`, 502);
    }
    this.journal.mark(res.id, 'sent', { tx_signature: signature });
    this.journal.mark(res.id, 'confirmed');
    return { ok: true, signature };
  }
}

/** Solana, signing with the attestor key. */
export class SolanaEscrowChain implements EscrowChain {
  private readonly kp: Keypair;
  private readonly conn: Connection;
  constructor(secret64: Uint8Array, rpcUrl: string) {
    this.kp = Keypair.fromSecretKey(secret64);
    this.conn = new Connection(rpcUrl, 'confirmed');
  }
  address() {
    return this.kp.publicKey.toBase58();
  }
  async read(escrow: string) {
    const info = await this.conn.getAccountInfo(new PublicKey(escrow), 'confirmed');
    return info ? decodeEscrow(Buffer.from(info.data)) : null;
  }
  async send(ixs: TransactionInstruction[]) {
    const { blockhash, lastValidBlockHeight } = await this.conn.getLatestBlockhash('confirmed');
    const tx = new Transaction({ feePayer: this.kp.publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
    tx.sign(this.kp);
    const signature = bs58.encode(tx.signature!);
    await this.conn.sendRawTransaction(tx.serialize(), { preflightCommitment: 'confirmed', maxRetries: 5 });
    const conf = await this.conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
    if (conf.value.err) throw new Error(`${signature} failed on-chain: ${JSON.stringify(conf.value.err)}`);
    return signature;
  }
}
