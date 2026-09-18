// The payout signer's decision logic.
//
// It pays a bounty only with a valid human approval, and even then it re-checks
// what it can on its own: its own repo allowlist, network, mint, caps, its own
// "paid once" record, and the merge itself straight from GitHub's public API.
// A caller that skips the agent's gate gets refused here.

import { verifyApproval, type Approval } from '../../../../packages/gate/src/approval.ts';
import { isSolanaAddress } from '../../../../packages/gate/src/ed25519.ts';
import type { PayoutJournal } from './journal.ts';
import type { PayoutRail } from './rail.ts';

/** Hard ceilings for the hackathon. Config can lower them, never raise them. */
export const HARD_CAPS: Record<string, { perBountyMaxMinor: bigint; dailyMaxMinor: bigint }> = {
  USDC: { perBountyMaxMinor: 50_000_000n, dailyMaxMinor: 150_000_000n },
};

export interface PayoutSignerConfig {
  network: string;
  mints: Record<string, { mint: string; decimals: number }>;
  caps: Record<string, { perBountyMaxMinor: bigint; dailyMaxMinor: bigint }>;
  allowedRepos: string[];
  trustedApprovers: string[];
}

export interface PullFacts {
  merged: boolean;
  authorLogin: string;
  mergedByLogin: string | null;
}

export type FetchPull = (repo: string, prNumber: number) => Promise<PullFacts>;

export type PayoutOutcome =
  | { ok: true; signature: string; payer: string }
  | { ok: false; status: number; error: string };

export function capsFor(currency: string, configured?: { perBountyMaxMinor: bigint; dailyMaxMinor: bigint }) {
  const hard = HARD_CAPS[currency];
  if (!hard) return null;
  if (!configured) return hard;
  return {
    perBountyMaxMinor: configured.perBountyMaxMinor < hard.perBountyMaxMinor ? configured.perBountyMaxMinor : hard.perBountyMaxMinor,
    dailyMaxMinor: configured.dailyMaxMinor < hard.dailyMaxMinor ? configured.dailyMaxMinor : hard.dailyMaxMinor,
  };
}

/** GitHub's public REST API; works unauthenticated for public repositories. */
export const fetchPullFromGitHub: FetchPull = async (repo, prNumber) => {
  const r = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'grainlify-payout-signer' } });
  if (!r.ok) throw new Error(`GitHub ${r.status} reading ${repo}#${prNumber}`);
  const pr = (await r.json()) as { merged: boolean; user: { login: string }; merged_by: { login: string } | null };
  return { merged: pr.merged === true, authorLogin: pr.user.login, mergedByLogin: pr.merged_by?.login ?? null };
};

export class PayoutSigner {
  constructor(
    private readonly cfg: PayoutSignerConfig,
    private readonly journal: PayoutJournal,
    private readonly rail: PayoutRail,
    private readonly fetchPull: FetchPull = fetchPullFromGitHub,
    private readonly now: () => Date = () => new Date(),
  ) {}

  address() {
    return this.rail.address();
  }

  async pay(approval: Approval): Promise<PayoutOutcome> {
    const refuse = (error: string, status = 403): PayoutOutcome => ({ ok: false, status, error });
    const now = this.now();
    const t = approval?.terms;
    if (!t) return refuse('missing approval terms', 400);

    const v = verifyApproval(approval, this.cfg.trustedApprovers, now);
    if (!v.ok) return refuse(`approval: ${v.reason}`);
    if (t.network !== this.cfg.network) return refuse(`network ${t.network} is not this signer's network (${this.cfg.network})`);
    const mint = this.cfg.mints[t.currency];
    if (!mint || mint.mint !== t.mint) return refuse(`mint ${t.mint} is not the configured ${t.currency} mint`);
    if (!this.cfg.allowedRepos.includes(t.repo)) return refuse(`repo ${t.repo} is not on the signer's allowlist`);
    if (!isSolanaAddress(t.recipient)) return refuse('recipient is not a Solana address', 400);
    if (t.recipient === this.address()) return refuse('recipient is the payout wallet itself');

    let amount: bigint;
    try {
      amount = BigInt(t.amount_minor);
    } catch {
      return refuse('amount is not an integer', 400);
    }
    const caps = capsFor(t.currency, this.cfg.caps[t.currency]);
    if (!caps) return refuse(`no caps for ${t.currency}`);
    if (amount <= 0n || amount > caps.perBountyMaxMinor) return refuse(`amount ${amount} outside (0, ${caps.perBountyMaxMinor}]`);

    // Re-check the merge ourselves; the agent's word is not enough.
    let pr: PullFacts;
    try {
      pr = await this.fetchPull(t.repo, t.pr_number);
    } catch (e) {
      return refuse(`could not verify the PR on GitHub, refusing: ${String(e)}`, 503);
    }
    if (!pr.merged) return refuse(`${t.repo}#${t.pr_number} is not merged`);
    if (pr.authorLogin.toLowerCase() !== t.author_login.toLowerCase()) return refuse(`PR author is ${pr.authorLogin}, not ${t.author_login}`);
    if (!pr.mergedByLogin || pr.mergedByLogin.toLowerCase() === pr.authorLogin.toLowerCase()) return refuse('PR was self-merged or merged_by is unknown');

    const res = this.journal.reserve({
      payoutId: t.payout_id, bountyId: t.bounty_id, approvalSignature: approval.signature, recipient: t.recipient, currency: t.currency,
      amountMinor: amount, day: now.toISOString().slice(0, 10), dailyMaxMinor: caps.dailyMaxMinor,
    });
    if (!res.ok) {
      if (res.existing?.status === 'confirmed' && res.existing.payout_id === t.payout_id && res.existing.tx_signature) {
        return { ok: true, signature: res.existing.tx_signature, payer: this.address() };
      }
      return refuse(res.reason, res.existing ? 409 : 403);
    }

    let prepared: Awaited<ReturnType<PayoutRail['prepareTransfer']>>;
    try {
      prepared = await this.rail.prepareTransfer({ mint: mint.mint, decimals: mint.decimals, to: t.recipient, amountMinor: amount });
    } catch (e) {
      this.journal.mark(res.id, 'failed_unsent', { error: String(e) });
      return refuse(`could not build transfer: ${String(e)}`, 422);
    }
    this.journal.mark(res.id, 'sent', { tx_signature: prepared.signature });
    try {
      await prepared.broadcast();
      this.journal.mark(res.id, 'confirmed');
      return { ok: true, signature: prepared.signature, payer: this.address() };
    } catch (e) {
      this.journal.noteError(res.id, String(e));
      return refuse(`broadcast outcome unknown for ${prepared.signature}: ${String(e)}`, 502);
    }
  }
}
