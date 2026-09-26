// The weighted draw that assigns one bounty to one contributor.
//
// This is a port of GrainHack's draw (Grainlify-Backend,
// internal/hackathon/draw.go §3.9) with the same factors, the same config
// keys and the same defaults, so the two can be read side by side and a
// contributor who has met one meets the other. The port is deliberate rather
// than a shared service: the applicants live in the agent's own database, and
// a draw that needs a cross-service call to run is a draw that can fail at
// the one moment it must not.
//
// The RNG is this implementation's own, so a seed is replayable HERE but is
// not byte-comparable with the Go draw. What is shared is the arithmetic:
// same weights, same clamp, same ordering guarantees, pinned by the same
// tests.

/** Capped so accumulated wins can never outrank demonstrated capability. */
export const PRIOR_COMPLETION_CAP = 2;

export interface DrawApplicant {
  githubUserId: number;
  githubLogin: string;
  /** Layer-2 assessment. Anything unassessed counts as 'plausible'. */
  fit?: 'strong' | 'plausible' | 'weak' | null;
  difficultyMatch?: 'below' | 'matched' | 'above' | null;
  /** Bounties this person has completed, ever. */
  completions: number;
  /** Bounties this person has been assigned, ever. Zero = a newcomer. */
  priorAssignments: number;
  /** Assignments released for silence. A rejected PR is NOT one of these. */
  abandons: number;
}

export interface Candidate {
  githubUserId: number;
  githubLogin: string;
  fit: string;
  weights: Record<string, number>;
  tickets: number;
}

export interface DrawResult {
  seed: number;
  pool: Candidate[];
  winner: Candidate | null;
  firstComeFallback: boolean;
  noWinnerReason: string | null;
}

export type DrawConfig = Record<string, string | undefined>;

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return v === undefined || v === '' || Number.isNaN(n) ? fallback : n;
};

/**
 * A candidate's ticket count. Base 1.0, multiply every applicable factor.
 *
 * The factors deliberately absent — total PR count, merge rate, followers,
 * stars, total contributions, how well the application reads — are absent by
 * omission: there is no path here that can read them. That is the property
 * that lets the page promise it.
 */
export function weightsFor(a: DrawApplicant, cfg: DrawConfig = {}): Record<string, number> {
  const w: Record<string, number> = {};

  switch (a.fit) {
    case 'strong':
      w.fit_strong = num(cfg.weight_fit_strong, 2.0);
      break;
    case 'weak':
      w.fit_weak = num(cfg.weight_fit_weak, 0.25);
      break;
    default:
      w.fit_plausible = num(cfg.weight_fit_plausible, 1.0);
  }

  // Only "above" is penalised. An experienced contributor taking an easy issue
  // is fine; taxing it would push newcomers off easy issues by crowding.
  if (a.difficultyMatch === 'above') w.difficulty_above = num(cfg.weight_difficulty_above, 0.5);

  if (a.completions > 0) {
    // Compounding but clamped. Uncompounded it would be the only unbounded
    // term, and by the third completion accumulated wins overtake demonstrated
    // capability — which inverts the ordering this draw exists to protect.
    const n = Math.min(a.completions, PRIOR_COMPLETION_CAP);
    const base = num(cfg.weight_prior_completion, 1.5);
    w.prior_completion = base ** n;
  }

  // Anchored to never having been ASSIGNED, not to having no other
  // application: otherwise a genuine newcomer who applies twice loses the
  // bonus on both, and "applying to more issues does not change your odds"
  // stops being true.
  if (a.priorAssignments === 0) w.first_ever_application = num(cfg.weight_first_ever_application, 1.5);

  if (a.abandons > 0) w.per_abandon = num(cfg.weight_per_abandon, 0.5) ** a.abandons;

  return w;
}

export function ticketsFrom(w: Record<string, number>): number {
  let t = 1.0;
  for (const f of Object.values(w)) t *= f;
  return t;
}

/** mulberry32: small, fast, and deterministic for a given seed. */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One index from tickets. -1 when every candidate has zero tickets. */
export function pickWeighted(rng: () => number, tickets: number[]): number {
  const total = tickets.reduce((a, b) => a + b, 0);
  if (total <= 0) return -1;
  let r = rng() * total;
  for (let i = 0; i < tickets.length; i++) {
    r -= tickets[i]!;
    if (r <= 0) return i;
  }
  return tickets.length - 1; // floating-point tail
}

/**
 * Runs the draw. Pure: same applicants and same seed give the same winner,
 * which is what makes a contested result answerable rather than arguable.
 */
export function runDraw(applicants: DrawApplicant[], cfg: DrawConfig, seed: number): DrawResult {
  const pool: Candidate[] = applicants.map((a) => {
    const weights = weightsFor(a, cfg);
    return {
      githubUserId: a.githubUserId,
      githubLogin: a.githubLogin,
      fit: a.fit ?? 'plausible',
      weights,
      tickets: ticketsFrom(weights),
    };
  });

  if (pool.length === 0) {
    return { seed, pool, winner: null, firstComeFallback: false, noWinnerReason: 'no applicants' };
  }

  const idx = pickWeighted(seededRng(seed), pool.map((c) => c.tickets));
  if (idx < 0) {
    // Everyone penalised to zero. Falling back to first-come is better than
    // leaving the bounty unassignable, but it is recorded as a fallback.
    return { seed, pool, winner: pool[0]!, firstComeFallback: true, noWinnerReason: 'every candidate had zero tickets' };
  }
  return { seed, pool, winner: pool[idx]!, firstComeFallback: false, noWinnerReason: null };
}
