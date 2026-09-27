import { describe, expect, it } from 'vitest';
import { evaluateGate, type GateFacts, type GatePolicy } from '../src/gate.ts';

const now = new Date('2026-09-20T12:00:00Z');
const policy: GatePolicy = {
  caps: { USDC: { perBountyMaxMinor: 50_000_000n, dailyMaxMinor: 150_000_000n } },
  minAccountAgeDays: 30,
  allowedNetworks: ['solana-devnet'],
};

function facts(over: Partial<{ [K in keyof GateFacts]: Partial<GateFacts[K]> | GateFacts[K] }> = {}): GateFacts {
  const base: GateFacts = {
    repo: { fullName: 'Grainlify/grainlify-agent-sandbox', allowlisted: true, enabled: true, bountiesEnabled: true, registeredProject: false },
    bounty: { id: 'b1', status: 'in_review', issueNumber: 3, amountMinor: 20_000_000n, currency: 'USDC', network: 'solana-devnet' },
    pr: { number: 7, merged: true, mergedByLogin: 'maintainer', mergedByPermission: 'admin', authorId: 42, authorLogin: 'contributor', authorType: 'User', closesIssues: [3] },
    author: { createdAt: new Date('2020-01-01T00:00:00Z') },
    wallet: { address: 'Wa11et1111111111111111111111111111111111111' },
    assignment: { githubUserId: 42, githubLogin: 'contributor' },
    bountyAlreadyHasPayout: false,
    paidTodayMinor: 0n,
  };
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(over)) {
    const cur = base[k as keyof GateFacts];
    out[k] = v !== null && typeof v === 'object' && !Array.isArray(v) && cur !== null && typeof cur === 'object' ? { ...cur, ...v } : v;
  }
  return out as unknown as GateFacts;
}

const failed = (f: GateFacts, p = policy) => evaluateGate(f, p, now).checks.filter((c) => !c.pass).map((c) => c.name);

describe('payout gate', () => {
  it('passes a merged, maintainer-merged PR from an established contributor with a linked wallet', () => {
    const r = evaluateGate(facts(), policy, now);
    expect(r.pass).toBe(true);
    expect(r.checks.length).toBeGreaterThanOrEqual(13);
  });

  it.each([
    ['repo not allowlisted', facts({ repo: { allowlisted: false } }), 'repo_allowlisted'],
    ['repo disabled', facts({ repo: { enabled: false } }), 'repo_allowlisted'],
    ['bounty already paid (status)', facts({ bounty: { status: 'paid' } }), 'bounty_open'],
    ['bounty cancelled', facts({ bounty: { status: 'cancelled' } }), 'bounty_open'],
    ['mainnet while only devnet is allowed', facts({ bounty: { network: 'solana-mainnet' } }), 'network_allowed'],
    ['PR not merged', facts({ pr: { merged: false } }), 'pr_merged'],
    ['PR does not close the bounty issue', facts({ pr: { closesIssues: [4] } }), 'pr_closes_bounty_issue'],
    ['merged by someone with triage only', facts({ pr: { mergedByPermission: 'triage' } }), 'merged_by_maintainer'],
    ['merger permission unknown', facts({ pr: { mergedByPermission: null } }), 'merged_by_maintainer'],
    ['self-merged', facts({ pr: { mergedByLogin: 'Contributor' } }), 'not_self_merged'],
    ['merged_by unknown', facts({ pr: { mergedByLogin: null } }), 'not_self_merged'],
    ['bot author', facts({ pr: { authorType: 'Bot' } }), 'author_not_bot'],
    ['[bot] login', facts({ pr: { authorLogin: 'renovate[bot]' } }), 'author_not_bot'],
    ['account too young', facts({ author: { createdAt: new Date('2026-09-01T00:00:00Z') } }), 'author_account_age'],
    ['author lookup failed', facts({ author: null }), 'author_account_age'],
    ['no linked wallet', facts({ wallet: null }), 'wallet_linked'],
    ['bounty already has a payout', facts({ bountyAlreadyHasPayout: true }), 'not_already_paid'],
    ['over the per-bounty cap', facts({ bounty: { amountMinor: 50_000_001n } }), 'within_per_bounty_cap'],
    ['over the daily cap', facts({ paidTodayMinor: 140_000_000n }), 'within_daily_cap'],
  ])('refuses: %s', (_name, f, expectedFailure) => {
    const r = evaluateGate(f, policy, now);
    expect(r.pass).toBe(false);
    expect(failed(f)).toContain(expectedFailure);
  });

  it('fails closed for a currency with no configured caps', () => {
    expect(failed(facts({ bounty: { currency: 'ANSEM' } }))).toEqual(['within_per_bounty_cap', 'within_daily_cap']);
  });

  it('reports every failing check, not just the first', () => {
    expect(failed(facts({ pr: { merged: false, mergedByLogin: 'contributor' }, wallet: null }))).toEqual(['pr_merged', 'not_self_merged', 'wallet_linked']);
  });

  it('allows exactly the per-bounty cap and exactly the remaining daily cap', () => {
    expect(evaluateGate(facts({ bounty: { amountMinor: 50_000_000n }, paidTodayMinor: 100_000_000n }), policy, now).pass).toBe(true);
  });
});

