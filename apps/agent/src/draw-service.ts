// Applications, the draw, and the assignment that comes out of it.
//
// The shape of the flow: a bounty is posted and applications open for a
// window (default six hours). When the window closes the draw runs, weighted
// by packages/gate/src/draw.ts, and one applicant is assigned. Nothing here
// pays anybody - a payout still needs a merged PR, the deterministic gate in
// packages/gate/src/gate.ts, and a human approval. This file decides only WHO
// gets to try.
//
// Two properties are worth stating because the code is arranged around them:
//
// 1. A draw is replayable. Seed, pool and the config in force are all stored,
//    so a contested result can be recomputed rather than argued about.
// 2. A refused application is stored with its reason. "You were not eligible"
//    with no reason is the kind of answer that makes people assume a rigged
//    process, and the row is what lets the page say which rule and why.

import { randomInt } from 'node:crypto';
import type pg from 'pg';
import { applicantBucket, boolOf, intOf, isWaivable, DRAW_SETTINGS, validate, withDefaults } from '../../../packages/gate/src/draw-config.ts';
import { type DrawApplicant, runDraw } from '../../../packages/gate/src/draw.ts';
import type { FitService } from './fit-service.ts';
import { fitEnabled } from './fit-service.ts';
import type { GitHubApi } from './github.ts';

export interface DrawDeps {
  db: pg.Pool;
  gh: GitHubApi;
  now: () => Date;
  /** Absent in tests that do not exercise Layer 2; everyone is then
   *  'plausible', which is a real outcome rather than a stub. */
  fit?: FitService;
}

export interface SettingView {
  key: string;
  type: string;
  section: string;
  description: string;
  default: string;
  value: string;
  overridden: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

export type ApplyOutcome =
  | { ok: true; status: 201; applicationId: string; closesAt: string | null; poolSizeHidden: true }
  | { ok: false; status: number; error: string; detail: string };

export interface DrawOutcome {
  drawId: string;
  bountyId: string;
  seed: number;
  simulation: boolean;
  triggeredBy: string;
  poolSize: number;
  pool: { githubLogin: string; githubUserId: number; fit: string; tickets: number; weights: Record<string, number>; share: number }[];
  winner: { githubLogin: string; githubUserId: number; tickets: number } | null;
  firstComeFallback: boolean;
  noWinnerReason: string | null;
  /** Drawn from newcomers only (§3.8). */
  reservedForNewcomers: boolean;
  /** Reserved, but nobody eligible applied, so the pool opened up. */
  reservationFellBack: boolean;
  assignmentId: string | null;
  staleAt: string | null;
}

/** Permission levels that mean "this person is on the inside of the repo". */
const INSIDER = ['admin', 'maintain', 'write'];

export class DrawService {
  constructor(private readonly d: DrawDeps) {}

  // ---------------------------------------------------------------- settings

  /** Stored overrides only. */
  private async overrides(): Promise<Record<string, string>> {
    const r = await this.d.db.query<{ key: string; value: string }>(`SELECT key, value FROM bounty_config`);
    return Object.fromEntries(r.rows.map((x) => [x.key, x.value]));
  }

  /** Every setting resolved: a stored override, or the default from code. */
  async config(): Promise<Record<string, string>> {
    return withDefaults(await this.overrides());
  }

  async settings(): Promise<SettingView[]> {
    const r = await this.d.db.query<{ key: string; value: string; updated_at: Date; updated_by: string }>(
      `SELECT key, value, updated_at, updated_by FROM bounty_config`,
    );
    const stored = new Map(r.rows.map((x) => [x.key, x]));
    return DRAW_SETTINGS.map((s) => {
      const row = stored.get(s.key);
      return {
        key: s.key,
        type: s.type,
        section: s.section,
        description: s.description,
        default: s.default,
        value: row?.value ?? s.default,
        overridden: row !== undefined,
        updatedAt: row ? new Date(row.updated_at).toISOString() : null,
        updatedBy: row?.updated_by ?? null,
      };
    });
  }

