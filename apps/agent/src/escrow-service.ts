// Maintainer-funded bounties: preparing, confirming and recording escrows.
//
// # The one rule this file exists to keep
//
// Grainlify never holds a funder's key and never sends their money. Funding is
// a transaction the FUNDER signs in their own wallet; this service only builds
// the unsigned bytes and, afterwards, reads the chain to see what actually
// happened. Nothing here can move funds, and `confirmFunding` believes the
// chain rather than the caller - a client that reports a funding that did not
// occur gets a refusal, not a row.
import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  MODE_DRAW, MODE_SELF, decodeEscrow, escrowPda, vaultPda, ixInitialize, ixAssign, ixUnassign, ixCancel, ixRefund,
} from './escrow-ix.ts';
import { intOf, boolOf } from '../../../packages/gate/src/draw-config.ts';

export type AssignmentMode = 'draw' | 'self_assign';

export interface EscrowDeps {
  db: pg.Pool;
  connection: Connection;
  /** The key that attests a merge and names a draw winner. Never the funder's. */
  attestor: PublicKey;
  /** Where the platform fee lands. Fixed on each escrow at funding. */
  feeDestination: PublicKey;
  /**
   * Which chain escrows live on, and what they may hold. Separate from where
   * the agent's own payouts go, so escrows can be run on devnet with test
   * tokens while real payouts stay on mainnet.
   */
  network?: string;
  mints?: Record<string, { mint: string; decimals: number }>;
  /**
   * GitHub logins that can use funded bounties while the switch is off.
   * From the environment, not the settings table: widening who can put money
   * into escrows is not something the admin screen should be able to do.
   */
  testers?: string[];
  now?: () => Date;
}

export type ChainEscrow = ReturnType<typeof decodeEscrow>;

export interface Quote {
  amountMinor: bigint;
  feeBps: number;
  feeMinimumMinor: bigint;
  feeAmountMinor: bigint;
  totalMinor: bigint;
  /** What the fee works out at for this size, so a floored fee is visible. */
  effectiveRate: number;
  flooredByMinimum: boolean;
}

/**
 * What the funder pays, from the amount the contributor is to receive.
 *
 * The fee is charged ON TOP, so the contributor receives exactly the figure the
 * bounty advertises, and the floor applies underneath the percentage. This
 * mirrors the program's own arithmetic deliberately: the screen must quote what
 * the chain will charge, not an approximation of it.
 */
export function quote(amountMinor: bigint, feeBps: number, feeMinimumMinor: bigint): Quote {
  if (amountMinor <= 0n) throw new Error('amount must be greater than zero');
  const pct = (amountMinor * BigInt(feeBps) + 9_999n) / 10_000n;   // rounds up, as the program does
  const feeAmountMinor = pct > feeMinimumMinor ? pct : feeMinimumMinor;
  return {
    amountMinor,
    feeBps,
    feeMinimumMinor,
    feeAmountMinor,
    totalMinor: amountMinor + feeAmountMinor,
    effectiveRate: Number(feeAmountMinor) / Number(amountMinor),
    flooredByMinimum: feeAmountMinor > pct,
  };
}

export class EscrowService {
  private readonly now: () => Date;
  constructor(private readonly d: EscrowDeps) {
    this.now = d.now ?? (() => new Date());
  }

  private async config(): Promise<Record<string, string>> {
    const r = await this.d.db.query<{ key: string; value: string }>('SELECT key, value FROM bounty_config');
    return Object.fromEntries(r.rows.map((x) => [x.key, x.value]));
  }

  /** The switch. Off means this feature is not merely hidden but absent. */
  async enabled(): Promise<boolean> {
    return boolOf((await this.config()).funded_bounties_enabled, false);
  }

  /** On for everyone, or on for this person because they are testing it. */
  async enabledFor(login: string): Promise<boolean> {
    if (await this.enabled()) return true;
    return (this.d.testers ?? []).some((t) => t.toLowerCase() === login.toLowerCase());
  }

