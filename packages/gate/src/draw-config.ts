// The settings an admin can change from the dashboard, and what each one means.
//
// This is the bounty-side counterpart of Grainlify-Backend's
// internal/hackathon/config.go: the same shape (key, type, default, section,
// description), so the two dashboards read alike and a setting that exists in
// both carries the same name.
//
// Defaults live here, in code. A row in bounty_config overrides one; deleting
// the row restores the default. That ordering matters: an empty config table
// must produce a working, sane programme, so a lost or wiped settings table is
// a reversion rather than an outage.

export interface Setting {
  key: string;
  type: 'int' | 'float' | 'bool';
  default: string;
  section: string;
  description: string;
  /** Rejected outside this range. Absent means any value of the type. */
  min?: number;
  max?: number;
}

export const DRAW_SETTINGS: Setting[] = [
  {
    key: 'application_window_hours',
    type: 'int',
    default: '6',
    section: 'Window',
    description: 'How long applications stay open after a bounty is posted, before the draw runs.',
    min: 1,
    max: 720,
  },
  {
    key: 'auto_draw_enabled',
    type: 'bool',
    default: 'true',
    section: 'Window',
    description: 'Run the draw automatically when a window closes. Off means every draw is run by hand from this page.',
  },
  {
    key: 'empty_window_extension_hours',
    type: 'int',
    default: '6',
    section: 'Window',
    description: 'If a window closes with no applicants, extend it by this many hours instead of leaving the bounty unassignable.',
    min: 0,
    max: 720,
  },
  {
    key: 'max_window_extensions',
    type: 'int',
    default: '3',
    section: 'Window',
    description: 'How many times a window may be extended for lack of applicants before the bounty is left alone for a human to look at.',
    min: 0,
    max: 20,
  },
  {
    key: 'assignment_stale_hours',
    type: 'int',
    default: '72',
    section: 'Assignment',
    description: 'How long a winner has to open a pull request before the assignment goes stale and the bounty can be drawn again.',
    min: 1,
    max: 2160,
  },
  {
    key: 'block_org_members',
    type: 'bool',
    default: 'true',
    section: 'Hard gates',
    description: "Members of the bounty repository's own org cannot apply. A bounty may waive this individually; nothing else about a bounty can be waived.",
  },
  {
    key: 'min_account_age_days',
    type: 'int',
    default: '30',
    section: 'Hard gates',
    description: 'Minimum GitHub account age to apply. The payout gate checks this again independently at merge time.',
    min: 0,
    max: 3650,
  },
  {
    key: 'require_linked_wallet_to_apply',
    type: 'bool',
    default: 'true',
    section: 'Hard gates',
    description: 'Require a linked Solana wallet before applying, so nobody wins a bounty they cannot be paid for.',
  },
  {
    key: 'max_active_assignments_per_person',
    type: 'int',
    default: '1',
    section: 'Hard gates',
    description: 'How many bounties one person may hold at once. Holding several while finishing none is the main way a draw gets gamed.',
    min: 1,
    max: 10,
  },
  // The weights. Same keys and defaults as packages/gate/src/draw.ts reads,
  // and as GrainHack's §3.9 uses, so the published explanation of the odds
  // stays true for both.
  { key: 'weight_fit_strong', type: 'float', default: '2.0', section: 'Weights', description: 'Ticket multiplier when the fit assessment says the applicant is a strong match.', min: 0, max: 100 },
  { key: 'weight_fit_plausible', type: 'float', default: '1.0', section: 'Weights', description: 'Ticket multiplier for a plausible match. This is also what an unassessed application gets.', min: 0, max: 100 },
  { key: 'weight_fit_weak', type: 'float', default: '0.25', section: 'Weights', description: 'Ticket multiplier for a weak match. Never zero: a weak match still has a chance.', min: 0, max: 100 },
  { key: 'weight_difficulty_above', type: 'float', default: '0.5', section: 'Weights', description: 'Multiplier when the issue looks harder than the applicant has taken on before. Only "above" is penalised.', min: 0, max: 100 },
  { key: 'weight_prior_completion', type: 'float', default: '1.5', section: 'Weights', description: 'Per completed bounty, compounding, capped at two so accumulated wins cannot outrank capability.', min: 0, max: 100 },
  { key: 'weight_first_ever_application', type: 'float', default: '1.5', section: 'Weights', description: 'Bonus for someone who has never been assigned a bounty. Anchored to assignments, not applications.', min: 0, max: 100 },
  { key: 'weight_per_abandon', type: 'float', default: '0.5', section: 'Weights', description: 'Per assignment released for silence, compounding. A rejected pull request is not an abandon.', min: 0, max: 100 },
];

export const SETTINGS_BY_KEY: Record<string, Setting> = Object.fromEntries(DRAW_SETTINGS.map((s) => [s.key, s]));

/**
 * The ONLY eligibility rule a bounty may waive.
 *
 * Deliberately a one-element list rather than a boolean or an open string
 * column. A waiver exists so the programme can be tested end to end by someone
 * who would otherwise be blocked for being in the org; it is not a general
 * "skip the checks" switch, and the shape of this constant is what stops it
 * becoming one. Nothing here reaches the payout gate, which never reads the
 * column at all.
 */
export const WAIVABLE_ELIGIBILITY_RULES = ['block_org_members'] as const;
export type WaivableRule = (typeof WAIVABLE_ELIGIBILITY_RULES)[number];

export function isWaivable(rule: string): rule is WaivableRule {
  return (WAIVABLE_ELIGIBILITY_RULES as readonly string[]).includes(rule);
}

/** Config with defaults filled in, ready to hand to runDraw. */
export function withDefaults(overrides: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of DRAW_SETTINGS) out[s.key] = overrides[s.key] ?? s.default;
  return out;
}

export function boolOf(v: string | undefined, fallback = false): boolean {
  if (v === undefined) return fallback;
  return v === 'true' || v === 'yes' || v === '1';
}

export function intOf(v: string | undefined, fallback: number): number {
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Rejects a value the dashboard should never have sent. Returns null when fine. */
export function validate(key: string, value: string): string | null {
  const s = SETTINGS_BY_KEY[key];
  if (!s) return `unknown setting ${key}`;
  if (s.type === 'bool') {
    return value === 'true' || value === 'false' ? null : 'must be true or false';
  }
  const n = Number(value);
  if (!Number.isFinite(n)) return 'must be a number';
  if (s.type === 'int' && !Number.isInteger(n)) return 'must be a whole number';
  if (s.min !== undefined && n < s.min) return `must be at least ${s.min}`;
  if (s.max !== undefined && n > s.max) return `must be at most ${s.max}`;
  return null;
}
