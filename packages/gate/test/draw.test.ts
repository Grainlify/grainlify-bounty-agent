import { describe, expect, it } from 'vitest';
import { PRIOR_COMPLETION_CAP, pickWeighted, runDraw, seededRng, ticketsFrom, weightsFor, type DrawApplicant } from '../src/draw.ts';

const who = (o: Partial<DrawApplicant> = {}): DrawApplicant => ({
  githubUserId: 1, githubLogin: 'a', fit: 'plausible', difficultyMatch: 'matched',
  completions: 0, priorAssignments: 1, abandons: 0, ...o,
});
const tix = (o: Partial<DrawApplicant> = {}) => ticketsFrom(weightsFor(who(o)));

describe('draw weights', () => {
  it('starts everyone at one ticket', () => {
    expect(tix()).toBe(1);
  });

  it('rewards a strong fit and penalises a weak one', () => {
    expect(tix({ fit: 'strong' })).toBe(2);
    expect(tix({ fit: 'weak' })).toBe(0.25);
  });

  it('treats an unassessed applicant as plausible rather than excluding them', () => {
    // A fit call that failed must not silently remove someone from the pool.
    expect(tix({ fit: null })).toBe(1);
    expect(tix({ fit: undefined })).toBe(1);
  });

  it('penalises only an issue above the demonstrated level, never below it', () => {
    expect(tix({ difficultyMatch: 'above' })).toBe(0.5);
    expect(tix({ difficultyMatch: 'below' })).toBe(1);
  });

  it('gives a newcomer the first-ever bonus, anchored on assignments not applications', () => {
    expect(tix({ priorAssignments: 0 })).toBe(1.5);
    // Applying elsewhere must not cost them the bonus: only winning does.
    expect(tix({ priorAssignments: 0, completions: 0 })).toBe(1.5);
  });

  it('compounds prior completions but clamps them', () => {
    expect(tix({ completions: 1 })).toBeCloseTo(1.5);
    expect(tix({ completions: 2 })).toBeCloseTo(2.25);
    expect(tix({ completions: 5 })).toBeCloseTo(1.5 ** PRIOR_COMPLETION_CAP);
  });

  it('never lets accumulated wins outrank capability in a newcomer', () => {
    // The ordering the clamp exists to protect: a strong-fit newcomer must
    // stay ahead of a veteran with any number of wins.
    const newcomer = tix({ fit: 'strong', priorAssignments: 0 }); // 2.0 * 1.5
    for (const n of [3, 5, 20]) expect(tix({ completions: n })).toBeLessThan(newcomer);
  });

  it('compounds the abandon penalty', () => {
    expect(tix({ abandons: 1 })).toBe(0.5);
    expect(tix({ abandons: 3 })).toBeCloseTo(0.125);
  });

  it('cannot read anything outside the declared factors', () => {
    // Follower counts, stars, PR volume and application prose are absent by
    // omission. Anything extra on the object must change nothing.
    const extra = { ...who(), followers: 99_999, stars: 4000, applicationText: 'please pick me' };
    expect(ticketsFrom(weightsFor(extra as DrawApplicant))).toBe(1);
  });
});

describe('the draw itself', () => {
  const pool = [who({ githubUserId: 1, githubLogin: 'one' }), who({ githubUserId: 2, githubLogin: 'two', fit: 'strong' })];

  it('is replayable: the same seed and pool give the same winner', () => {
    const a = runDraw(pool, {}, 12345);
    const b = runDraw(pool, {}, 12345);
    expect(a.winner?.githubLogin).toBe(b.winner?.githubLogin);
    expect(a.pool.map((c) => c.tickets)).toEqual(b.pool.map((c) => c.tickets));
  });

  it('stores the per-applicant ticket breakdown, so a result can be explained', () => {
    const r = runDraw(pool, {}, 1);
    expect(r.pool[1]!.weights).toMatchObject({ fit_strong: 2 });
    expect(r.pool[1]!.tickets).toBe(2);
  });

  it('favours more tickets over many draws without ever being certain', () => {
    let strong = 0;
    for (let s = 0; s < 400; s++) if (runDraw(pool, {}, s).winner?.githubLogin === 'two') strong++;
    // 2:1 tickets. Wide bounds: this pins "weighted, not deterministic".
    expect(strong).toBeGreaterThan(200);
    expect(strong).toBeLessThan(380);
  });

  it('reports no winner rather than inventing one when nobody applied', () => {
    const r = runDraw([], {}, 7);
    expect(r.winner).toBeNull();
    expect(r.noWinnerReason).toBe('no applicants');
  });

  it('falls back to first-come, and records it, when everyone is penalised to zero', () => {
    const zeroed = [who({ githubUserId: 9, githubLogin: 'z' })];
    const r = runDraw(zeroed, { weight_fit_plausible: '0' }, 3);
    expect(r.winner?.githubLogin).toBe('z');
    expect(r.firstComeFallback).toBe(true);
    expect(r.noWinnerReason).toMatch(/zero tickets/);
  });

  it('honours config overrides for every weight', () => {
    const r = runDraw([who({ fit: 'strong' })], { weight_fit_strong: '5' }, 1);
    expect(r.pool[0]!.tickets).toBe(5);
  });

  it('picks nothing from an all-zero ticket list', () => {
    expect(pickWeighted(seededRng(1), [0, 0, 0])).toBe(-1);
  });
});