  network(): string {
    return this.d.network ?? 'solana-devnet';
  }

  mints(): Record<string, { mint: string; decimals: number }> {
    return this.d.mints ?? {};
  }

  attestor(): string {
    return this.d.attestor.toBase58();
  }

  /** The escrow as the chain holds it now, or null once it is closed (released or refunded) or never existed. */
  async readChain(escrowPubkey: string): Promise<ChainEscrow | null> {
    const info = await this.d.connection.getAccountInfo(new PublicKey(escrowPubkey), 'confirmed');
    return info ? decodeEscrow(Buffer.from(info.data)) : null;
  }

  /**
   * Unsigned transactions for the funder's own wallet, in self-assign mode.
   * The program refuses these from anybody but the funder, so building them
   * for anybody else would only produce a transaction that fails.
   */
  async funderAssignTransaction(escrowPubkey: string, funderWallet: string, contributorWallet: string) {
    const funder = new PublicKey(funderWallet);
    const tx = new Transaction().add(ixAssign({ signer: funder, escrow: new PublicKey(escrowPubkey), contributor: new PublicKey(contributorWallet) }));
    return this.unsigned(tx, funder);
  }

  async funderUnassignTransaction(escrowPubkey: string, funderWallet: string) {
    const funder = new PublicKey(funderWallet);
    const tx = new Transaction().add(ixUnassign({ signer: funder, escrow: new PublicKey(escrowPubkey) }));
    return this.unsigned(tx, funder);
  }

  /**
   * Taking the money back, which only the funder can do and the program
   * decides when: cancel before anybody was ever assigned, refund once the
   * deadline has passed. Grainlify builds the bytes and signs nothing.
   */
  async funderReclaimTransaction(escrowPubkey: string, kind: 'cancel' | 'refund') {
    const e = await this.readChain(escrowPubkey);
    if (!e) throw new Error('the escrow is not on-chain');
    const escrow = new PublicKey(escrowPubkey);
    const [vault] = vaultPda(escrow);
    const funderToken = await getAssociatedTokenAddress(e.mint, e.funder);
    const ix = (kind === 'cancel' ? ixCancel : ixRefund)({ funder: e.funder, escrow, vault, funderToken, mint: e.mint });
    return this.unsigned(new Transaction().add(ix), e.funder);
  }

  private async unsigned(tx: Transaction, feePayer: PublicKey) {
    tx.feePayer = feePayer;
    tx.recentBlockhash = (await this.d.connection.getLatestBlockhash('confirmed')).blockhash;
    return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
  }

  /** Record what the chain now says about who is assigned. Never called on a caller's word alone. */
  async recordAssigned(bountyId: string, contributorWallet: string, tx: string | null) {
    const r = await this.d.db.query<{ id: string }>(
      `UPDATE bounty_escrows SET state = 'assigned', contributor_wallet = $2, assign_tx = $3, updated_at = now()
        WHERE bounty_id = $1 RETURNING id`, [bountyId, contributorWallet, tx]);
    if (r.rows[0]) await this.event(r.rows[0].id, 'assigned', tx, { contributor: contributorWallet });
  }

  async recordUnassigned(bountyId: string, tx: string | null, detail: Record<string, unknown> = {}) {
    const r = await this.d.db.query<{ id: string }>(
      `UPDATE bounty_escrows SET state = 'funded', contributor_wallet = NULL, updated_at = now()
        WHERE bounty_id = $1 RETURNING id`, [bountyId]);
    if (r.rows[0]) await this.event(r.rows[0].id, 'unassigned', tx, detail);
  }

  async recordClosed(bountyId: string, state: 'refunded', detail: Record<string, unknown> = {}) {
    const r = await this.d.db.query<{ id: string }>(
      `UPDATE bounty_escrows SET state = $2, updated_at = now() WHERE bounty_id = $1 RETURNING id`, [bountyId, state]);
    if (r.rows[0]) await this.event(r.rows[0].id, state, null, detail);
  }

