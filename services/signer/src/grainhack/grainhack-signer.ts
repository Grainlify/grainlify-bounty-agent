// The grainhack-signer's decision logic (contract §2).
//
// It pays one GrainHack winner only with a valid human approval for exactly
// that payout, and even then it re-checks everything it can on its own: the
// backend's signature on the results statement, that the statement says this
// winner is payable for this amount, its own network and mint, its own caps
// and its own "paid once, ever" record. The agent's word is not enough, and
// a caller that skips the agent is refused here.
//
// Checks run in the contract's order and the first failure is the answer.

import { isSolanaAddress } from '../../../../packages/gate/src/ed25519.ts';
import { checkGrainhackTermsShape, verifyGrainhackApproval, type GrainhackApproval } from '../../../../packages/gate/src/grainhack-approval.ts';
import { lineFor, statementSha256, verifyStatement } from '../../../../packages/gate/src/grainhack-statement.ts';
import type { PayoutRail } from '../payout/rail.ts';
import { grainhackCapsFor, type GrainhackCaps } from './caps.ts';
import type { GrainhackJournal, GrainhackJournalRow } from './journal.ts';

export interface GrainhackSignerConfig {
  network: string;
  mints: Record<string, { mint: string; decimals: number }>;
  /** Lowering only; see caps.ts. */
  caps: Record<string, Partial<GrainhackCaps>>;
  trustedApprovers: string[];
  /** Base64 Ed25519 public key of the backend's results statements. */
  resultsPubkey: string;
}

export interface GrainhackPayRequest {
  approval: GrainhackApproval;
  statement: string;
  statement_signature: string;
}

export type GrainhackOutcome =
  | { ok: true; signature: string; payer: string }
  | { ok: false; status: number; error: string; unknown?: true; signature?: string; existing?: Pick<GrainhackJournalRow, 'payout_id' | 'status' | 'tx_signature'> };

export class GrainhackSigner {
  constructor(
    private readonly cfg: GrainhackSignerConfig,
    private readonly journal: GrainhackJournal,
    private readonly rail: PayoutRail,
    private readonly now: () => Date = () => new Date(),
  ) {}

  address() {
    return this.rail.address();
  }
  network() {
    return this.cfg.network;
  }
  mints() {
    return this.cfg.mints;
  }
  caps() {
    return Object.fromEntries(
      Object.keys(this.cfg.mints).map((c) => {
        const k = grainhackCapsFor(c, this.cfg.caps[c]);
        return [c, k ? { perPayoutMaxMinor: String(k.perPayoutMaxMinor), perEventMaxMinor: String(k.perEventMaxMinor), dailyMaxMinor: String(k.dailyMaxMinor) } : null];
      }),
    );
  }