  async setSetting(key: string, value: string, by: string): Promise<{ ok: boolean; error?: string }> {
    const bad = validate(key, value);
    if (bad) return { ok: false, error: bad };
    await this.d.db.query(
      `INSERT INTO bounty_config (key, value, updated_at, updated_by) VALUES ($1, $2, now(), $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [key, value, by],
    );
    return { ok: true };
  }

  /** Back to the coded default. Deleting the row IS the reset. */
  async resetSetting(key: string): Promise<{ ok: boolean; error?: string }> {
    if (!DRAW_SETTINGS.some((s) => s.key === key)) return { ok: false, error: `unknown setting ${key}` };
    await this.d.db.query(`DELETE FROM bounty_config WHERE key = $1`, [key]);
    return { ok: true };
  }

  // ------------------------------------------------------------ applications

  /**
   * Opens the application window on a bounty. Idempotent: a bounty whose
   * window is already open keeps the close time it was given, so a redelivered
   * webhook cannot quietly extend one.
   */
  async openApplications(bountyId: string): Promise<{ opensAt: string; closesAt: string }> {
    const cfg = await this.config();
    const hours = intOf(cfg.application_window_hours, 6);
    const r = await this.d.db.query<{ applications_open_at: Date; applications_close_at: Date }>(
      `UPDATE bounties
          SET applications_open_at  = COALESCE(applications_open_at, $2),
              applications_close_at = COALESCE(applications_close_at, $2::timestamptz + ($3 || ' hours')::interval)
        WHERE id = $1
      RETURNING applications_open_at, applications_close_at`,
      [bountyId, this.d.now().toISOString(), String(hours)],
    );
    const row = r.rows[0];
    if (!row) throw new Error(`no such bounty ${bountyId}`);
    return {
      opensAt: new Date(row.applications_open_at).toISOString(),
      closesAt: new Date(row.applications_close_at).toISOString(),
    };
  }

  /**
   * Applies for a bounty.
   *
   * Every refusal is stored with the rule that caused it, except the two that
   * are not about the person (no such bounty, applications not open) - there
   * is nothing to tell them later, and a row keyed to a bounty that will not
   * run is noise.
   */
  async apply(input: { bountyId: string; githubUserId: number; githubLogin: string; applicationText?: string }): Promise<ApplyOutcome> {
    const cfg = await this.config();
    const now = this.d.now();

    const b = await this.d.db.query<{
      id: string; status: string; repo_id: string; owner: string; name: string;
      applications_close_at: Date | null; waived: string[]; is_test: boolean;
    }>(
      `SELECT b.id, b.status, b.repo_id, r.owner, r.name, b.applications_close_at,
              b.waived_eligibility_rules AS waived, b.is_test
         FROM bounties b JOIN repos r ON r.id = b.repo_id
        WHERE b.id = $1`,
      [input.bountyId],
    );
    const bounty = b.rows[0];
    if (!bounty) return { ok: false, status: 404, error: 'no_such_bounty', detail: 'that bounty does not exist' };
    if (bounty.status !== 'posted') {
      return { ok: false, status: 409, error: 'not_open', detail: `this bounty is ${bounty.status}, not open for applications` };
    }
    if (!bounty.applications_close_at || new Date(bounty.applications_close_at) <= now) {
      return { ok: false, status: 409, error: 'applications_closed', detail: 'applications for this bounty have closed' };
    }

    const repo = `${bounty.owner}/${bounty.name}`;
    const waived = new Set((bounty.waived ?? []).filter(isWaivable));

    // Each check returns a reason when it refuses. Evaluated in cheapest-first
    // order; the two that call GitHub come last.
    const refuse = async (reason: string, detail: string): Promise<ApplyOutcome> => {
      await this.d.db.query(
        `INSERT INTO bounty_applications (bounty_id, github_user_id, github_login, status, gate_failure_reason)
         VALUES ($1, $2, $3, 'rejected_gate', $4)
         ON CONFLICT (bounty_id, github_user_id) DO UPDATE SET status = 'rejected_gate', gate_failure_reason = EXCLUDED.gate_failure_reason, updated_at = now()`,
        [input.bountyId, input.githubUserId, input.githubLogin, reason],
      );
      return { ok: false, status: 403, error: reason, detail };
    };

    const already = await this.d.db.query<{ status: string }>(
      `SELECT status FROM bounty_applications WHERE bounty_id = $1 AND github_user_id = $2`,
      [input.bountyId, input.githubUserId],
    );
    if (already.rows[0] && already.rows[0].status !== 'rejected_gate') {
      return { ok: false, status: 409, error: 'already_applied', detail: 'you have already applied for this bounty' };
    }

    const maxActive = intOf(cfg.max_active_assignments_per_person, 1);
    const active = await this.d.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM bounty_assignments WHERE github_user_id = $1 AND status IN ('active','pr_submitted')`,
      [input.githubUserId],
    );
    if (Number(active.rows[0]?.n ?? 0) >= maxActive) {
      return refuse('holding_another_bounty', `you already hold ${maxActive === 1 ? 'a bounty' : `${maxActive} bounties`}; finish or release it before applying for another`);
    }

    if (boolOf(cfg.require_linked_wallet_to_apply, true)) {
      const w = await this.d.db.query(`SELECT 1 FROM wallet_links WHERE github_user_id = $1 AND revoked_at IS NULL`, [input.githubUserId]);
      if (!w.rowCount) {
        return refuse('no_linked_wallet', 'link a Solana wallet first, so a bounty you win can actually be paid');
      }
    }

    const minAge = intOf(cfg.min_account_age_days, 30);
    if (minAge > 0) {
      let createdAt: Date | null = null;
      try {
        createdAt = (await this.d.gh.getUser(repo, input.githubLogin)).createdAt;
      } catch {
        // Fail closed. "We could not read the account" is not "the account is
        // old enough", and this is the check that stops a farm of fresh
        // accounts entering the pool.
        return refuse('account_age_unknown', 'we could not read your GitHub account to check its age; try again shortly');
      }
      const ageDays = (now.getTime() - createdAt.getTime()) / 86_400_000;
      if (ageDays < minAge) {
        return refuse('account_too_new', `GitHub accounts must be at least ${minAge} days old to apply; yours is ${Math.floor(ageDays)}`);
      }
    }

    if (boolOf(cfg.block_org_members, true) && !waived.has('block_org_members')) {
      let perm = 'none';
      try {
        perm = await this.d.gh.permission(repo, input.githubLogin);
      } catch {
        // A non-collaborator is a 404 from GitHub, which is the ordinary case
        // for an applicant, so an error here means "not a collaborator" far
        // more often than it means trouble. Treated as outside the org.
        perm = 'none';
      }
      if (INSIDER.includes(perm)) {
        return refuse('org_member', `you have ${perm} access to ${repo}; maintainers cannot win their own bounties`);
      }
    }

    // Trimmed and capped here rather than trusted: it is interpolated into a
    // prompt, and §4.4 truncates it at 2000 characters anyway.
    const applicationText = (input.applicationText ?? '').trim().slice(0, 2000);
    const ins = await this.d.db.query<{ id: string }>(
      `INSERT INTO bounty_applications (bounty_id, github_user_id, github_login, status, application_text)
       VALUES ($1, $2, $3, 'applied', $4)
       ON CONFLICT (bounty_id, github_user_id)
         DO UPDATE SET status = 'applied', gate_failure_reason = NULL, application_text = EXCLUDED.application_text, updated_at = now()
       RETURNING id`,
      [input.bountyId, input.githubUserId, input.githubLogin, applicationText || null],
    );
    const applicationId = ins.rows[0]!.id;

    // Layer 2. Never allowed to fail the application: a model outage, a
    // budget ceiling or a stray code fence must not decide who is eligible.
    if (this.d.fit) {
      const issue = await this.d.db.query<{ issue_title: string | null; issue_number: number }>(
        `SELECT issue_title, issue_number FROM bounties WHERE id = $1`,
        [input.bountyId],
      );
      await this.d.fit
        .assess({
          applicationId,
          bountyId: input.bountyId,
          githubUserId: input.githubUserId,
          githubLogin: input.githubLogin,
          repo,
          issue: {
            title: issue.rows[0]?.issue_title ?? `Issue #${issue.rows[0]?.issue_number ?? 0}`,
            body: '',
            acceptanceCriteria: '',
            difficultyTier: cfg.fit_difficulty_tier ?? 'standard',
            primaryLanguage: '',
          },
          applicationText,
          enabled: fitEnabled(cfg),
        })
        .catch(() => {});
    }
    return {
      ok: true,
      status: 201,
      applicationId,
      closesAt: new Date(bounty.applications_close_at).toISOString(),
      // The live count is deliberately not returned. Knowing the pool size
      // changes when people apply, and a draw whose odds people try to time is
      // a draw that rewards refreshing the page.
      poolSizeHidden: true,
    };
  }