  async quoteFor(amountMinor: bigint): Promise<Quote> {
    const cfg = await this.config();
    return quote(
      amountMinor,
      intOf(cfg.funded_bounty_fee_bps, 250),
      BigInt(intOf(cfg.funded_bounty_fee_minimum_minor, 250_000)),
    );
  }

  /**
   * The unsigned funding transaction, for the funder's wallet to sign.
   *
   * Returned as bytes rather than sent: this service has no key that could sign
   * it and should never acquire one.
   */
  async prepareFunding(input: {
    bountyId: string;
    funderWallet: string;
    mint: string;
    currency: string;
    network: string;
    amountMinor: bigint;
    deadline: Date;
    mode: AssignmentMode;
    createdBy: string;
  }) {
    if (!(await this.enabledFor(input.createdBy))) {
      return { ok: false as const, error: 'funded_bounties_disabled' };
    }
    const existing = await this.d.db.query<{ id: string; state: string; escrow_pubkey: string }>(
      'SELECT id, state, escrow_pubkey FROM bounty_escrows WHERE bounty_id = $1', [input.bountyId]);
    if (existing.rows[0]) {
      // A funding that was prepared and never signed can be prepared again,
      // with new terms. One that reached the chain cannot: that money is
      // locked under these terms, and only confirming it makes sense.
      const e = existing.rows[0];
      if (e.state !== 'funding' || (await this.readChain(e.escrow_pubkey))) {
        return { ok: false as const, error: 'escrow_exists', detail: `this bounty already has an escrow in state ${e.state}` };
      }
      await this.d.db.query('DELETE FROM bounty_escrows WHERE id = $1', [e.id]);
    }
    if (input.deadline <= this.now()) {
      return { ok: false as const, error: 'deadline_in_past' };
    }

    const q = await this.quoteFor(input.amountMinor);
    const bountyIdBytes = Buffer.from(input.bountyId.replace(/-/g, ''), 'hex');
    if (bountyIdBytes.length !== 16) return { ok: false as const, error: 'bad_bounty_id' };

    const funder = new PublicKey(input.funderWallet);
    const mint = new PublicKey(input.mint);
    const [escrow] = escrowPda(bountyIdBytes);
    const [vault] = vaultPda(escrow);
    const funderToken = await getAssociatedTokenAddress(mint, funder);

    const tx = new Transaction().add(ixInitialize({
      funder, escrow, vault, funderToken, mint,
      feeDestination: this.d.feeDestination,
      attestor: this.d.attestor,
      bountyId: bountyIdBytes,
      amount: q.amountMinor,
      feeBps: q.feeBps,
      feeMinimum: q.feeMinimumMinor,
      deadline: Math.floor(input.deadline.getTime() / 1000),
      mode: input.mode === 'draw' ? MODE_DRAW : MODE_SELF,
    }));
    tx.feePayer = funder;
    tx.recentBlockhash = (await this.d.connection.getLatestBlockhash('confirmed')).blockhash;

    await this.d.db.query(
      `INSERT INTO bounty_escrows
         (id, bounty_id, escrow_pubkey, vault_pubkey, funder_wallet, mint, currency, network,
          amount_minor, fee_bps, fee_minimum_minor, fee_amount_minor, assignment_mode, state,
          deadline_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'funding',$14,$15)`,
      [randomUUID(), input.bountyId, escrow.toBase58(), vault.toBase58(), input.funderWallet,
       input.mint, input.currency, input.network, q.amountMinor.toString(), q.feeBps,
       q.feeMinimumMinor.toString(), q.feeAmountMinor.toString(), input.mode, input.deadline,
       input.createdBy],
    );

    return {
      ok: true as const,
      escrow: escrow.toBase58(),
      vault: vault.toBase58(),
      quote: q,
      transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
    };
  }

