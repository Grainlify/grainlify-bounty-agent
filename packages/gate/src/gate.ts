// The payout gate. Deterministic code decides whether a merged PR earns its
// bounty; no model output is an input here, and nothing a contributor writes
// in an issue, PR or comment can change the result.
//
// Every check is evaluated and reported, even after one fails, so the gate
// result shown to the approver is complete. Missing or unreadable facts FAIL
// the check: "could not verify" is never treated as "fine".

export type RepoPermission = 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none';

export interface GateFacts {
  repo: { fullName: string; allowlisted: boolean; enabled: boolean };
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
  /** A payout for this bounty already exists that is not 'refused'. */
  bountyAlreadyHasPayout: boolean;
  /** Sum of payouts (any status except refused/failed) created today, same currency, minor units. */
  paidTodayMinor: bigint;
}

export interface GatePolicy {
  /** Per currency; a currency with no caps configured can never pass. */
  caps: Record<string, { perBountyMaxMinor: bigint; dailyMaxMinor: bigint }>;
  minAccountAgeDays: number;
  /** Networks payouts may use right now, e.g. ['solana-devnet'] during P2. */
  allowedNetworks: string[];
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
  check('bounty_open', f.bounty.status === 'posted' || f.bounty.status === 'in_review', `bounty status is ${f.bounty.status}`);
  check('network_allowed', p.allowedNetworks.includes(f.bounty.network), `network ${f.bounty.network}; allowed: ${p.allowedNetworks.join(', ') || 'none'}`);

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