  /** Admin view. Counts and logins; nobody else is shown who applied. */
  async applicationsFor(bountyId: string) {
    // The fit call's receipt is joined rather than estimated, so "what did
    // this draw cost" is a fact about payments made, not arithmetic.
    const r = await this.d.db.query<{
      github_login: string; github_user_id: string; status: string; gate_failure_reason: string | null;
      fit: string | null; difficulty_match: string | null; fit_evidence: string | null; fit_concerns: string[];
      created_at: Date; cost_micro: string | null;
    }>(
      `SELECT a.github_login, a.github_user_id, a.status, a.gate_failure_reason, a.fit, a.difficulty_match,
              a.fit_evidence, a.fit_concerns, a.created_at,
              (COALESCE(c.paid_micro,0) + COALESCE(c.fee_micro,0))::text AS cost_micro
         FROM bounty_applications a
         LEFT JOIN inference_calls c ON c.id = a.fit_call_id
        WHERE a.bounty_id = $1 ORDER BY a.created_at`,
      [bountyId],
    );
    const rows = r.rows.map((x) => ({
      githubLogin: x.github_login,
      githubUserId: Number(x.github_user_id),
      status: x.status,
      gateFailureReason: x.gate_failure_reason,
      fit: x.fit,
      difficultyMatch: x.difficulty_match,
      fitEvidence: x.fit_evidence,
      fitConcerns: x.fit_concerns ?? [],
      // null, not 0: "no call was bought" and "a call that cost nothing"
      // are different claims, and surplus credit really does cost nothing.
      fitCostMicro: x.cost_micro === null ? null : Number(x.cost_micro),
      appliedAt: new Date(x.created_at).toISOString(),
    }));
    const assessed = rows.filter((x) => x.fitCostMicro !== null);
    const totalCostMicro = assessed.reduce((s2, x) => s2 + (x.fitCostMicro ?? 0), 0);
    return {
      total: rows.length,
      eligible: rows.filter((x) => x.status === 'applied' || x.status === 'won' || x.status === 'lost').length,
      refused: rows.filter((x) => x.status === 'rejected_gate').length,
      fitCost: {
        assessed: assessed.length,
        totalMicro: totalCostMicro,
        perApplicationMicro: assessed.length ? Math.round(totalCostMicro / assessed.length) : null,
      },
      applications: rows,
    };
  }

