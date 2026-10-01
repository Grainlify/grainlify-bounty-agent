// The payout gate. Deterministic code decides whether a merged PR earns its
// bounty; no model output is an input here, and nothing a contributor writes
// in an issue, PR or comment can change the result.
//
// Every check is evaluated and reported, even after one fails, so the gate
// result shown to the approver is complete. Missing or unreadable facts FAIL
// the check: "could not verify" is never treated as "fine".

import { repoMayHaveBounties } from './bounty-repos.ts';

export type RepoPermission = 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none';

export interface GateFacts {
  repo: { fullName: string; allowlisted: boolean; enabled: boolean; bountiesEnabled: boolean; registeredProject: boolean };
  bounty: { id: string; status: string; issueNumber: number; amountMinor: bigint; currency: string; network: string };
  /** Fetched fresh from GitHub at gate time, never taken from a webhook payload. */
  pr: {
    number: number;
    merged: boolean;
    mergedByLogin: string | null;
    mergedByPermission: RepoPermission | null;
    authorId: number;
    authorLogin: string;
    authorType: string;
    /** Issues this PR closes in the same repository (GitHub's closingIssuesReferences). */
    closesIssues: number[];
  };
  /** null when the lookup failed. */
  author: { createdAt: Date } | null;
  /** The author's live linked wallet, if any. */
  wallet: { address: string } | null;
  /**
   * The live assignment for this bounty, if the draw has made one.
   *
   * null means nobody holds it. That is NOT a pass: under the draw, a bounty
   * with no assignment is one nobody was chosen for, and paying a PR against
   * it would make the draw decorative.
   */
  assignment: { githubUserId: number; githubLogin: string } | null;
  /** A payout for this bounty already exists that is not 'refused'. */
  bountyAlreadyHasPayout: boolean;
  /** Sum of payouts (any status except refused/failed) created today, same currency, minor units. */
  paidTodayMinor: bigint;
  /**
   * Present only for a maintainer-funded bounty. The money is in an escrow the
   * funder locked, so the repository does not have to be one the agent posts
   * its own bounties on; what has to be true instead is that the escrow is
   * holding the funds for an assigned contributor. Read from the chain mirror,
   * and the payout signer reads the chain itself before it signs.
   */
  funded?: { escrowState: string; contributorWallet: string | null };
}

export interface GatePolicy {
  /** Per currency; a currency with no caps configured can never pass. */
  caps: Record<string, { perBountyMaxMinor: bigint; dailyMaxMinor: bigint }>;
  minAccountAgeDays: number;
  /** Networks payouts may use right now, e.g. ['solana-devnet'] during P2. */
  allowedNetworks: string[];
  /** Networks a funded bounty's escrow may be released on. Separate, so devnet escrows can be run while payouts are on mainnet. */
  fundedNetworks?: string[];
}

export interface GateCheck {
  name: string;
  pass: boolean;
  detail: string;
}

export interface GateResult {
  pass: boolean;
  checks: GateCheck[];
  evaluatedAt: string;
}

const MAINTAINER_PERMISSIONS: RepoPermission[] = ['admin', 'maintain', 'write'];

