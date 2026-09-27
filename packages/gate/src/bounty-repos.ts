// Which repositories may have bounties.
//
// Two conditions, and the rule is written once here so that "can this repo
// have a bounty" has one answer wherever it is asked - at creation, at the
// payout gate, and on the admin screen that shows the state.
//
//   1. It is a registered Grainlify project: verified, with our GitHub App
//      installed. Grainlify knows this; the agent is told it.
//   2. An admin has switched bounties on for it.
//
// Plus one carve-out, below.

/**
 * Repositories that may have bounties without being a registered project.
 *
 * Exactly one entry, and shaped like WAIVABLE_ELIGIBILITY_RULES for the same
 * reason: a carve-out that is a list of names in code cannot quietly become a
 * general "skip the check" switch, and adding to it is a visible change that
 * someone has to review. The sandbox exists to exercise the pipeline end to
 * end and will never be a verified project.
 */
export const BOUNTY_TEST_REPOS = ['grainlify/grainlify-agent-sandbox'] as const;

export function isTestCarveOut(fullName: string): boolean {
  return (BOUNTY_TEST_REPOS as readonly string[]).includes(fullName.toLowerCase());
}

export interface RepoBountyState {
  fullName: string;
  /** The GitHub App is installed and the repo is allowlisted with the agent. */
  enabled: boolean;
  bountiesEnabled: boolean;
  registeredProject: boolean;
}

export type RepoRefusal = 'repo_not_allowlisted' | 'bounties_not_enabled' | 'not_a_registered_project';

export interface RepoVerdict {
  ok: boolean;
  reason: RepoRefusal | null;
  detail: string;
}

/**
 * The single expression. Order is cheapest-to-explain first: an operator
 * reading a refusal should be told the thing they can act on.
 */
export function repoMayHaveBounties(r: RepoBountyState): RepoVerdict {
  if (!r.enabled) {
    return { ok: false, reason: 'repo_not_allowlisted', detail: `${r.fullName} is not allowlisted with the bounty agent` };
  }
  if (!r.bountiesEnabled) {
    return { ok: false, reason: 'bounties_not_enabled', detail: `bounties are switched off for ${r.fullName}` };
  }
  if (!r.registeredProject && !isTestCarveOut(r.fullName)) {
    return {
      ok: false,
      reason: 'not_a_registered_project',
      detail: `${r.fullName} is not a verified Grainlify project with the GitHub App installed`,
    };
  }
  return { ok: true, reason: null, detail: `${r.fullName} may have bounties` };
}
