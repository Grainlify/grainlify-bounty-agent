import { describe, expect, it } from 'vitest';
import { BOUNTY_TEST_REPOS, isTestCarveOut, repoMayHaveBounties } from '../../../packages/gate/src/bounty-repos.ts';

const repo = (o: Partial<Parameters<typeof repoMayHaveBounties>[0]> = {}) =>
  repoMayHaveBounties({ fullName: 'Grainlify/Grainlify-Backend', enabled: true, bountiesEnabled: true, registeredProject: true, ...o });

describe('which repositories may have bounties', () => {
  it('allows a verified project with the App installed and bounties switched on', () => {
    expect(repo()).toMatchObject({ ok: true });
  });

  it('refuses a repo the agent does not have installed', () => {
    expect(repo({ enabled: false })).toMatchObject({ ok: false, reason: 'repo_not_allowlisted' });
  });

  it('refuses a verified project nobody has switched on', () => {
    expect(repo({ bountiesEnabled: false })).toMatchObject({ ok: false, reason: 'bounties_not_enabled' });
  });

  // The rule that stops somebody pointing the programme at a repository we do
  // not vouch for. Being switched on is not enough on its own.
  it('refuses a repo that is switched on but is not a registered project', () => {
    expect(repo({ registeredProject: false, fullName: 'Someone/else' })).toMatchObject({ ok: false, reason: 'not_a_registered_project' });
  });

  it('allows exactly one carve-out, the sandbox, and nothing that merely looks like it', () => {
    expect(repo({ registeredProject: false, fullName: 'Grainlify/grainlify-agent-sandbox' })).toMatchObject({ ok: true });
    expect(repo({ registeredProject: false, fullName: 'GRAINLIFY/GRAINLIFY-AGENT-SANDBOX' })).toMatchObject({ ok: true });
    for (const near of ['Grainlify/grainlify-agent-sandbox2', 'Evil/grainlify-agent-sandbox', 'grainlify-agent-sandbox']) {
      expect(repo({ registeredProject: false, fullName: near })).toMatchObject({ ok: false });
    }
  });

  it('keeps the carve-out to one entry, so it cannot drift into a general switch', () => {
    // Shaped like WAIVABLE_ELIGIBILITY_RULES: adding to it is a visible change
    // somebody has to review, not a config edit.
    expect(BOUNTY_TEST_REPOS).toHaveLength(1);
    expect(isTestCarveOut('grainlify/grainlify-agent-sandbox')).toBe(true);
  });

  it('gives an operator a reason they can act on, not just a refusal', () => {
    expect(repo({ bountiesEnabled: false }).detail).toContain('switched off');
    expect(repo({ registeredProject: false, fullName: 'Someone/else' }).detail).toContain('verified Grainlify project');
  });
});