describe('only the contributor who won the draw can be paid', () => {
  // The whole point of drawing a winner before any code is written. Without
  // this, the draw picks somebody and the gate pays whoever merged first -
  // which is the behaviour the draw replaced, with extra steps.
  it('passes when the assignee opened the pull request', () => {
    expect(evaluateGate(facts(), policy, now).checks.find((c) => c.name === 'assigned_to_author')).toMatchObject({ pass: true });
  });

  it('fails when somebody else opened it, however good the pull request is', () => {
    const r = evaluateGate(facts({ assignment: { githubUserId: 99, githubLogin: 'someone-else' } }), policy, now);
    expect(r.pass).toBe(false);
    const c = r.checks.find((x) => x.name === 'assigned_to_author')!;
    expect(c.pass).toBe(false);
    expect(c.detail).toContain('someone-else');
    expect(c.detail).toContain('contributor');
  });

  it('fails when nobody holds the bounty at all', () => {
    // An unassigned bounty is one nobody was drawn for. Paying it would make
    // the draw decorative.
    const r = evaluateGate(facts({ assignment: null }), policy, now);
    expect(r.pass).toBe(false);
    expect(r.checks.find((c) => c.name === 'assigned_to_author')).toMatchObject({ pass: false });
  });

  it('matches on the GitHub id, not the login', () => {
    // Logins are renameable. Matching on them hands the bounty to anyone who
    // can rename themselves to the winner's handle.
    const renamed = facts({ assignment: { githubUserId: 42, githubLogin: 'old-name' } });
    expect(evaluateGate(renamed, policy, now).checks.find((c) => c.name === 'assigned_to_author')).toMatchObject({ pass: true });

    const impostor = facts({ assignment: { githubUserId: 77, githubLogin: 'contributor' } });
    expect(evaluateGate(impostor, policy, now).checks.find((c) => c.name === 'assigned_to_author')).toMatchObject({ pass: false });
  });
});

describe('only a registered project, switched on, can pay a bounty', () => {
  // Checked here as well as when the bounty was created. A project can be
  // switched off, or lose its verification, in the weeks between a bounty
  // being posted and a pull request being merged - and this is the check that
  // runs at the moment money would actually move.
  it('passes for the sandbox, which is the one carve-out', () => {
    expect(evaluateGate(facts(), policy, now).checks.find((c) => c.name === 'repo_may_have_bounties')).toMatchObject({ pass: true });
  });

  it('passes for a verified project with bounties on', () => {
    const r = facts({ repo: { fullName: 'Grainlify/Grainlify-Backend', allowlisted: true, enabled: true, bountiesEnabled: true, registeredProject: true } });
    expect(evaluateGate(r, policy, now).checks.find((c) => c.name === 'repo_may_have_bounties')).toMatchObject({ pass: true });
  });

  it('refuses a repo somebody switched off after the bounty was posted', () => {
    const r = facts({ repo: { fullName: 'Grainlify/Grainlify-Backend', allowlisted: true, enabled: true, bountiesEnabled: false, registeredProject: true } });
    const c = evaluateGate(r, policy, now).checks.find((x) => x.name === 'repo_may_have_bounties')!;
    expect(c.pass).toBe(false);
    expect(c.detail).toContain('switched off');
  });

  it('refuses a repo that is not a registered project and not the sandbox', () => {
    const r = facts({ repo: { fullName: 'Someone/random-repo', allowlisted: true, enabled: true, bountiesEnabled: true, registeredProject: false } });
    const c = evaluateGate(r, policy, now).checks.find((x) => x.name === 'repo_may_have_bounties')!;
    expect(c.pass).toBe(false);
    expect(c.detail).toContain('verified Grainlify project');
  });

  it('fails the whole gate, not just the one check', () => {
    const r = facts({ repo: { fullName: 'Someone/random-repo', allowlisted: true, enabled: true, bountiesEnabled: true, registeredProject: false } });
    expect(evaluateGate(r, policy, now).pass).toBe(false);
  });
});
