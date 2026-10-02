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
import { dedupe, enqueueEvent } from './events.ts';
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

/** Why a bounty went back to open, as the public history says it. */
export const REOPEN_REASON = 'pull request closed without merging';

export type ReopenOutcome =
  | { reopened: true; bountyId: string; prNumber: number; contributor: string; holder: string | null; holderReset: boolean; held: boolean }
  | { reopened: false; bountyId: string; why: 'no_such_bounty' | 'not_in_review' | 'pr_open' | 'pr_merged' | 'no_closed_pr' };

/**
 * A bounty that says "PR in review" when no pull request is open on it goes
 * back to 'posted', and the public history says why.
 *
 * Only the assignment moved when a pull request closed unmerged: the holder
 * was made live again, the bounty kept saying in_review, and the draw sweep
 * and apply() both act on 'posted' alone. So once the holder's deadline
 * released them, nobody held the bounty and nothing could ever draw it again
 * - #35 after PR #37 was closed on 1 October. 'posted' with a live holder is
 * the ordinary assigned state, so nothing else has to learn a new one: the
 * deadline, the stale release and the redraw from the existing pool carry on
 * as they would have. A funded bounty goes back to 'posted' too, which is the
 * state its funder's own draw and assign need.
 *
 * Shared by the webhook and the repair command, so a bounty repaired after the
 * fact leaves the same record as one handled as it happened. One transaction,
 * the bounty row locked, and the audit row written with the change: a status
 * that moved without its record is the silent edit this must never be.
 * Idempotent - a second call finds nothing in review and changes nothing.
 *
 * `hold` leaves the next draw to a person (awaiting_redraw), for when somebody
 * has to decide who may be in it before it runs.
 */