  /**
   * Every application this one contributor has, across all bounties.
   *
   * The page needs it because "have I applied" was answerable only from React
   * state, which does not survive a re-render or a reload: the list swapped
   * to a loading skeleton after applying, the row unmounted, and the Apply
   * button came back. The person clicked again and learned they had already
   * applied from the refusal. Client state is the wrong place for a fact the
   * server owns.
   *
   * Keyed by bounty id so the page can render each row from it directly.
   */
  async applicationsForUser(githubUserId: number) {
    const r = await this.d.db.query<{
      bounty_id: string; status: string; gate_failure_reason: string | null; created_at: Date;
    }>(
      `SELECT bounty_id, status, gate_failure_reason, created_at
         FROM bounty_applications WHERE github_user_id = $1`,
      [githubUserId],
    );
    const out: Record<string, { status: string; gateFailureReason: string | null; appliedAt: string }> = {};
    for (const x of r.rows) {
      out[x.bounty_id] = {
        status: x.status,
        gateFailureReason: x.gate_failure_reason,
        appliedAt: new Date(x.created_at).toISOString(),
      };
    }
    return out;
  }

  /** Bounties this contributor currently holds, so the page can say so. */
  async assignmentsForUser(githubUserId: number) {
    const r = await this.d.db.query<{ bounty_id: string; status: string; stale_at: Date }>(
      `SELECT bounty_id, status, stale_at FROM bounty_assignments
        WHERE github_user_id = $1 AND status IN ('active','pr_submitted')`,
      [githubUserId],
    );
    return Object.fromEntries(r.rows.map((x) => [x.bounty_id, { status: x.status, staleAt: new Date(x.stale_at).toISOString() }]));
  }