  /**
   * Believe the chain, not the caller.
   *
   * A client says "I funded it, here is my signature". Rather than trusting
   * that, this reads the escrow account and checks that what it holds matches
   * what was quoted. A funding that did not happen, or happened on different
   * terms, leaves the row in `funding` and returns a refusal.
   */
  async confirmFunding(bountyId: string, signature: string | null) {
    const row = await this.d.db.query<{
      id: string; escrow_pubkey: string; amount_minor: string; fee_amount_minor: string; state: string;
    }>('SELECT id, escrow_pubkey, amount_minor, fee_amount_minor, state FROM bounty_escrows WHERE bounty_id = $1', [bountyId]);
    const e = row.rows[0];
    if (!e) return { ok: false as const, error: 'no_escrow' };
    if (e.state !== 'funding') return { ok: false as const, error: 'not_awaiting_funding', detail: `state is ${e.state}` };

    const info = await this.d.connection.getAccountInfo(new PublicKey(e.escrow_pubkey), 'confirmed');
    if (!info) return { ok: false as const, error: 'escrow_not_on_chain' };

    const onChain = decodeEscrow(Buffer.from(info.data));
    if (onChain.amount.toString() !== e.amount_minor || onChain.feeAmount.toString() !== e.fee_amount_minor) {
      // Recorded rather than swallowed: a mismatch means the signed transaction
      // was not the one quoted, and somebody needs to look at it.
      await this.d.db.query('UPDATE bounty_escrows SET state = $2, last_error = $3, updated_at = now() WHERE id = $1',
        [e.id, 'failed', `on-chain terms differ from the quote: amount ${onChain.amount} fee ${onChain.feeAmount}`]);
      return { ok: false as const, error: 'terms_mismatch' };
    }

    await this.d.db.query(
      'UPDATE bounty_escrows SET state = $2, fund_tx = $3, updated_at = now() WHERE id = $1',
      [e.id, 'funded', signature],
    );
    await this.event(e.id, 'funded', signature, { amount: onChain.amount.toString(), fee: onChain.feeAmount.toString() });
    return { ok: true as const, escrow: e.escrow_pubkey, state: 'funded' as const };
  }

  /** The instruction that names the draw winner, for the attestor to sign. */
  assignInstruction(escrowPubkey: string, contributorWallet: string) {
    return ixAssign({
      signer: this.d.attestor,
      escrow: new PublicKey(escrowPubkey),
      contributor: new PublicKey(contributorWallet),
    });
  }

  /** Putting an assignment back: a lapsed deadline, or a rejected pull request. */
  unassignInstruction(escrowPubkey: string) {
    return ixUnassign({ signer: this.d.attestor, escrow: new PublicKey(escrowPubkey) });
  }

  private async event(escrowId: string, kind: string, tx: string | null, detail: Record<string, unknown> = {}) {
    await this.d.db.query(
      'INSERT INTO bounty_escrow_events (escrow_id, kind, tx, detail) VALUES ($1,$2,$3,$4)',
      [escrowId, kind, tx, JSON.stringify(detail)],
    );
  }

  /** Every escrow and its state, for the admin screen. */
  async all() {
    const r = await this.d.db.query(`
      SELECT e.*, b.issue_number, r.owner || '/' || r.name AS repo
        FROM bounty_escrows e
        JOIN bounties b ON b.id = e.bounty_id
        JOIN repos r ON r.id = b.repo_id
       ORDER BY e.created_at DESC`);
    return r.rows;
  }

  /** One escrow with its whole history, for the page that explains it. */
  async detail(bountyId: string) {
    const r = await this.d.db.query('SELECT * FROM bounty_escrows WHERE bounty_id = $1', [bountyId]);
    const e = r.rows[0];
    if (!e) return null;
    const ev = await this.d.db.query(
      'SELECT kind, tx, detail, created_at FROM bounty_escrow_events WHERE escrow_id = $1 ORDER BY created_at', [e.id]);
    return { ...e, events: ev.rows };
  }
}