export async function reopenAfterUnmergedClose(
  db: pg.Pool,
  input: { bountyId: string; actor: string; source: 'webhook' | 'repair'; hold?: boolean },
): Promise<ReopenOutcome> {
  const { bountyId } = input;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const no = async (why: Extract<ReopenOutcome, { reopened: false }>['why']): Promise<ReopenOutcome> => {
      await client.query('ROLLBACK');
      return { reopened: false, bountyId, why };
    };
    const b = (await client.query<{ status: string }>('SELECT status FROM bounties WHERE id = $1 FOR UPDATE', [bountyId])).rows[0];
    if (!b) return await no('no_such_bounty');
    if (b.status !== 'in_review') return await no('not_in_review');

    const subs = await client.query<{ pr_number: number; author_login: string; state: string }>(
      'SELECT pr_number, author_login, state FROM submissions WHERE bounty_id = $1 ORDER BY updated_at DESC', [bountyId]);
    // Somebody's pull request is still open, so "in review" is true.
    if (subs.rows.some((s) => s.state === 'open')) return await no('pr_open');
    // A merge belongs to the payout path, whatever the gate made of it.
    if (subs.rows.some((s) => s.state === 'merged')) return await no('pr_merged');
    const closed = subs.rows.find((s) => s.state === 'closed');
    if (!closed) return await no('no_closed_pr');

    // A holder still marked as having submitted is live again: the webhook
    // does this as the close arrives, and this is the same rule for a close it
    // missed. Their deadline is the one they were given; a closed pull
    // request is not a reason to move it.
    const reset = await client.query(
      `UPDATE bounty_assignments SET status = 'active', updated_at = now()
        WHERE bounty_id = $1 AND status = 'pr_submitted'`,
      [bountyId]);
    const holder = (await client.query<{ github_login: string }>(
      `SELECT github_login FROM bounty_assignments WHERE bounty_id = $1 AND status IN ('active','pr_submitted')`, [bountyId],
    )).rows[0]?.github_login ?? null;
    const holderReset = (reset.rowCount ?? 0) > 0;
    const held = input.hold === true;

    await client.query(
      'UPDATE bounties SET status = \'posted\', awaiting_redraw = awaiting_redraw OR $2, updated_at = now() WHERE id = $1',
      [bountyId, held]);
    await client.query(
      `INSERT INTO audit_log (actor, action, subject, detail) VALUES ($1,'bounty.reopened',$2,$3)`,
      [input.actor, bountyId, JSON.stringify({
        reason: REOPEN_REASON, previousStatus: b.status, prNumber: closed.pr_number, contributor: closed.author_login,
        holder, holderReset, held, source: input.source,
      })]);
    await client.query('COMMIT');
    return { reopened: true, bountyId, prNumber: closed.pr_number, contributor: closed.author_login, holder, holderReset, held };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

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
      applications_close_at: Date | null; waived: string[]; is_test: boolean; funded_by: string | null;
    }>(
      `SELECT b.id, b.status, b.repo_id, r.owner, r.name, b.applications_close_at,
              b.waived_eligibility_rules AS waived, b.is_test, b.funded_by
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
    if (bounty.funded_by) {
      // A funded bounty has no window: applications stay open until the
      // funder assigns it or draws. While somebody holds it there is nothing
      // to apply for.
      if (bounty.funded_by.toLowerCase() === input.githubLogin.toLowerCase()) {
        return { ok: false, status: 403, error: 'own_bounty', detail: 'you funded this bounty, so you cannot apply for it' };
      }
      const held = await this.d.db.query(
        `SELECT 1 FROM bounty_assignments WHERE bounty_id = $1 AND status IN ('active','pr_submitted')`, [input.bountyId]);
      if (held.rowCount) {
        return { ok: false, status: 409, error: 'assigned', detail: 'somebody holds this bounty at the moment, so it is not taking applications' };
      }
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
    await enqueueEvent(this.d.db, {
      kind: 'bounty_application_received',
      githubUserId: input.githubUserId,
      dedupeKey: dedupe.applicationReceived(input.bountyId, input.githubUserId),
      payload: { bountyId: input.bountyId, repo, closesAt: new Date(bounty.applications_close_at).toISOString() },
    });

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
    const r = await this.d.db.query<{
      bounty_id: string; status: string; stale_at: Date; funded: boolean; wallet: string | null; pr: number | null;
      p_id: string | null; p_by: string | null; p_login: string | null; p_reason: string | null; p_status: string | null;
      p_respond_by: Date | null; p_response: string | null;
    }>(
      // On a funded bounty the contributor also needs: which wallet the
      // escrow will pay, and any proposal to end the assignment that is
      // waiting for them or that they made.
      `SELECT a.bounty_id, a.status, a.stale_at, (b.funded_by IS NOT NULL) AS funded, e.contributor_wallet AS wallet,
              a.qualifying_pr_number AS pr,
              p.id AS p_id, p.proposed_by AS p_by, p.proposer_login AS p_login, p.reason AS p_reason, p.status AS p_status,
              p.respond_by AS p_respond_by, p.response AS p_response
         FROM bounty_assignments a
         JOIN bounties b ON b.id = a.bounty_id
         LEFT JOIN bounty_escrows e ON e.bounty_id = b.id AND b.funded_by IS NOT NULL
         LEFT JOIN LATERAL (SELECT * FROM bounty_unassign_proposals x WHERE x.assignment_id = a.id
                             ORDER BY x.created_at DESC LIMIT 1) p ON true
        WHERE a.github_user_id = $1 AND a.status IN ('active','pr_submitted')`,
      [githubUserId],
    );
    return Object.fromEntries(r.rows.map((x) => [x.bounty_id, {
      status: x.status,
      staleAt: new Date(x.stale_at).toISOString(),
      ...(x.funded
        ? {
            funded: {
              wallet: x.wallet,
              prNumber: x.pr,
              proposal: x.p_id
                ? {
                    id: x.p_id, proposedBy: x.p_by, proposerLogin: x.p_login, reason: x.p_reason, status: x.p_status,
                    respondBy: x.p_respond_by ? new Date(x.p_respond_by).toISOString() : null, response: x.p_response,
                  }
                : null,
            },
          }
        : {}),
    }]));
  }

  /**
   * Bounties on repositories this person maintains.
   *
   * "Maintains" is decided by GitHub permission, not by whether the repo is a
   * registered Grainlify project. Those are different questions and the
   * product was answering the wrong one: the maintainer tab filtered the
   * bounty list against the caller's Grainlify projects, so a repository they
   * plainly maintain but have not registered showed nothing at all - which is
   * exactly what the sandbox does, since it is eligible through the test
   * carve-out rather than through registration.
   *
   * Write, maintain or admin on the repo. Read or triage is not maintaining
   * it, and neither is being in the org.
   *
   * One GitHub call per distinct repository with an open bounty, not per
   * bounty: the list is small and the answers are per repo.
   */
  async bountiesForMaintainer(login: string) {
    const r = await this.d.db.query<{ id: string; owner: string; name: string; issue_number: number; funded_by: string | null; status: string; issue_title: string | null }>(
      // A bounty still being funded is the funder's alone to see: it is not
      // public, and the only thing to do with it is finish or abandon funding.
      `SELECT b.id, r.owner, r.name, b.issue_number, b.funded_by, b.status, b.issue_title
         FROM bounties b JOIN repos r ON r.id = b.repo_id
        WHERE b.status IN ('posted','in_review','payable','paid')
           OR (b.status = 'funding' AND lower(b.funded_by) = lower($1))
        ORDER BY b.created_at DESC LIMIT 200`,
      [login],
    );
    const repos = [...new Set(r.rows.map((x) => `${x.owner}/${x.name}`))];
    const allowed = new Set<string>();
    for (const repo of repos) {
      try {
        const perm = await this.d.gh.permission(repo, login);
        if (['admin', 'maintain', 'write'].includes(perm)) allowed.add(repo.toLowerCase());
      } catch {
        // A non-collaborator is a 404 from GitHub, which is the ordinary
        // answer here. Treated as "does not maintain it" rather than as an
        // error, because an error would hide every other repo too.
      }
    }
    return r.rows
      .filter((x) => allowed.has(`${x.owner}/${x.name}`.toLowerCase()) || (x.funded_by ?? '').toLowerCase() === login.toLowerCase())
      .map((x) => ({
        bountyId: x.id, repo: `${x.owner}/${x.name}`, issueNumber: x.issue_number, issueTitle: x.issue_title,
        status: x.status,
        // Which controls apply. A funded bounty is the funder's to run, and
        // the agent's own draw controls refuse it.
        funded: x.funded_by !== null,
        youFunded: (x.funded_by ?? '').toLowerCase() === login.toLowerCase(),
      }));
  }

  /**
   * May this GitHub user run the draw, unassign or move a deadline on this
   * bounty? Write, maintain or admin on the bounty's own repository - the same
   * permissions the payout gate accepts from a merger - or being the person
   * who funded it.
   *
   * Decided per bounty, from the bounty's repository. Never from a repository
   * the caller names: the old maintainer view checked ownership of whatever
   * repo was in the query string and never that the bounty was in it.
   */
  async canManageBounty(bountyId: string, login: string): Promise<{ ok: true; repo: string } | { ok: false; error: 'no_such_bounty' | 'not_your_bounty' }> {
    const b = (await this.d.db.query<{ owner: string; name: string; funded_by: string | null }>(
      `SELECT r.owner, r.name, b.funded_by FROM bounties b JOIN repos r ON r.id = b.repo_id WHERE b.id = $1`,
      [bountyId],
    )).rows[0];
    if (!b) return { ok: false, error: 'no_such_bounty' };
    const repo = `${b.owner}/${b.name}`;
    if (b.funded_by && b.funded_by.toLowerCase() === login.toLowerCase()) return { ok: true, repo };
    try {
      const perm = await this.d.gh.permission(repo, login);
      if (['admin', 'maintain', 'write'].includes(perm)) return { ok: true, repo };
    } catch {
      // Not a collaborator: GitHub answers 404, which means no.
    }
    return { ok: false, error: 'not_your_bounty' };
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

    // What the controls need: who holds it, until when, whether a pull
    // request is in, and whether it is waiting for somebody to redraw. The
    // holder is public already (the public list shows assignedTo).
    const state = (await this.d.db.query<{
      status: string; awaiting_redraw: boolean; github_login: string | null; astatus: string | null;
      stale_at: Date | null; qualifying_pr_number: number | null;
    }>(
      `SELECT b.status, b.awaiting_redraw, a.github_login, a.status AS astatus, a.stale_at, a.qualifying_pr_number
         FROM bounties b
         LEFT JOIN bounty_assignments a ON a.bounty_id = b.id AND a.status IN ('active','pr_submitted')
        WHERE b.id = $1`,
      [bountyId],
    )).rows[0]!;

    const base = {
      bountyId,
      repo: `${row.owner}/${row.name}`,
      issueNumber: row.issue_number,
      bountyStatus: state.status,
      awaitingRedraw: state.awaiting_redraw,
      assignment: state.github_login
        ? {
            githubLogin: state.github_login,
            status: state.astatus,
            staleAt: state.stale_at ? new Date(state.stale_at).toISOString() : null,
            prNumber: state.qualifying_pr_number,
          }
        : null,
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
  async runDrawFor(
    bountyId: string,
    opts: {
      triggeredBy: string; simulate?: boolean; staleHours?: number;
      /** A fixed deadline instead of one computed from hours: a funded bounty's is its escrow deadline. */
      staleAt?: Date;
      /** Only applicants with a live wallet link: a funded draw has to name an address on-chain. */
      requireWallet?: boolean;
    },
  ): Promise<DrawOutcome | { error: string; detail: string }> {
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

    // Somebody we unassigned by decision is kept out of the NEXT draw only.
    // Not as a penalty - their record and their weight are untouched - but
    // because unassigning somebody and handing it straight back to them is a
    // pair of messages that reads as a mistake. They are in every later draw,
    // including a later redraw of this same bounty.
    const excluded = (await this.d.db.query<{ exclude_login_next_draw: string | null }>(
      'SELECT exclude_login_next_draw FROM bounties WHERE id = $1', [bountyId],
    )).rows[0]?.exclude_login_next_draw ?? null;

    const a = await this.d.db.query<{ github_user_id: string; github_login: string; fit: string | null; difficulty_match: string | null }>(
      `SELECT github_user_id, github_login, fit, difficulty_match
         FROM bounty_applications
        WHERE bounty_id = $1 AND status IN ('applied','lost')
          AND ($2::text IS NULL OR lower(github_login) <> lower($2))
          AND (NOT $3::boolean OR EXISTS (SELECT 1 FROM wallet_links w
                                           WHERE w.github_user_id = bounty_applications.github_user_id AND w.revoked_at IS NULL))
        ORDER BY created_at`,
      [bountyId, excluded, opts.requireWallet === true],
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
      const staleHours = opts.staleHours ?? intOf(cfg.assignment_stale_hours, 72);
      const asg = await this.d.db.query<{ id: string; stale_at: Date }>(
        `INSERT INTO bounty_assignments (bounty_id, draw_id, github_user_id, github_login, status, assigned_at, stale_at)
         VALUES ($1,$2,$3,$4,'active',$5,COALESCE($7::timestamptz, $5::timestamptz + ($6 || ' hours')::interval))
         RETURNING id, stale_at`,
        [bountyId, drawId, result.winner.githubUserId, result.winner.githubLogin, now.toISOString(), String(staleHours),
         opts.staleAt ? opts.staleAt.toISOString() : null],
      );
      assignmentId = asg.rows[0]!.id;
      staleAt = new Date(asg.rows[0]!.stale_at).toISOString();
      // Consumed by the draw that honoured it. An exclusion that survived its
      // own draw would keep somebody out of every future one, which is a
      // penalty nobody decided to impose.
      if (excluded) {
        await this.d.db.query('UPDATE bounties SET exclude_login_next_draw = NULL WHERE id = $1', [bountyId]);
      }
      // The redraw somebody was waiting for has happened.
      await this.d.db.query('UPDATE bounties SET awaiting_redraw = false WHERE id = $1 AND awaiting_redraw', [bountyId]);
      await this.d.db.query(
        `UPDATE bounty_applications SET status = CASE WHEN github_user_id = $2 THEN 'won' ELSE 'lost' END, updated_at = now()
          WHERE bounty_id = $1 AND status IN ('applied','lost')`,
        [bountyId, result.winner.githubUserId],
      );

      // Emitted here rather than by the caller, so the message and the
      // assignment are written from the same facts and cannot disagree about
      // who won or when their deadline is.
      const b2 = await this.d.db.query<{ repo: string; issue_number: number; amount_minor: string; currency: string }>(
        `SELECT r.owner||'/'||r.name AS repo, b.issue_number, b.amount_minor::text AS amount_minor, b.currency
           FROM bounties b JOIN repos r ON r.id = b.repo_id WHERE b.id = $1`,
        [bountyId],
      );
      const about = b2.rows[0]!;
      await enqueueEvent(this.d.db, {
        kind: 'bounty_draw_won',
        githubUserId: result.winner.githubUserId,
        dedupeKey: dedupe.drawWon(bountyId, drawId),
        payload: { ...about, bountyId, assignmentId, staleAt, drawId },
      });
      for (const c of result.pool) {
        if (c.githubUserId === result.winner.githubUserId) continue;
        await enqueueEvent(this.d.db, {
          kind: 'bounty_draw_lost',
          githubUserId: c.githubUserId,
          dedupeKey: dedupe.drawLost(bountyId, drawId, c.githubUserId),
          payload: { ...about, bountyId, drawId },
        });
      }
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
  /**
   * End an assignment because somebody decided to, not because a clock ran out.
   *
   * The difference from the stale sweeper is the whole point: nobody went
   * quiet, so no abandon is recorded, the draw weight is untouched, and the
   * application goes back into the pool as it was. What is recorded is who
   * decided and why, because an unassignment without a reason is the kind of
   * thing that should not be possible to do quietly.
   */
  async unassignByDecision(input: { bountyId: string; actor: string; reason: string }) {
    const reason = input.reason.trim();
    if (!reason) return { ok: false as const, error: 'reason_required' };

    const a = await this.d.db.query<{
      id: string; github_user_id: string; github_login: string; status: string;
      repo: string; issue_number: number; amount_minor: string; currency: string;
    }>(
      `SELECT a.id, a.github_user_id, a.github_login, a.status,
              r.owner||'/'||r.name AS repo, b.issue_number, b.amount_minor::text AS amount_minor, b.currency
         FROM bounty_assignments a
         JOIN bounties b ON b.id = a.bounty_id
         JOIN repos r ON r.id = b.repo_id
        WHERE a.bounty_id = $1 AND a.status IN ('active','pr_submitted')`,
      [input.bountyId],
    );
    const asg = a.rows[0];
    if (!asg) return { ok: false as const, error: 'no_active_assignment' };

    // Once a pull request exists this is no longer one person's decision. The
    // funded-bounty rule is that both sides agree, and it applies here too
    // rather than being a thing only funded bounties get.
    if (asg.status === 'pr_submitted') {
      return {
        ok: false as const,
        error: 'pr_open',
        detail: 'a pull request is open, so unassigning needs the contributor to agree as well',
      };
    }

    await this.d.db.query(
      `UPDATE bounty_assignments
          SET status = 'released_voluntary', released_at = now(), release_reason = $2,
              released_by = $3, counts_as_abandon = false, updated_at = now()
        WHERE id = $1`,
      [asg.id, reason, input.actor],
    );
    // Back in the pool exactly as they were. 'lost' rather than removed, so a
    // later draw can see them.
    await this.d.db.query(
      `UPDATE bounty_applications SET status = 'lost', updated_at = now()
        WHERE bounty_id = $1 AND github_login = $2 AND status = 'won'`,
      [input.bountyId, asg.github_login],
    );
    // Waits for a person to press Redraw: without this the sweep redrew within
    // seconds, before anybody could (0014_awaiting_redraw.sql).
    await this.d.db.query(
      'UPDATE bounties SET exclude_login_next_draw = $2, awaiting_redraw = true, updated_at = now() WHERE id = $1',
      [input.bountyId, asg.github_login],
    );
    await this.d.db.query(
      `INSERT INTO audit_log (actor, action, subject, detail) VALUES ($1,'assignment.unassigned',$2,$3)`,
      [input.actor, input.bountyId, JSON.stringify({ assignmentId: asg.id, contributor: asg.github_login, reason })],
    );

    await enqueueEvent(this.d.db, {
      kind: 'bounty_unassigned',
      githubUserId: Number(asg.github_user_id),
      dedupeKey: dedupe.unassigned(asg.id),
      payload: {
        bountyId: input.bountyId, repo: asg.repo, issue_number: asg.issue_number,
        amount_minor: asg.amount_minor, currency: asg.currency, reason, actor: input.actor,
      },
    });

    return { ok: true as const, assignmentId: asg.id, contributor: asg.github_login, reason };
  }

  /**
   * Close a bounty by decision: cancelled, and whoever holds it released as
   * our decision - no abandon, draw weight untouched, told why.
   *
   * One transaction, and the bounty is cancelled in it. Releasing an
   * assignment on a bounty that is still open hands it straight back to the
   * draw sweep, which redraws within seconds: that is what happened to #34,
   * #35 and #36 on 30 September. A cancelled bounty is never drawn again.
   *
   * Only an open bounty can be closed this way. One with a pull request under
   * review, awaiting payout or paid is refused: someone has delivered work,
   * and walking away from that is not a single-sided decision.
   */
  async closeByDecision(input: { bountyId: string; actor: string; reason: string }) {
    const reason = input.reason.trim();
    if (!reason) return { ok: false as const, error: 'reason_required' };

    type Held = { id: string; github_user_id: string; github_login: string; status: string };
    let bounty: { status: string; issue_number: number; amount_minor: string; currency: string; repo: string } | undefined;
    let held: Held | undefined;
    const client = await this.d.db.connect();
    try {
      await client.query('BEGIN');
      bounty = (await client.query(
        `SELECT b.status, b.issue_number, b.amount_minor::text AS amount_minor, b.currency, r.owner||'/'||r.name AS repo
           FROM bounties b JOIN repos r ON r.id = b.repo_id
          WHERE b.id = $1 FOR UPDATE OF b`,
        [input.bountyId],
      )).rows[0];
      if (!bounty) { await client.query('ROLLBACK'); return { ok: false as const, error: 'not_found' }; }
      if (bounty.status !== 'posted') {
        await client.query('ROLLBACK');
        return { ok: false as const, error: 'not_open', detail: `the bounty is ${bounty.status}, not open` };
      }
      held = (await client.query<Held>(
        `SELECT id, github_user_id, github_login, status FROM bounty_assignments
          WHERE bounty_id = $1 AND status IN ('active','pr_submitted') FOR UPDATE`,
        [input.bountyId],
      )).rows[0];
      if (held?.status === 'pr_submitted') {
        await client.query('ROLLBACK');
        return { ok: false as const, error: 'pr_open', detail: 'a pull request is open against this bounty' };
      }

      await client.query(`UPDATE bounties SET status = 'cancelled', updated_at = now() WHERE id = $1`, [input.bountyId]);
      if (held) {
        await client.query(
          `UPDATE bounty_assignments
              SET status = 'released_voluntary', released_at = now(), release_reason = $2,
                  released_by = $3, counts_as_abandon = false, updated_at = now()
            WHERE id = $1`,
          [held.id, reason, input.actor],
        );
        await client.query(
          `UPDATE bounty_applications SET status = 'lost', updated_at = now()
            WHERE bounty_id = $1 AND github_login = $2 AND status = 'won'`,
          [input.bountyId, held.github_login],
        );
      }
      await client.query(
        `INSERT INTO audit_log (actor, action, subject, detail) VALUES ($1,'bounty.closed',$2,$3)`,
        [input.actor, input.bountyId, JSON.stringify({
          previousStatus: bounty.status, assignmentId: held?.id ?? null, contributor: held?.github_login ?? null, reason,
        })],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    // After the commit, not inside it: the enqueue never throws, so a failure
    // inside the transaction would abort it silently. Reported instead.
    let notified = false;
    if (held) {
      notified = await enqueueEvent(this.d.db, {
        kind: 'bounty_unassigned',
        githubUserId: Number(held.github_user_id),
        dedupeKey: dedupe.unassigned(held.id),
        payload: {
          bountyId: input.bountyId, repo: bounty.repo, issue_number: bounty.issue_number,
          amount_minor: bounty.amount_minor, currency: bounty.currency, reason, actor: input.actor,
          // The bounty is gone, so the message must not say the application
          // is back in the pool or mention the next draw.
          closed: true,
        },
      });
    }
    return { ok: true as const, contributor: held?.github_login ?? null, notified };
  }

  /**
   * Tell somebody whose assignment already ended that the round has closed.
   *
   * For holders released before a bounty was closed: they were told their
   * assignment ended, with the reason given then, and nothing since. The
   * message is the closed form of the unassigned notification - the reason
   * alone, nothing about a pool or a next draw - so it reads the same as the
   * one the last holders got. Audited; refuses a live assignment, which
   * closeByDecision is for.
   */
  async tellRoundClosed(input: { assignmentId: string; actor: string; reason: string }) {
    const reason = input.reason.trim();
    if (!reason) return { ok: false as const, error: 'reason_required' };
    const a = (await this.d.db.query<{
      github_user_id: string; github_login: string; status: string; bounty_id: string;
      repo: string; issue_number: number; amount_minor: string; currency: string;
    }>(
      `SELECT a.github_user_id, a.github_login, a.status, a.bounty_id,
              r.owner||'/'||r.name AS repo, b.issue_number, b.amount_minor::text AS amount_minor, b.currency
         FROM bounty_assignments a JOIN bounties b ON b.id = a.bounty_id JOIN repos r ON r.id = b.repo_id
        WHERE a.id = $1`,
      [input.assignmentId],
    )).rows[0];
    if (!a) return { ok: false as const, error: 'not_found' };
    if (['active', 'pr_submitted'].includes(a.status)) return { ok: false as const, error: 'still_assigned' };

    const queued = await enqueueEvent(this.d.db, {
      kind: 'bounty_unassigned',
      githubUserId: Number(a.github_user_id),
      dedupeKey: dedupe.roundClosed(input.assignmentId),
      payload: {
        bountyId: a.bounty_id, repo: a.repo, issue_number: a.issue_number,
        amount_minor: a.amount_minor, currency: a.currency, reason, actor: input.actor, closed: true,
      },
    });
    await this.d.db.query(
      `INSERT INTO audit_log (actor, action, subject, detail) VALUES ($1,'assignment.round_closed_notice',$2,$3)`,
      [input.actor, a.bounty_id, JSON.stringify({ assignmentId: input.assignmentId, contributor: a.github_login, reason, queued })],
    );
    return { ok: true as const, contributor: a.github_login, queued };
  }

  /**
   * Repair a bounty left saying "PR in review" after its pull request closed
   * unmerged: the `bounty reopen` command.
   *
   * GitHub is asked first about any pull request still recorded as open on
   * the bounty, because the close may never have reached us - a webhook that
   * failed, or a closing reference edited out of the PR before it closed.
   * What GitHub says is written to the submission exactly as the webhook would
   * have, and then the same reopen the webhook runs does the rest, with the
   * same record. A pull request that is really open, or was merged, is left
   * alone and named.
   */
  async reopenAfterClosedPullRequest(input: { bountyId: string; actor: string; hold?: boolean }): Promise<
    ReopenOutcome | { reopened: false; bountyId: string; why: 'pr_open' | 'pr_merged'; prNumber: number; refreshed: number[] }
  > {
    const b = (await this.d.db.query<{ repo: string; status: string }>(
      `SELECT r.owner||'/'||r.name AS repo, b.status FROM bounties b JOIN repos r ON r.id = b.repo_id WHERE b.id = $1`, [input.bountyId],
    )).rows[0];
    if (!b) return { reopened: false, bountyId: input.bountyId, why: 'no_such_bounty' };
    // Nothing to repair, and no reason to ask GitHub anything.
    if (b.status !== 'in_review') return { reopened: false, bountyId: input.bountyId, why: 'not_in_review' };
    const repo = b.repo;
    const open = await this.d.db.query<{ pr_number: number }>(
      `SELECT pr_number FROM submissions WHERE bounty_id = $1 AND state = 'open' ORDER BY pr_number`, [input.bountyId]);
    const refreshed: number[] = [];
    for (const s of open.rows) {
      const pr = await this.d.gh.getPull(repo, s.pr_number);
      if (pr.merged) return { reopened: false, bountyId: input.bountyId, why: 'pr_merged', prNumber: s.pr_number, refreshed };
      if (pr.state === 'open') return { reopened: false, bountyId: input.bountyId, why: 'pr_open', prNumber: s.pr_number, refreshed };
      await this.d.db.query(
        `UPDATE submissions SET state = 'closed', head_sha = $3, updated_at = now() WHERE bounty_id = $1 AND pr_number = $2 AND state = 'open'`,
        [input.bountyId, s.pr_number, pr.headSha]);
      refreshed.push(s.pr_number);
    }
    return reopenAfterUnmergedClose(this.d.db, { bountyId: input.bountyId, actor: input.actor, source: 'repair', hold: input.hold });
  }

  /**
   * Move the deadline on a live assignment.
   *
   * Recorded in two places on purpose: the audit log, and a table the
   * contributor's own page reads. A deadline that moved without the person
   * working to it being told is the silent row edit we tell everybody else we
   * do not do.
   */
  async setAssignmentDeadline(input: { bountyId: string; newAt: Date; actor: string; reason: string }) {
    const reason = input.reason.trim();
    if (!reason) return { ok: false as const, error: 'reason_required' };
    if (Number.isNaN(input.newAt.getTime())) return { ok: false as const, error: 'bad_deadline' };
    if (input.newAt <= this.d.now()) return { ok: false as const, error: 'deadline_in_past' };

    const a = await this.d.db.query<{
      id: string; github_user_id: string; stale_at: Date;
      repo: string; issue_number: number; amount_minor: string; currency: string;
    }>(
      `SELECT a.id, a.github_user_id, a.stale_at,
              r.owner||'/'||r.name AS repo, b.issue_number, b.amount_minor::text AS amount_minor, b.currency
         FROM bounty_assignments a
         JOIN bounties b ON b.id = a.bounty_id
         JOIN repos r ON r.id = b.repo_id
        WHERE a.bounty_id = $1 AND a.status IN ('active','pr_submitted')`,
      [input.bountyId],
    );
    const asg = a.rows[0];
    if (!asg) return { ok: false as const, error: 'no_active_assignment' };

    const previous = new Date(asg.stale_at);
    await this.d.db.query('UPDATE bounty_assignments SET stale_at = $2, updated_at = now() WHERE id = $1',
      [asg.id, input.newAt.toISOString()]);
    await this.d.db.query(
      `INSERT INTO bounty_deadline_changes (assignment_id, previous_at, new_at, reason, changed_by)
       VALUES ($1,$2,$3,$4,$5)`,
      [asg.id, previous.toISOString(), input.newAt.toISOString(), reason, input.actor],
    );
    await this.d.db.query(
      `INSERT INTO audit_log (actor, action, subject, detail) VALUES ($1,'assignment.deadline_changed',$2,$3)`,
      [input.actor, input.bountyId, JSON.stringify({ assignmentId: asg.id, from: previous.toISOString(), to: input.newAt.toISOString(), reason })],
    );

    await enqueueEvent(this.d.db, {
      kind: 'bounty_deadline_changed',
      githubUserId: Number(asg.github_user_id),
      dedupeKey: dedupe.deadlineChanged(asg.id, input.newAt.toISOString()),
      payload: {
        bountyId: input.bountyId, repo: asg.repo, issue_number: asg.issue_number,
        amount_minor: asg.amount_minor, currency: asg.currency,
        previousAt: previous.toISOString(), staleAt: input.newAt.toISOString(), reason, actor: input.actor,
      },
    });

    return { ok: true as const, assignmentId: asg.id, previousAt: previous.toISOString(), staleAt: input.newAt.toISOString() };
  }

  /**
   * Mark every live assignment whose holder has an open pull request on the
   * bounty as having submitted one.
   *
   * The PR webhook does this as the PR arrives (service.onPullRequestActivity);
   * this catches anything it missed. It once missed everything: the webhook
   * moved the bounty to in_review and never touched the assignment, so the
   * holder of #35, with PR #37 open, was on course for an expiry warning and
   * then a stale release with an abandon. Keyed on GitHub user id, which
   * survives a rename, and idempotent.
   */
  async recordSubmittedPullRequests(): Promise<{ bountyId: string; githubLogin: string; prNumber: number }[]> {
    const r = await this.d.db.query<{ id: string; bounty_id: string; github_login: string; pr_number: number }>(
      `UPDATE bounty_assignments a
          SET status = 'pr_submitted', qualifying_pr_number = s.pr_number, updated_at = now()
         FROM submissions s
        WHERE a.status = 'active'
          AND s.bounty_id = a.bounty_id
          AND s.author_github_user_id = a.github_user_id
          AND s.state = 'open'
      RETURNING a.id, a.bounty_id, a.github_login, s.pr_number`,
    );
    for (const x of r.rows) {
      await this.d.db.query(
        `INSERT INTO audit_log (actor, action, subject, detail) VALUES ('agent','assignment.pr_recorded',$1,$2)`,
        [x.bounty_id, JSON.stringify({ assignmentId: x.id, contributor: x.github_login, prNumber: x.pr_number, source: 'sweep' })],
      );
    }
    return r.rows.map((x) => ({ bountyId: x.bounty_id, githubLogin: x.github_login, prNumber: x.pr_number }));
  }

  async releaseStaleAssignments(): Promise<{ released: { bountyId: string; githubLogin: string }[]; warned: string[] }> {
    // First, so nothing below can mistake somebody who answered for somebody
    // who went quiet.
    await this.recordSubmittedPullRequests();

    // The warning is computed HERE, from the same stale_at and the same clock
    // that decide the release. Put anywhere else, the two could disagree - and
    // a warning that says "24 hours left" about an assignment released an hour
    // ago is worse than no warning.
    const cfg = await this.config();
    const warnHours = intOf(cfg.assignment_expiry_warning_hours, 24);
    const soon = await this.d.db.query<{
      id: string; bounty_id: string; github_user_id: string; stale_at: Date;
      repo: string; issue_number: number; amount_minor: string; currency: string;
    }>(
      `SELECT a.id, a.bounty_id, a.github_user_id, a.stale_at,
              r.owner||'/'||r.name AS repo, b.issue_number, b.amount_minor::text AS amount_minor, b.currency
         FROM bounty_assignments a
         JOIN bounties b ON b.id = a.bounty_id
         JOIN repos r ON r.id = b.repo_id
        WHERE a.status = 'active'
          -- A funded bounty's assignment has no clock of its own: before a
          -- pull request the funder ends it, after one the escrow deadline
          -- decides. Nobody is warned or released here for those.
          AND b.funded_by IS NULL
          AND a.stale_at > $1
          AND a.stale_at <= $1::timestamptz + ($2 || ' hours')::interval
          -- Never "open a pull request" to somebody who has one open.
          AND NOT EXISTS (SELECT 1 FROM submissions s
                           WHERE s.bounty_id = a.bounty_id AND s.author_github_user_id = a.github_user_id
                             AND s.state = 'open')`,
      [this.d.now().toISOString(), String(warnHours)],
    );
    const warned: string[] = [];
    for (const x of soon.rows) {
      const hoursLeft = Math.max(1, Math.round((new Date(x.stale_at).getTime() - this.d.now().getTime()) / 3600_000));
      const fresh = await enqueueEvent(this.d.db, {
        kind: 'bounty_assignment_expiring',
        githubUserId: Number(x.github_user_id),
        // Keyed to the assignment, so a sweep running every minute for a day
        // warns once rather than fourteen hundred times.
        dedupeKey: dedupe.assignmentExpiring(x.id),
        payload: {
          bountyId: x.bounty_id, repo: x.repo, issue_number: x.issue_number,
          amount_minor: x.amount_minor, currency: x.currency,
          staleAt: new Date(x.stale_at).toISOString(), hoursLeft,
        },
      });
      if (fresh) warned.push(x.bounty_id);
    }

    const r = await this.d.db.query<{ bounty_id: string; github_login: string }>(
      // Nobody who opened a pull request on the bounty is ever counted as
      // having abandoned it: not while it is open (they are not released at
      // all), and not if it was closed unmerged and the deadline then passed
      // (released, but with no abandon, and the reason says so).
      `UPDATE bounty_assignments a
          SET status = 'released_stale',
              released_at = $1,
              release_reason = CASE WHEN EXISTS (SELECT 1 FROM submissions s
                                                  WHERE s.bounty_id = a.bounty_id AND s.author_github_user_id = a.github_user_id)
                                    THEN 'deadline passed after their pull request was closed unmerged'
                                    ELSE 'no pull request before the deadline' END,
              counts_as_abandon = NOT EXISTS (SELECT 1 FROM submissions s
                                               WHERE s.bounty_id = a.bounty_id AND s.author_github_user_id = a.github_user_id),
              updated_at = now()
        WHERE a.status = 'active' AND a.stale_at <= $1
          AND NOT EXISTS (SELECT 1 FROM bounties fb WHERE fb.id = a.bounty_id AND fb.funded_by IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM submissions s
                           WHERE s.bounty_id = a.bounty_id AND s.author_github_user_id = a.github_user_id
                             AND s.state = 'open')
      RETURNING a.bounty_id, a.github_login`,
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
    return { released: r.rows.map((x) => ({ bountyId: x.bounty_id, githubLogin: x.github_login })), warned };
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
          -- Unassigned by somebody, and waiting for them to redraw it.
          AND NOT b.awaiting_redraw
          -- The funder draws a funded bounty, when they choose. Never this.
          AND b.funded_by IS NULL
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