  async pay(req: GrainhackPayRequest): Promise<GrainhackOutcome> {
    const refuse = (error: string, status = 403): GrainhackOutcome => ({ ok: false, status, error });
    const now = this.now();
    const approval = req?.approval;
    const t = approval?.terms;

    // 1. The approval: the right kind, from a trusted approver, unexpired, at most an hour long, and signed.
    const shape = checkGrainhackTermsShape(t);
    if (shape) return refuse(shape, 400);
    const v = verifyGrainhackApproval(approval, this.cfg.trustedApprovers, now);
    if (!v.ok) return refuse(`approval: ${v.reason}`);

    // 2. The statement: the backend signed it, and it is the one the approver approved.
    const s = verifyStatement(req.statement, req.statement_signature, this.cfg.resultsPubkey);
    if (!s.ok) return refuse(`statement: ${s.reason}`);
    if (statementSha256(req.statement) !== t.statement_sha256) return refuse('statement: sha256 does not match the approved statement_sha256');
    const st = s.statement;
    if (st.statement_id !== t.statement_id) return refuse(`statement: id ${st.statement_id} is not the approved ${t.statement_id}`);
    if (st.hackathon_id !== t.hackathon_id || st.pool !== t.pool) return refuse('statement: hackathon or pool differs from the approval');

    // 3. Network, currency and mint: this signer's, and the statement's.
    if (st.network !== this.cfg.network || t.network !== this.cfg.network) return refuse(`network: statement ${st.network}, approval ${t.network}, this signer ${this.cfg.network}`);
    if (st.currency !== t.currency) return refuse(`currency: statement ${st.currency}, approval ${t.currency}`);
    const mint = this.cfg.mints[t.currency];
    if (!mint || mint.mint !== t.mint) return refuse(`mint ${t.mint} is not the configured ${t.currency} mint`);

    // 4. The statement names this winner as payable, for this amount, under this login.
    const line = lineFor(st, t.github_user_id);
    if (!line) return refuse(`statement has no line for github_user_id ${t.github_user_id}`);
    if (line.status !== 'payable') return refuse(`github_user_id ${t.github_user_id} is ${line.status} on this statement, not payable`);
    if (line.amount_minor !== t.amount_minor) return refuse(`amount ${t.amount_minor} is not the statement's ${line.amount_minor}`);
    if (line.login !== t.login) return refuse(`login ${t.login} is not the statement's ${line.login}`);

    // 5. Somewhere real to send it, and not back to ourselves.
    if (!isSolanaAddress(t.recipient)) return refuse('recipient is not a Solana address', 400);
    if (t.recipient === this.address()) return refuse('recipient is the GrainHack float itself');

    // 6. Caps: per payout; per event (never more than the statement's pool); per UTC day.
    const amount = BigInt(t.amount_minor);
    const caps = grainhackCapsFor(t.currency, this.cfg.caps[t.currency]);
    if (!caps) return refuse(`no caps for ${t.currency}`);
    if (amount <= 0n || amount > caps.perPayoutMaxMinor) return refuse(`per-payout cap: amount ${amount} outside (0, ${caps.perPayoutMaxMinor}]`);
    const poolMinor = BigInt(st.pool_minor);
    const limits = { eventMaxMinor: poolMinor < caps.perEventMaxMinor ? poolMinor : caps.perEventMaxMinor, dailyMaxMinor: caps.dailyMaxMinor };
    const r = {
      payoutId: t.payout_id, approvalSignature: approval.signature, approver: approval.approver, statementId: st.statement_id, statementSha256: t.statement_sha256,
      hackathonId: t.hackathon_id, pool: t.pool, githubUserId: t.github_user_id, login: t.login, recipient: t.recipient, currency: t.currency,
      network: this.cfg.network, mint: mint.mint, amountMinor: amount, day: now.toISOString().slice(0, 10),
    };

    // An exact replay of an approval that already paid is answered with the
    // payment it made, not refused and not paid twice.
    const replay = this.journal.byPayoutId(t.payout_id);
    if (replay && replay.approval_signature === approval.signature && replay.status === 'confirmed') return { ok: true, signature: replay.tx_signature, payer: this.address() };

    // 6 and 7 against the journal before building anything; reserve() repeats them atomically.
    const pre = this.journal.check(r, limits);
    if (pre) return this.refusedByJournal(pre);

    // Built and signed before the row exists, so the row is born with its
    // transaction signature. A build failure leaves no row: nothing was sent
    // and nothing can be sent, and the winner is not blocked by it.
    let prepared: Awaited<ReturnType<PayoutRail['prepareTransfer']>>;
    try {
      prepared = await this.rail.prepareTransfer({ mint: mint.mint, decimals: mint.decimals, to: t.recipient, amountMinor: amount });
    } catch (e) {
      return refuse(`could not build the transfer, nothing sent: ${String(e)}`, 422);
    }
    const res = this.journal.reserve({ ...r, txSignature: prepared.signature, lastValidBlockHeight: prepared.lastValidBlockHeight ?? null }, limits);
    if (!res.ok) return this.refusedByJournal(res);

    this.journal.mark(res.id, 'sent');
    try {
      await prepared.broadcast();
    } catch (e) {
      // Never retried here. A person resolves it from the chain (resolve.ts).
      this.journal.mark(res.id, 'unknown', String(e));
      return { ok: false, status: 502, unknown: true, signature: prepared.signature, error: `outcome unknown for ${prepared.signature}; a person must resolve it: ${String(e)}` };
    }
    this.journal.mark(res.id, 'confirmed');
    return { ok: true, signature: prepared.signature, payer: this.address() };
  }

  private refusedByJournal(r: { status: number; reason: string; existing?: GrainhackJournalRow }): GrainhackOutcome {
    return {
      ok: false, status: r.status, error: r.reason,
      ...(r.existing ? { existing: { payout_id: r.existing.payout_id, status: r.existing.status, tx_signature: r.existing.tx_signature } } : {}),
    };
  }
}
