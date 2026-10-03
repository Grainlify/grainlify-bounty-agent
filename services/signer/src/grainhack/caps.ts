// GrainHack payout ceilings. Hard-coded; configuration may only lower them.
//
// Keyed by currency here and applied per (currency, network): the per-event
// and per-day sums the journal checks are always taken within one currency on
// one network, so devnet test money never counts against mainnet and the
// other way round. Only USDC is payable on this path (contract, decisions).

export interface GrainhackCaps {
  /** One winner, one payout. $500. */
  perPayoutMaxMinor: bigint;
  /** Everything one event's pool pays, across all its statements. $5,000; never more than the statement's pool either. */
  perEventMaxMinor: bigint;
  /** Everything paid in one UTC day. $2,500. */
  dailyMaxMinor: bigint;
}

export const GRAINHACK_HARD_CAPS: Record<string, GrainhackCaps> = {
  USDC: { perPayoutMaxMinor: 500_000_000n, perEventMaxMinor: 5_000_000_000n, dailyMaxMinor: 2_500_000_000n },
};

const lower = (hard: bigint, configured: bigint | undefined) => (configured !== undefined && configured > 0n && configured < hard ? configured : hard);

/** The caps in force: the hard ceiling, lowered by configuration where configuration asks for less. null when the currency has none. */
export function grainhackCapsFor(currency: string, configured?: Partial<GrainhackCaps>): GrainhackCaps | null {
  const hard = GRAINHACK_HARD_CAPS[currency];
  if (!hard) return null;
  return {
    perPayoutMaxMinor: lower(hard.perPayoutMaxMinor, configured?.perPayoutMaxMinor),
    perEventMaxMinor: lower(hard.perEventMaxMinor, configured?.perEventMaxMinor),
    dailyMaxMinor: lower(hard.dailyMaxMinor, configured?.dailyMaxMinor),
  };
}

/**
 * GRAINHACK_CAPS, e.g. {"USDC":{"perPayoutMaxMinor":"100000000"}}. Values are
 * decimal strings of minor units. A value above the hard cap is ignored (the
 * hard cap applies); a malformed one stops the process at boot.
 */
export function parseGrainhackCaps(json: string | undefined): Record<string, Partial<GrainhackCaps>> {
  if (!json?.trim()) return {};
  const raw = JSON.parse(json) as Record<string, Record<string, string>>;
  const out: Record<string, Partial<GrainhackCaps>> = {};
  for (const [currency, c] of Object.entries(raw)) {
    const one: Partial<GrainhackCaps> = {};
    for (const [k, v] of Object.entries(c)) {
      if (!['perPayoutMaxMinor', 'perEventMaxMinor', 'dailyMaxMinor'].includes(k)) throw new Error(`GRAINHACK_CAPS: unknown cap ${currency}.${k}`);
      if (typeof v !== 'string' || !/^[1-9][0-9]*$/.test(v)) throw new Error(`GRAINHACK_CAPS: ${currency}.${k} must be a positive decimal string`);
      one[k as keyof GrainhackCaps] = BigInt(v);
    }
    out[currency] = one;
  }
  return out;
}
