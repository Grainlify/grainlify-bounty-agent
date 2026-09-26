// Do the agent and the payout signer agree about what they are paying?
//
// This exists because the same mismatch has now bitten three times, and it is
// the most expensive kind: a bounty row stores its mint at creation and keeps
// it forever. By the time a payout fails, the unpayable rows already exist,
// and the only fix is to go back and reissue bounties people have already
// applied for. The failure also surfaces at the very last step of a long
// manual process - after a contributor has done the work and a maintainer has
// merged it - which is the worst possible moment to discover a typo in an
// environment variable.
//
// So it is checked once, at boot, against the service that will actually sign
// the transfer, rather than trusted because somebody set both variables on the
// same afternoon.

export interface MintMap {
  [currency: string]: { mint: string; decimals: number };
}

export interface MintCheckResult {
  ok: boolean;
  /** Empty when ok. One line per disagreement, written to be read in a log. */
  problems: string[];
  /** What the signer said, when we could reach it. */
  signer: { network: string; mints: MintMap } | null;
  /** True when the signer could not be reached at all, which is not a mismatch. */
  unreachable: boolean;
}

/**
 * Compares the agent's mints against the signer's.
 *
 * Direction matters: every currency the AGENT can create a bounty in must
 * exist on the signer with the same mint and decimals. The signer knowing
 * about a currency the agent does not is fine - it just means that currency
 * cannot be offered yet - so it is reported as a note, not a failure.
 */
export function compareMints(
  agent: { network: string; mints: MintMap },
  signer: { network: string; mints: MintMap },
): string[] {
  const problems: string[] = [];
  if (agent.network !== signer.network) {
    problems.push(`network: agent pays on ${agent.network}, signer pays on ${signer.network}`);
  }
  for (const [currency, a] of Object.entries(agent.mints)) {
    const s = signer.mints[currency];
    if (!s) {
      problems.push(`${currency}: the agent can create bounties in it, the signer has no mint for it`);
      continue;
    }
    if (a.mint !== s.mint) {
      problems.push(`${currency}: agent mint ${a.mint}, signer mint ${s.mint}`);
    }
    if (a.decimals !== s.decimals) {
      problems.push(`${currency}: agent decimals ${a.decimals}, signer decimals ${s.decimals}`);
    }
  }
  return problems;
}

export async function checkMintsAgainstSigner(
  agent: { network: string; mints: MintMap },
  signerUrl: string,
  token: string,
  f: typeof fetch = fetch,
): Promise<MintCheckResult> {
  let signer: { network: string; mints: MintMap };
  try {
    const r = await f(`${signerUrl.replace(/\/+$/, '')}/v1/config`, { headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) {
      // An older signer has no /v1/config. That is a deployment to finish, not
      // a mismatch, and it must not stop the agent serving.
      return { ok: true, problems: [], signer: null, unreachable: true };
    }
    signer = (await r.json()) as { network: string; mints: MintMap };
    if (!signer?.mints) return { ok: true, problems: [], signer: null, unreachable: true };
  } catch {
    return { ok: true, problems: [], signer: null, unreachable: true };
  }
  const problems = compareMints(agent, signer);
  return { ok: problems.length === 0, problems, signer, unreachable: false };
}

/**
 * Runs the check and decides what to do about it.
 *
 * Refusing to boot on a mismatch is the default, and it is the right default:
 * an agent that serves with the wrong mint spends the time before anyone
 * notices writing bounty rows that can never be paid. MINT_MISMATCH=warn
 * downgrades it to a loud log for the case where somebody is mid-migration and
 * needs the service up; there is no setting that makes it quiet.
 */
export async function assertMintsAgree(
  agent: { network: string; mints: MintMap },
  env: { PAYOUT_SIGNER_URL?: string; PAYOUT_SIGNER_TOKEN?: string; MINT_MISMATCH?: string },
  log: (line: string) => void = console.log,
  f: typeof fetch = fetch,
): Promise<MintCheckResult> {
  const url = env.PAYOUT_SIGNER_URL;
  const token = env.PAYOUT_SIGNER_TOKEN;
  if (!url || !token) {
    log('mint check: no payout signer configured; skipping');
    return { ok: true, problems: [], signer: null, unreachable: true };
  }
  const r = await checkMintsAgainstSigner(agent, url, token, f);

  // Always say what we are paying, whatever the outcome. "Which mint is this
  // service actually using" should be answerable from a log line rather than
  // by reading someone's environment variables.
  const summary = Object.entries(agent.mints).map(([c, m]) => `${c}=${m.mint}`).join(' ');
  log(`mint check: agent on ${agent.network} with ${summary || 'no mints configured'}`);

  if (r.unreachable) {
    log('mint check: could not read the payout signer config; NOT verified against the signer');
    return r;
  }
  if (r.ok) {
    log('mint check: agent and payout signer agree');
    return r;
  }
  for (const p of r.problems) log(`MINT MISMATCH: ${p}`);
  if (env.MINT_MISMATCH === 'warn') {
    log('MINT MISMATCH: continuing because MINT_MISMATCH=warn. Bounties created now keep the agent mint forever.');
    return r;
  }
  throw new Error(
    `the agent and the payout signer disagree about what they are paying:\n  ${r.problems.join('\n  ')}\n` +
      'Fix PAYOUT_MINTS so both services match, or set MINT_MISMATCH=warn to boot anyway.',
  );
}