export function evaluateGate(f: GateFacts, p: GatePolicy, now: Date): GateResult {
  const checks: GateCheck[] = [];
  const check = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });

  check('repo_allowlisted', f.repo.allowlisted && f.repo.enabled, `${f.repo.fullName}: allowlisted=${f.repo.allowlisted}, enabled=${f.repo.enabled}`);
  if (f.funded) {
    // A funded bounty is paid from the funder's escrow, not from the agent's
    // float, so the question is not whether the agent posts bounties here but
    // whether the escrow is holding the money for somebody.
    const held = f.funded.escrowState === 'assigned' && f.funded.contributorWallet !== null;
    check('escrow_holds_funds', held, held
      ? `escrow is assigned to ${f.funded.contributorWallet}`
      : `escrow is ${f.funded.escrowState}${f.funded.contributorWallet ? '' : ' with no contributor recorded'}`);
  }
  // Checked again here, having already been checked when the bounty was
  // created. Deliberately not "already validated upstream": a project can be
  // switched off, or lose its verification, between a bounty being posted and
  // a pull request being merged weeks later - and this is the check that runs
  // at the moment money would actually move.
  if (!f.funded) {
    const repoVerdict = repoMayHaveBounties({
      fullName: f.repo.fullName,
      enabled: f.repo.allowlisted && f.repo.enabled,
      bountiesEnabled: f.repo.bountiesEnabled,
      registeredProject: f.repo.registeredProject,
    });
    check('repo_may_have_bounties', repoVerdict.ok, repoVerdict.detail);
  }
  check('bounty_open', f.bounty.status === 'posted' || f.bounty.status === 'in_review', `bounty status is ${f.bounty.status}`);
  const networks = f.funded ? (p.fundedNetworks ?? []) : p.allowedNetworks;
  check('network_allowed', networks.includes(f.bounty.network), `network ${f.bounty.network}; allowed: ${networks.join(', ') || 'none'}`);

  check('pr_merged', f.pr.merged === true, f.pr.merged ? `PR #${f.pr.number} is merged` : `PR #${f.pr.number} is not merged`);
  check('pr_closes_bounty_issue', f.pr.closesIssues.includes(f.bounty.issueNumber), `PR closes [${f.pr.closesIssues.join(', ')}]; bounty issue is #${f.bounty.issueNumber}`);

  const mergedBy = f.pr.mergedByLogin;
  check(
    'merged_by_maintainer',
    mergedBy !== null && f.pr.mergedByPermission !== null && MAINTAINER_PERMISSIONS.includes(f.pr.mergedByPermission),
    `merged by ${mergedBy ?? 'unknown'} with permission ${f.pr.mergedByPermission ?? 'unknown'}`,
  );
  check(
    'not_self_merged',
    mergedBy !== null && mergedBy.toLowerCase() !== f.pr.authorLogin.toLowerCase(),
    `author ${f.pr.authorLogin}, merged by ${mergedBy ?? 'unknown'}`,
  );

  // The check the draw exists for.
  //
  // Bounties are assigned by a weighted draw before any code is written. That
  // is worth nothing if a merged PR from anybody can still be paid: the first
  // programme ran on "whoever opens the first pull request wins" and produced
  // 23 pull requests from 11 people for 3 issues, all but 3 of them wasted by
  // design. Without this check the draw picks a winner and the gate ignores
  // it, which is the same outcome with extra steps.
  //
  // This is GrainHack's AI-specs.md §2.4 rule 5, "The PR author was the
  // Grainlify-assigned contributor for that issue", applied to bounties.
  //
  // Matched on the GitHub user id, never the login: logins are renameable and
  // an attacker who can rename is otherwise handed the bounty.
  if (f.assignment === null) {
    check('assigned_to_author', false, 'nobody holds this bounty; it must be won in the draw before a pull request can be paid');
  } else {
    check(
      'assigned_to_author',
      f.assignment.githubUserId === f.pr.authorId,
      f.assignment.githubUserId === f.pr.authorId
        ? `assigned to ${f.assignment.githubLogin}, who opened PR #${f.pr.number}`
        : `assigned to ${f.assignment.githubLogin} (id ${f.assignment.githubUserId}), but PR #${f.pr.number} was opened by ${f.pr.authorLogin} (id ${f.pr.authorId})`,
    );
  }

  check('author_not_bot', f.pr.authorType === 'User' && !f.pr.authorLogin.toLowerCase().endsWith('[bot]'), `author type ${f.pr.authorType}`);
  if (f.author === null) {
    check('author_account_age', false, 'could not read the author account; failing closed');
  } else {
    const ageDays = (now.getTime() - f.author.createdAt.getTime()) / 86_400_000;
    check('author_account_age', ageDays >= p.minAccountAgeDays, `account is ${Math.floor(ageDays)} days old; minimum ${p.minAccountAgeDays}`);
  }

  check('wallet_linked', f.wallet !== null, f.wallet ? `wallet ${f.wallet.address}` : 'author has no linked wallet');
  check('not_already_paid', !f.bountyAlreadyHasPayout, f.bountyAlreadyHasPayout ? 'this bounty already has a payout' : 'no existing payout');

  const caps = p.caps[f.bounty.currency];
  if (!caps) {
    check('within_per_bounty_cap', false, `no caps configured for ${f.bounty.currency}; failing closed`);
    check('within_daily_cap', false, `no caps configured for ${f.bounty.currency}; failing closed`);
  } else {
    const amount = f.bounty.amountMinor;
    check('within_per_bounty_cap', amount > 0n && amount <= caps.perBountyMaxMinor, `${amount} of max ${caps.perBountyMaxMinor}`);
    check('within_daily_cap', f.paidTodayMinor + amount <= caps.dailyMaxMinor, `${f.paidTodayMinor} paid today + ${amount} vs daily max ${caps.dailyMaxMinor}`);
  }

  return { pass: checks.every((c) => c.pass), checks, evaluatedAt: now.toISOString() };
}