  /**
   * What a MAINTAINER may see about a bounty's applications.
   *
   * Time-gated, and gated here rather than in the caller. Grainlify decides
   * whether someone maintains the repo; this decides what a maintainer is
   * allowed to know, and it must hold even if the caller asks for more.
   *
   * While the window is open: a rough count, no names. If a maintainer can
   * see who applied while applications are still open, applicants can be
   * leaned on or tipped off, and the whole point of hiding the pool is that
   * nobody can work the draw.
   *
   * After it closes: the full list with each applicant's gate outcome.
   * Exactness harms nothing once nobody can act on it.
   *
   * After the draw: the winner and the ticket breakdown, so a maintainer can
   * see the result was arithmetic rather than a choice.
   *
   * At no point is there anything to act on. A maintainer cannot assign,
   * reject, or influence the draw, and this returns no handle that would let
   * them try.
   */
  async maintainerView(bountyId: string) {
    const b = await this.d.db.query<{ applications_close_at: Date | null; issue_number: number; owner: string; name: string }>(
      `SELECT b.applications_close_at, b.issue_number, r.owner, r.name
         FROM bounties b JOIN repos r ON r.id = b.repo_id WHERE b.id = $1`,
      [bountyId],
    );
    const row = b.rows[0];
    if (!row) return { error: 'no_such_bounty', detail: 'that bounty does not exist' };

    const cfg = await this.config();
    const closesAt = row.applications_close_at ? new Date(row.applications_close_at) : null;
    const windowOpen = closesAt !== null && closesAt > this.d.now();

    const counted = await this.d.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM bounty_applications WHERE bounty_id = $1 AND status IN ('applied','won','lost')`,
      [bountyId],
    );
    const total = Number(counted.rows[0]?.n ?? 0);

    const base = {
      bountyId,
      repo: `${row.owner}/${row.name}`,
      issueNumber: row.issue_number,
      windowOpen,
      applicationsCloseAt: closesAt ? closesAt.toISOString() : null,
      // Stated on every response, so the UI never has to infer it and a
      // maintainer is never left wondering whether a button is missing or
      // merely not rendered.
      canAssign: false as const,
      assignmentIsByDraw: true as const,
    };

    if (windowOpen) {
      return {
        ...base,
        ...poolVisibilityForMaintainer(total, cfg.applicant_count_visibility ?? 'bucketed'),
        applications: null,
        draw: null,
      };
    }

    const view = await this.applicationsFor(bountyId);
    const draws = await this.drawsFor(bountyId);
    const real = draws.find((d) => d.simulation === false) ?? null;
    return {
      ...base,
      applicantBucket: null,
      applicantCount: total,
      applications: view.applications.map((a) => ({
        githubLogin: a.githubLogin,
        status: a.status,
        gateFailureReason: a.gateFailureReason,
        fit: a.fit,
        appliedAt: a.appliedAt,
      })),
      draw: real
        ? { winnerLogin: real.winnerLogin, seed: real.seed, ranAt: real.ranAt, pool: real.pool, noWinnerReason: real.noWinnerReason }
        : null,
    };
  }

  // --------------------------------------------------------------- the draw

  /** History that feeds the weights, for every applicant in one query. */
  private async historyFor(userIds: number[]): Promise<Map<number, { completions: number; priorAssignments: number; abandons: number }>> {
    const out = new Map<number, { completions: number; priorAssignments: number; abandons: number }>();
    for (const id of userIds) out.set(id, { completions: 0, priorAssignments: 0, abandons: 0 });
    if (userIds.length === 0) return out;
    const r = await this.d.db.query<{ github_user_id: string; completions: string; assignments: string; abandons: string }>(
      `SELECT github_user_id,
              count(*) FILTER (WHERE status = 'completed')                              AS completions,
              count(*)                                                                   AS assignments,
              count(*) FILTER (WHERE status = 'released_stale' AND counts_as_abandon)     AS abandons
         FROM bounty_assignments
        WHERE github_user_id = ANY($1::bigint[])
        GROUP BY github_user_id`,
      [userIds],
    );
    for (const row of r.rows) {
      out.set(Number(row.github_user_id), {
        completions: Number(row.completions),
        priorAssignments: Number(row.assignments),
        abandons: Number(row.abandons),
      });
    }
    return out;
  }

  /**
   * Runs the draw for one bounty.
   *
   * `simulate` runs the whole pipeline against the real pool and writes the
   * draw row for inspection, but assigns nobody. That is how a weight change
   * gets checked before it decides anything.
   */
  async runDrawFor(bountyId: string, opts: { triggeredBy: string; simulate?: boolean }): Promise<DrawOutcome | { error: string; detail: string }> {
    const simulate = opts.simulate === true;
    const cfg = await this.config();
    const now = this.d.now();

    const b = await this.d.db.query<{ id: string; status: string; reserved_for_newcomers: boolean }>(
      `SELECT id, status, reserved_for_newcomers FROM bounties WHERE id = $1`,
      [bountyId],
    );
    if (!b.rows[0]) return { error: 'no_such_bounty', detail: 'that bounty does not exist' };
    const reserved = b.rows[0].reserved_for_newcomers === true;

    if (!simulate) {
      const live = await this.d.db.query(
        `SELECT 1 FROM bounty_assignments WHERE bounty_id = $1 AND status IN ('active','pr_submitted')`,
        [bountyId],
      );
      if (live.rowCount) {
        return { error: 'already_assigned', detail: 'this bounty already has a live assignment; release it before drawing again' };
      }
    }

    const a = await this.d.db.query<{ github_user_id: string; github_login: string; fit: string | null; difficulty_match: string | null }>(
      `SELECT github_user_id, github_login, fit, difficulty_match
         FROM bounty_applications WHERE bounty_id = $1 AND status IN ('applied','lost') ORDER BY created_at`,
      [bountyId],
    );
    const history = await this.historyFor(a.rows.map((x) => Number(x.github_user_id)));

    // §3.8. A newcomer is someone with no COMPLETED bounty, which is the
    // spec's newcomer_definition; having applied, or even held one and
    // released it, does not use the reservation up.
    let rows = a.rows;
    let reservationFellBack = false;
    if (reserved) {
      const newcomers = rows.filter((x) => (history.get(Number(x.github_user_id))?.completions ?? 0) === 0);
      if (newcomers.length > 0) {
        rows = newcomers;
      } else if (boolOf(cfg.reservation_fallback_to_open_pool, true)) {
        // An unassignable bounty helps nobody, least of all a newcomer.
        reservationFellBack = true;
      } else {
        return { error: 'no_newcomers', detail: 'this bounty is reserved for newcomers and none applied' };
      }
    }

    const applicants: DrawApplicant[] = rows.map((x) => {
      const h = history.get(Number(x.github_user_id))!;
      return {
        githubUserId: Number(x.github_user_id),
        githubLogin: x.github_login,
        fit: (x.fit as DrawApplicant['fit']) ?? null,
        difficultyMatch: (x.difficulty_match as DrawApplicant['difficultyMatch']) ?? null,
        ...h,
      };
    });

    // Drawn fresh, from the OS. A seed derived from anything a caller can see
    // or influence - the bounty id, the clock, the pool - is a seed somebody
    // can try to time.
    const seed = randomInt(0, 2 ** 31 - 1);
    const result = runDraw(applicants, cfg, seed);
    const totalTickets = result.pool.reduce((s, c) => s + c.tickets, 0);
    const pool = result.pool.map((c) => ({
      githubLogin: c.githubLogin,
      githubUserId: c.githubUserId,
      fit: c.fit,
      tickets: c.tickets,
      weights: c.weights,
      share: totalTickets > 0 ? c.tickets / totalTickets : 0,
    }));

    const drawRow = await this.d.db.query<{ id: string }>(
      `INSERT INTO bounty_draws (bounty_id, seed, pool, pool_size, winner_github_user_id, winner_login,
                                 first_come_fallback, no_winner_reason, is_simulation, config_snapshot, triggered_by)
       VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10::jsonb,$11) RETURNING id`,
      [
        bountyId, seed, JSON.stringify(pool), pool.length,
        simulate ? null : (result.winner?.githubUserId ?? null),
        simulate ? null : (result.winner?.githubLogin ?? null),
        result.firstComeFallback, result.noWinnerReason, simulate, JSON.stringify(cfg), opts.triggeredBy,
      ],
    );
    const drawId = drawRow.rows[0]!.id;

    let assignmentId: string | null = null;
    let staleAt: string | null = null;
    if (!simulate && result.winner) {
      const staleHours = intOf(cfg.assignment_stale_hours, 72);
      const asg = await this.d.db.query<{ id: string; stale_at: Date }>(
        `INSERT INTO bounty_assignments (bounty_id, draw_id, github_user_id, github_login, status, assigned_at, stale_at)
         VALUES ($1,$2,$3,$4,'active',$5,$5::timestamptz + ($6 || ' hours')::interval)
         RETURNING id, stale_at`,
        [bountyId, drawId, result.winner.githubUserId, result.winner.githubLogin, now.toISOString(), String(staleHours)],
      );
      assignmentId = asg.rows[0]!.id;
      staleAt = new Date(asg.rows[0]!.stale_at).toISOString();
      await this.d.db.query(
        `UPDATE bounty_applications SET status = CASE WHEN github_user_id = $2 THEN 'won' ELSE 'lost' END, updated_at = now()
          WHERE bounty_id = $1 AND status IN ('applied','lost')`,
        [bountyId, result.winner.githubUserId],
      );
    }

    return {
      drawId,
      bountyId,
      seed,
      simulation: simulate,
      triggeredBy: opts.triggeredBy,
      poolSize: pool.length,
      pool,
      winner: result.winner && !simulate
        ? { githubLogin: result.winner.githubLogin, githubUserId: result.winner.githubUserId, tickets: result.winner.tickets }
        : null,
      firstComeFallback: result.firstComeFallback,
      noWinnerReason: result.noWinnerReason,
      reservedForNewcomers: reserved,
      reservationFellBack,
      assignmentId,
      staleAt,
    };
  }

  async drawsFor(bountyId: string) {
    const r = await this.d.db.query(
      `SELECT id, seed, pool, pool_size, winner_login, first_come_fallback, no_winner_reason,
              is_simulation, triggered_by, config_snapshot, created_at
         FROM bounty_draws WHERE bounty_id = $1 ORDER BY created_at DESC`,
      [bountyId],
    );
    return r.rows.map((x: Record<string, unknown>) => ({
      drawId: x.id,
      seed: Number(x.seed),
      pool: x.pool,
      poolSize: x.pool_size,
      winnerLogin: x.winner_login,
      firstComeFallback: x.first_come_fallback,
      noWinnerReason: x.no_winner_reason,
      simulation: x.is_simulation,
      triggeredBy: x.triggered_by,
      configSnapshot: x.config_snapshot,
      ranAt: new Date(x.created_at as string).toISOString(),
    }));
  }

  // ----------------------------------------------------------- the scheduler

  /**
   * Releases assignments whose deadline has passed with no pull request.
   *
   * stale_at has been written on every assignment since the draw was built,
   * shown to the winner, shown to maintainers, and counted in the abandon
   * weight - and nothing ever acted on it. So the deadline was advisory: a
   * winner who went quiet held the bounty indefinitely, and because
   * runDrawFor refuses while a live assignment exists, the bounty could never
   * be drawn again. assignment_stale_hours and weight_per_abandon were both
   * inert as a result, which is the same shape of gap the fit weights had
   * before Layer 2 existed: a setting the page publishes and nothing reads.
   *
   * Only 'active' is released. 'pr_submitted' means they answered, and a
   * review taking longer than the deadline is the maintainer's queue, not the
   * contributor's silence - releasing those would punish the wrong person.
   *
   * Silence counts as an abandon, which halves their tickets next time via
   * weight_per_abandon. A rejected pull request does not, and is not touched
   * here.
   */
  async releaseStaleAssignments(): Promise<{ released: { bountyId: string; githubLogin: string }[] }> {
    const r = await this.d.db.query<{ bounty_id: string; github_login: string }>(
      `UPDATE bounty_assignments
          SET status = 'released_stale',
              released_at = $1,
              release_reason = 'no pull request before the deadline',
              counts_as_abandon = true,
              updated_at = now()
        WHERE status = 'active' AND stale_at <= $1
      RETURNING bounty_id, github_login`,
      [this.d.now().toISOString()],
    );

    // Put their application back in the pool as 'lost' rather than leaving it
    // 'won', so the re-draw can see them.
    //
    // They are not excluded outright, which was the alternative. The abandon
    // weight already exists for exactly this - it halves their tickets, and
    // halves them again if it happens twice - and that is a proportionate
    // answer where exclusion is a blunt second mechanism doing the same job.
    // On a small pool, excluding the only previous applicant would also leave
    // a bounty with nobody to draw from.
    for (const row of r.rows) {
      await this.d.db.query(
        `UPDATE bounty_applications SET status = 'lost', updated_at = now()
          WHERE bounty_id = $1 AND github_login = $2 AND status = 'won'`,
        [row.bounty_id, row.github_login],
      );
    }
    return { released: r.rows.map((x) => ({ bountyId: x.bounty_id, githubLogin: x.github_login })) };
  }

  /**
   * Every window that has closed and has no live assignment yet.
   *
   * Extends rather than gives up when nobody applied, up to a limit: a bounty
   * with no applicants is far more often "posted at a quiet hour" than "nobody
   * wants it", and silently leaving it unassignable teaches contributors that
   * the page is stale.
   */
  async closeDueWindows(): Promise<{ drawn: string[]; extended: string[]; skipped: string[]; released: string[] }> {
    const cfg = await this.config();
    const drawn: string[] = [];
    const extended: string[] = [];
    const skipped: string[] = [];

    // Before looking for windows to close: give back anything whose winner
    // went quiet. A bounty with a stale assignment is not "assigned", and
    // leaving it that way is how one silent winner parks a bounty forever.
    // Runs even with the automatic draw off - releasing is not drawing, and a
    // deadline that only applies when a setting is on is not a deadline.
    const { released } = await this.releaseStaleAssignments();
    const releasedIds = released.map((x) => x.bountyId);

    if (!boolOf(cfg.auto_draw_enabled, true)) return { drawn, extended, skipped, released: releasedIds };

    const due = await this.d.db.query<{ id: string; window_extensions: number }>(
      `SELECT b.id, b.window_extensions
         FROM bounties b
        WHERE b.status = 'posted'
          AND b.applications_close_at IS NOT NULL
          AND b.applications_close_at <= $1
          AND NOT EXISTS (SELECT 1 FROM bounty_assignments a WHERE a.bounty_id = b.id AND a.status IN ('active','pr_submitted'))`,
      [this.d.now().toISOString()],
    );

    for (const row of due.rows) {
      const pool = await this.d.db.query<{ n: string }>(
        `SELECT count(*) AS n FROM bounty_applications WHERE bounty_id = $1 AND status IN ('applied','lost')`,
        [row.id],
      );
      if (Number(pool.rows[0]?.n ?? 0) === 0) {
        const maxExt = intOf(cfg.max_window_extensions, 3);
        const extHours = intOf(cfg.empty_window_extension_hours, 6);
        if (row.window_extensions >= maxExt || extHours <= 0) {
          skipped.push(row.id);
          continue;
        }
        await this.d.db.query(
          `UPDATE bounties
              SET applications_close_at = $2::timestamptz + ($3 || ' hours')::interval,
                  window_extensions = window_extensions + 1
            WHERE id = $1`,
          [row.id, this.d.now().toISOString(), String(extHours)],
        );
        extended.push(row.id);
        continue;
      }
      const r = await this.runDrawFor(row.id, { triggeredBy: 'automatic' });
      if ('drawId' in r) {
        await this.d.db.query(`UPDATE bounties SET auto_draw_ran_at = now() WHERE id = $1`, [row.id]);
        drawn.push(row.id);
      } else {
        skipped.push(row.id);
      }
    }
    return { drawn, extended, skipped, released: releasedIds };
  }
}


/**
 * A maintainer's view of an open pool: the same coarse band contributors get,
 * never the exact number and never the names.
 *
 * 'exact' is deliberately NOT honoured here while the window is open. That
 * setting is about what the PUBLIC page shows; a maintainer has influence
 * over the repository and therefore over applicants, so the reason to keep
 * the pool coarse applies to them more strongly, not less.
 */
export function poolVisibilityForMaintainer(
  total: number,
  visibility: string,
): { applicantBucket: 'none' | 'few' | 'many' | null; applicantCount: number | null } {
  if (visibility === 'hidden') return { applicantBucket: null, applicantCount: null };
  return { applicantBucket: applicantBucket(total), applicantCount: null };
}
