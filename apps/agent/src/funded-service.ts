// Maintainer-funded bounties: from locking the money to a disputed unassignment.
//
// # Who decides what
//
// The funder runs their own bounty. They choose how it is assigned when they
// fund it, and then either pick an applicant (self-assign) or run the draw
// whenever there is at least one applicant (draw). No admin is involved in any
// of that, and nothing here touches GrainHack, which stays admin-run.
//
// Before a pull request exists the funder can unassign freely; the count of
// those goes on their public profile. Once one is open it takes both sides:
// either proposes, the other accepts or refuses, and silence for seven days
// counts as accepting. A refusal marks it disputed and changes nothing else -
// the escrow deadline still decides, and an admin looks only if asked.
//
// # What the chain enforces and what only we do
//
// In draw mode the attestor (Grainlify) signs assign and unassign, so the
// two-sided rule is enforced: we do not sign an unassignment both sides have
// not agreed to. In self-assign mode the funder signs them, and can unassign
// on-chain without us. We cannot stop that; `reconcile` notices it and
// records it as exactly that, rather than pretending it was agreed.
//
// The money is the program's business, not this file's. Nothing here can move
// it: funding is the funder's signature, release goes through the human payout
// approval, and refund is the funder's alone after the deadline.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { PublicKey } from '@solana/web3.js';
import type { DrawService } from './draw-service.ts';
import type { AssignmentMode, EscrowService } from './escrow-service.ts';
import { dedupe, enqueueEvent } from './events.ts';
import type { GitHubApi } from './github.ts';
import { formatAmount } from './config.ts';

/** The attestor's two non-monetary signatures, in draw mode. Lives with the payout signer. */
export interface Attestor {
  assign(escrow: string, contributorWallet: string): Promise<{ ok: true; signature: string } | { ok: false; error: string }>;
  unassign(escrow: string): Promise<{ ok: true; signature: string } | { ok: false; error: string }>;
}

export interface FundedDeps {
  db: pg.Pool;
  gh: GitHubApi;
  draw: DrawService;
  escrow: EscrowService;
  /** Absent until the attestor key is set up; draw-mode actions then refuse rather than half-happen. */
  attestor?: Attestor;
  /** The payout caps, per currency. A funded bounty can be no larger than the largest payout the signer would approve. */
  caps: Record<string, { perBountyMaxMinor: bigint }>;
  /** Where a contributor applies, for the GitHub comment. */
  bountyPageUrl?: (bountyId: string) => string;
  now?: () => Date;
}

/** A deadline shorter than this leaves no room for the seven-day reply window once a pull request is open. */
export const MIN_DEADLINE_DAYS = 7;
export const MAX_DEADLINE_DAYS = 120;
/** How long the other side has to answer a proposal to unassign. Silence counts as accepting. */
export const RESPOND_DAYS = 7;
/** How long after we prepare a funder's transaction a chain change is taken to be that transaction. */
const PREPARED_WINDOW_MS = 30 * 60_000;
const WRITE = ['admin', 'maintain', 'write'];

export type Fail = { ok: false; status: number; error: string; detail: string };
const fail = (status: number, error: string, detail: string): Fail => ({ ok: false, status, error, detail });

interface FundedRow {
  id: string;
  status: string;
  repo: string;
  issue_number: number;
  issue_title: string | null;
  amount_minor: string;
  currency: string;
  mint: string;
  network: string;
  funded_by: string;
  funded_by_github_user_id: string | null;
  exclude_login_next_draw: string | null;
  escrow_id: string;
  escrow_pubkey: string;
  funder_wallet: string;
  contributor_wallet: string | null;
  assignment_mode: AssignmentMode;
  escrow_state: string;
  deadline_at: Date;
  fee_amount_minor: string;
  fund_tx: string | null;
}

interface LiveAssignment {
  id: string;
  github_user_id: string;
  github_login: string;
  status: string;
  assigned_at: Date;
  qualifying_pr_number: number | null;
}

export class FundedService {
  private readonly now: () => Date;
  constructor(private readonly d: FundedDeps) {
    this.now = d.now ?? (() => new Date());
  }

  // ------------------------------------------------------------ helpers

  private async audit(actor: string, action: string, subject: string, detail: Record<string, unknown>) {
    await this.d.db.query('INSERT INTO audit_log (actor, action, subject, detail) VALUES ($1,$2,$3,$4)',
      [actor, action, subject, JSON.stringify(detail)]);
  }

  private async escrowEvent(escrowId: string, kind: string, tx: string | null, detail: Record<string, unknown>) {
    await this.d.db.query('INSERT INTO bounty_escrow_events (escrow_id, kind, tx, detail) VALUES ($1,$2,$3,$4)',
      [escrowId, kind, tx, JSON.stringify(detail)]);
  }

  private async row(bountyId: string): Promise<FundedRow | null> {
    const r = await this.d.db.query<FundedRow>(
      `SELECT b.id, b.status, r.owner||'/'||r.name AS repo, b.issue_number, b.issue_title, b.amount_minor::text AS amount_minor,
              b.currency, b.mint, b.network, b.funded_by, b.funded_by_github_user_id::text AS funded_by_github_user_id,
              b.exclude_login_next_draw,
              e.id AS escrow_id, e.escrow_pubkey, e.funder_wallet, e.contributor_wallet, e.assignment_mode,
              e.state AS escrow_state, e.deadline_at, e.fee_amount_minor::text AS fee_amount_minor, e.fund_tx
         FROM bounties b
         JOIN repos r ON r.id = b.repo_id
         JOIN bounty_escrows e ON e.bounty_id = b.id
        WHERE b.id = $1 AND b.funded_by IS NOT NULL`,
      [bountyId],
    );
    return r.rows[0] ?? null;
  }

  /** The bounty, if it is funded and this person funded it. Repository maintainers who did not fund it do not run it. */
  private async asFunder(bountyId: string, login: string): Promise<FundedRow | Fail> {
    const b = await this.row(bountyId);
    if (!b) return fail(404, 'not_a_funded_bounty', 'that is not a funded bounty');
    if (!(await this.d.escrow.enabledFor(login))) return fail(403, 'funded_bounties_disabled', 'funded bounties are switched off');
    if (b.funded_by.toLowerCase() !== login.toLowerCase()) {
      return fail(403, 'not_the_funder', `only ${b.funded_by}, who funded this bounty, can run it`);
    }
    return b;
  }

  private async live(bountyId: string): Promise<LiveAssignment | null> {
    const r = await this.d.db.query<LiveAssignment>(
      `SELECT id, github_user_id::text AS github_user_id, github_login, status, assigned_at, qualifying_pr_number
         FROM bounty_assignments WHERE bounty_id = $1 AND status IN ('active','pr_submitted')`, [bountyId]);
    return r.rows[0] ?? null;
  }

  private async walletOf(githubUserId: number | string): Promise<string | null> {
    const r = await this.d.db.query<{ address: string }>(
      'SELECT address FROM wallet_links WHERE github_user_id = $1 AND revoked_at IS NULL', [githubUserId]);
    return r.rows[0]?.address ?? null;
  }

  private decimals(b: { currency: string }) {
    return this.d.escrow.mints()[b.currency]?.decimals ?? 6;
  }

  // ------------------------------------------------------------ funding

  /**
   * Build the funding transaction for the funder's wallet to sign.
   *
   * The bounty row is created here, in 'funding', because the escrow address
   * is derived from its id. It is never listed and never takes applications
   * until `confirm` has read the funding from the chain.
   */
  async prepare(input: {
    login: string; githubUserId: number; repo: string; issueNumber: number; amountMinor: bigint; currency: string;
    mode: AssignmentMode; deadline: Date; funderWallet: string; verifiedProject: boolean;
  }) {
    if (!(await this.d.escrow.enabledFor(input.login))) return fail(403, 'funded_bounties_disabled', 'funded bounties are switched off');
    // Grainlify's answer, signed into the request by the backend: is this a
    // project registered and verified there? The agent cannot see that table.
    if (!input.verifiedProject) {
      return fail(403, 'not_a_verified_project', `${input.repo} is not a verified Grainlify project. Register and verify it first.`);
    }
    const [owner, name] = input.repo.split('/');
    if (!owner || !name) return fail(400, 'bad_repo', 'the repository must be owner/name');

    let perm = 'none';
    try { perm = await this.d.gh.permission(input.repo, input.login); } catch { /* not a collaborator */ }
    if (!WRITE.includes(perm)) return fail(403, 'not_your_repo', `you need write access to ${input.repo} to fund a bounty on it`);

    let installationId: number;
    try { installationId = await this.d.gh.installationIdFor(input.repo); } catch {
      return fail(403, 'app_not_installed', `the Grainlify GitHub App is not installed on ${input.repo}`);
    }
    let issue: { title: string; state: string };
    try { issue = await this.d.gh.getIssue(input.repo, input.issueNumber); } catch {
      return fail(404, 'no_such_issue', `${input.repo} has no issue #${input.issueNumber}`);
    }
    if (issue.state !== 'open') return fail(409, 'issue_closed', `issue #${input.issueNumber} is closed`);

    const mint = this.d.escrow.mints()[input.currency];
    if (!mint) return fail(400, 'currency_not_available', `${input.currency} is not available for funded bounties on ${this.d.escrow.network()}`);
    const cap = this.d.caps[input.currency]?.perBountyMaxMinor ?? 0n;
    if (input.amountMinor <= 0n) return fail(400, 'bad_amount', 'the amount must be more than zero');
    if (input.amountMinor > cap) {
      return fail(400, 'over_cap', `funded bounties are capped at ${formatAmount(cap, mint.decimals, input.currency)} for now`);
    }
    const days = (input.deadline.getTime() - this.now().getTime()) / 86_400_000;
    if (!Number.isFinite(days) || days < MIN_DEADLINE_DAYS || days > MAX_DEADLINE_DAYS) {
      return fail(400, 'bad_deadline', `the deadline must be between ${MIN_DEADLINE_DAYS} and ${MAX_DEADLINE_DAYS} days away`);
    }
    try { new PublicKey(input.funderWallet); } catch { return fail(400, 'bad_wallet', 'that is not a Solana address'); }

    // The repository row. An admin who switched it off meant it; funding does
    // not switch it back on.
    const existingRepo = await this.d.db.query<{ id: string; enabled: boolean }>(
      'SELECT id, enabled FROM repos WHERE lower(owner) = lower($1) AND lower(name) = lower($2)', [owner, name]);
    let repoId: string;
    if (existingRepo.rows[0]) {
      if (!existingRepo.rows[0].enabled) return fail(403, 'repo_disabled', `${input.repo} has been switched off for bounties`);
      repoId = existingRepo.rows[0].id;
    } else {
      const ins = await this.d.db.query<{ id: string }>(
        `INSERT INTO repos (owner, name, installation_id, enabled, registered_project) VALUES ($1,$2,$3,true,true) RETURNING id`,
        [owner, name, installationId]);
      repoId = ins.rows[0]!.id;
      await this.audit(input.login, 'repo.added_for_funding', input.repo, { installationId });
    }

    const open = await this.d.db.query<{ id: string; status: string; funded_by: string | null }>(
      `SELECT id, status, funded_by FROM bounties WHERE repo_id = $1 AND issue_number = $2 AND status NOT IN ('paid','cancelled','expired')`,
      [repoId, input.issueNumber]);
    let bountyId: string;
    const prior = open.rows[0];
    if (prior) {
      // Only an unfinished funding by the same person can be picked up again.
      if (prior.status !== 'funding' || (prior.funded_by ?? '').toLowerCase() !== input.login.toLowerCase()) {
        return fail(409, 'issue_has_bounty', `issue #${input.issueNumber} already has a bounty`);
      }
      bountyId = prior.id;
      await this.d.db.query(
        `UPDATE bounties SET amount_minor = $2, currency = $3, mint = $4, network = $5, issue_title = $6, updated_at = now() WHERE id = $1`,
        [bountyId, input.amountMinor.toString(), input.currency, mint.mint, this.d.escrow.network(), issue.title.slice(0, 300)]);
    } else {
      bountyId = randomUUID();
      await this.d.db.query(
        `INSERT INTO bounties (id, repo_id, issue_number, issue_title, amount_minor, currency, mint, network, status,
                               created_by, funded_by, funded_by_github_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'funding',$9,$9,$10)`,
        [bountyId, repoId, input.issueNumber, issue.title.slice(0, 300), input.amountMinor.toString(), input.currency,
         mint.mint, this.d.escrow.network(), input.login, input.githubUserId]);
    }

    const p = await this.d.escrow.prepareFunding({
      bountyId, funderWallet: input.funderWallet, mint: mint.mint, currency: input.currency, network: this.d.escrow.network(),
      amountMinor: input.amountMinor, deadline: input.deadline, mode: input.mode, createdBy: input.login,
    });
    if (!p.ok) return fail(409, p.error, 'detail' in p ? String(p.detail) : p.error);
    await this.audit(input.login, 'bounty.funding_prepared', bountyId, {
      repo: input.repo, issueNumber: input.issueNumber, amount: input.amountMinor.toString(), currency: input.currency,
      mode: input.mode, deadline: input.deadline.toISOString(), escrow: p.escrow,
    });
    return {
      ok: true as const,
      bountyId,
      escrow: p.escrow,
      transaction: p.transaction,
      amountMinor: p.quote.amountMinor.toString(),
      feeAmountMinor: p.quote.feeAmountMinor.toString(),
      totalMinor: p.quote.totalMinor.toString(),
      decimals: mint.decimals,
      network: this.d.escrow.network(),
    };
  }

  /**
   * The funding happened: the chain says so. Only now does the bounty appear.
   * Safe to call twice: a funder whose page closed after signing comes back
   * and presses Confirm again.
   */
  async confirm(bountyId: string, login: string, signature: string) {
    const b = await this.asFunder(bountyId, login);
    if ('ok' in b) return b;
    if (b.status !== 'funding') return { ok: true as const, bountyId, state: b.escrow_state, already: true };
    const r = await this.d.escrow.confirmFunding(bountyId, signature);
    if (!r.ok) return fail(409, r.error, r.error === 'escrow_not_on_chain' ? 'the funding has not reached the chain yet; wait a moment and confirm again' : r.error);

    const opened = await this.d.db.query(
      `UPDATE bounties SET status = 'posted', applications_open_at = $2, applications_close_at = $3, updated_at = now()
        WHERE id = $1 AND status = 'funding' RETURNING id`,
      [bountyId, this.now().toISOString(), new Date(b.deadline_at).toISOString()]);
    if (opened.rowCount) {
      await this.audit(login, 'bounty.funded', bountyId, { escrow: b.escrow_pubkey, tx: signature });
      await this.announce(b).catch((e) => console.log(`funded bounty comment failed, continuing: ${String(e)}`));
    }
    return { ok: true as const, bountyId, state: 'funded', already: false };
  }

  /** The issue comment that tells people the bounty exists. The page is the source of truth; this points at it. */
  private async announce(b: FundedRow) {
    const amount = formatAmount(BigInt(b.amount_minor), this.decimals(b), b.currency);
    const deadline = new Date(b.deadline_at).toISOString().slice(0, 10);
    const test = b.network === 'solana-mainnet' ? '' : `\n\n> **Test bounty on ${b.network}.** It pays test tokens with no real value.`;
    const how = b.assignment_mode === 'draw'
      ? `**How it is assigned:** @${b.funded_by} runs a weighted draw when they choose, from everyone who has applied. Applications stay open until then.`
      : `**How it is assigned:** @${b.funded_by} picks the contributor from the applicants. They can also unassign you on-chain without Grainlify's agreement; the money still cannot leave the escrow before ${deadline}.`;
    const page = this.d.bountyPageUrl?.(b.id) ?? 'https://grainlify.com/bounties';
    const body = [
      `### Funded bounty: ${amount}`,
      test,
      `\nFunded by @${b.funded_by}, held in an on-chain escrow they locked before this bounty appeared: \`${b.escrow_pubkey}\` (${b.network}).`,
      `\n${how}`,
      `\n**Apply:** ${page}`,
      `\nWhen the assigned contributor's pull request is merged, the release goes to a human for approval, then to their wallet. If it is not merged by ${deadline}, the funder can take the escrow back.`,
    ].join('\n');
    const c = await this.d.gh.comment(b.repo, b.issue_number, body);
    await this.d.db.query('UPDATE bounties SET comment_id = $2 WHERE id = $1', [b.id, c.id]);
  }

  // ------------------------------------------------------------ the funder's view

  async view(bountyId: string, login: string) {
    const b = await this.asFunder(bountyId, login);
    if ('ok' in b) return b;
    const asg = await this.live(bountyId);
    const apps = await this.d.db.query<{
      github_user_id: string; github_login: string; status: string; fit: string | null; created_at: Date;
      completions: number; abandons: number; prior: number; has_wallet: boolean;
    }>(
      `SELECT ap.github_user_id::text AS github_user_id, ap.github_login, ap.status, ap.fit, ap.created_at,
              (SELECT count(*) FROM bounty_assignments x WHERE x.github_user_id = ap.github_user_id AND x.status = 'completed')::int AS completions,
              (SELECT count(*) FROM bounty_assignments x WHERE x.github_user_id = ap.github_user_id AND x.counts_as_abandon)::int AS abandons,
              (SELECT count(*) FROM bounty_applications y WHERE y.github_user_id = ap.github_user_id AND y.bounty_id <> ap.bounty_id)::int AS prior,
              EXISTS (SELECT 1 FROM wallet_links w WHERE w.github_user_id = ap.github_user_id AND w.revoked_at IS NULL) AS has_wallet
         FROM bounty_applications ap
        WHERE ap.bounty_id = $1 AND ap.status IN ('applied','won','lost')
        ORDER BY ap.created_at`,
      [bountyId]);
    const proposal = asg
      ? (await this.d.db.query(
          `SELECT id, proposed_by, proposer_login, reason, respond_by, status, response, responded_at, carried_out_at, created_at
             FROM bounty_unassign_proposals WHERE assignment_id = $1 ORDER BY created_at DESC LIMIT 1`, [asg.id])).rows[0] ?? null
      : null;
    const total = BigInt(b.amount_minor) + BigInt(b.fee_amount_minor);
    const eligible = apps.rows.filter((a) => a.status !== 'won' && a.has_wallet).length;
    return {
      ok: true as const,
      bountyId,
      repo: b.repo,
      issueNumber: b.issue_number,
      issueTitle: b.issue_title,
      bountyStatus: b.status,
      mode: b.assignment_mode,
      escrow: {
        address: b.escrow_pubkey,
        network: b.network,
        state: b.escrow_state,
        funderWallet: b.funder_wallet,
        contributorWallet: b.contributor_wallet,
        amountMinor: b.amount_minor,
        feeAmountMinor: b.fee_amount_minor,
        totalMinor: total.toString(),
        currency: b.currency,
        decimals: this.decimals(b),
        deadlineAt: new Date(b.deadline_at).toISOString(),
        fundTx: b.fund_tx,
      },
      applicants: apps.rows.map((a) => ({
        githubLogin: a.github_login,
        status: a.status,
        fit: a.fit,
        appliedAt: new Date(a.created_at).toISOString(),
        completions: a.completions,
        abandons: a.abandons,
        firstApplication: a.prior === 0,
        // An applicant without a linked wallet cannot be named on-chain.
        assignable: a.has_wallet && !asg && a.status !== 'won',
      })),
      assignment: asg
        ? {
            githubLogin: asg.github_login,
            status: asg.status,
            assignedAt: new Date(asg.assigned_at).toISOString(),
            prNumber: asg.qualifying_pr_number,
            prOpen: asg.status === 'pr_submitted',
            wallet: b.contributor_wallet,
            // In draw mode an assignment can exist here a moment before the
            // attestor has signed it on-chain; the page says so.
            onChain: b.escrow_state === 'assigned',
          }
        : null,
      proposal: proposal
        ? {
            id: proposal.id,
            proposedBy: proposal.proposed_by,
            proposerLogin: proposal.proposer_login,
            reason: proposal.reason,
            respondBy: new Date(proposal.respond_by).toISOString(),
            status: proposal.status,
            response: proposal.response,
            respondedAt: proposal.responded_at ? new Date(proposal.responded_at).toISOString() : null,
            // Agreed, but in self-assign mode the funder still signs it.
            awaitingFunderSignature: ['accepted', 'accepted_by_silence'].includes(proposal.status) && !proposal.carried_out_at,
          }
        : null,
      canDraw: b.assignment_mode === 'draw' && !asg && b.status === 'posted' && eligible > 0 && this.d.attestor !== undefined,
      drawUnavailableReason: b.assignment_mode !== 'draw' ? null
        : this.d.attestor === undefined ? 'The draw needs Grainlify\'s attestor key, which is not set up yet.'
        : eligible === 0 ? 'Nobody with a linked wallet has applied yet.' : null,
      profile: await this.profile(b.funded_by),
    };
  }

  // ------------------------------------------------------------ assigning

  /** Self-assign: the unsigned transaction naming this applicant, for the funder's wallet. */
  async assignPrepare(bountyId: string, login: string, applicantLogin: string) {
    const b = await this.asFunder(bountyId, login);
    if ('ok' in b) return b;
    if (b.assignment_mode !== 'self_assign') return fail(409, 'draw_mode', 'this bounty is assigned by the draw; run the draw instead');
    if (b.status !== 'posted') return fail(409, 'not_open', `this bounty is ${b.status}`);
    if (await this.live(bountyId)) return fail(409, 'already_assigned', 'somebody holds this bounty; unassign them first');
    if (b.escrow_state !== 'funded') return fail(409, 'escrow_not_ready', `the escrow is ${b.escrow_state}`);
    const app = (await this.d.db.query<{ github_user_id: string; github_login: string }>(
      `SELECT github_user_id::text AS github_user_id, github_login FROM bounty_applications
        WHERE bounty_id = $1 AND lower(github_login) = lower($2) AND status IN ('applied','lost')`,
      [bountyId, applicantLogin])).rows[0];
    if (!app) return fail(404, 'not_an_applicant', `${applicantLogin} has not applied for this bounty`);
    const wallet = await this.walletOf(app.github_user_id);
    if (!wallet) return fail(409, 'no_linked_wallet', `${app.github_login} has no linked wallet, so the escrow cannot name them`);
    const transaction = await this.d.escrow.funderAssignTransaction(b.escrow_pubkey, b.funder_wallet, wallet);
    await this.escrowEvent(b.escrow_id, 'assign_prepared', null, { contributor: app.github_login, wallet, by: login });
    return { ok: true as const, transaction, contributor: app.github_login, wallet, funderWallet: b.funder_wallet };
  }

  /** Self-assign, after the funder signed: believe the chain, then record it. */
  async assignConfirm(bountyId: string, login: string, applicantLogin: string, signature: string) {
    const b = await this.asFunder(bountyId, login);
    if ('ok' in b) return b;
    const app = (await this.d.db.query<{ github_user_id: string; github_login: string }>(
      `SELECT github_user_id::text AS github_user_id, github_login FROM bounty_applications
        WHERE bounty_id = $1 AND lower(github_login) = lower($2)`, [bountyId, applicantLogin])).rows[0];
    if (!app) return fail(404, 'not_an_applicant', `${applicantLogin} has not applied for this bounty`);
    const existing = await this.live(bountyId);
    if (existing) {
      return existing.github_user_id === app.github_user_id
        ? { ok: true as const, contributor: existing.github_login, already: true }
        : fail(409, 'already_assigned', `${existing.github_login} holds this bounty`);
    }
    const chain = await this.d.escrow.readChain(b.escrow_pubkey);
    const wallet = await this.walletOf(app.github_user_id);
    if (!chain || chain.state !== 'Assigned' || !wallet || chain.contributor?.toBase58() !== wallet) {
      return fail(409, 'not_assigned_on_chain', 'the escrow does not name this contributor yet; wait a moment and confirm again');
    }
    await this.recordAssignment(b, app, wallet, signature, login);
    return { ok: true as const, contributor: app.github_login, already: false };
  }

  private async recordAssignment(b: FundedRow, app: { github_user_id: string; github_login: string }, wallet: string, tx: string | null, actor: string) {
    const asg = await this.d.db.query<{ id: string }>(
      `INSERT INTO bounty_assignments (bounty_id, github_user_id, github_login, status, assigned_at, stale_at)
       VALUES ($1,$2,$3,'active',$4,$5) RETURNING id`,
      [b.id, app.github_user_id, app.github_login, this.now().toISOString(), new Date(b.deadline_at).toISOString()]);
    const assignmentId = asg.rows[0]!.id;
    await this.d.db.query(
      `UPDATE bounty_applications SET status = 'won', updated_at = now() WHERE bounty_id = $1 AND github_user_id = $2`,
      [b.id, app.github_user_id]);
    await this.d.escrow.recordAssigned(b.id, wallet, tx);
    await this.audit(actor, 'assignment.funder_assigned', b.id, { assignmentId, contributor: app.github_login, wallet, tx });
    await enqueueEvent(this.d.db, {
      kind: 'bounty_funded_assigned',
      githubUserId: Number(app.github_user_id),
      dedupeKey: dedupe.fundedAssigned(assignmentId),
      payload: {
        bountyId: b.id, repo: b.repo, issue_number: b.issue_number, amount_minor: b.amount_minor, currency: b.currency,
        funder: b.funded_by, deadlineAt: new Date(b.deadline_at).toISOString(), wallet,
      },
    });
    return assignmentId;
  }

  /**
   * Draw mode: the funder runs the draw whenever there is somebody to draw.
   * The same weighted draw as every other bounty; the funder chooses when,
   * never who.
   */
  async runDraw(bountyId: string, login: string, simulate: boolean) {
    const b = await this.asFunder(bountyId, login);
    if ('ok' in b) return b;
    if (b.assignment_mode !== 'draw') return fail(409, 'self_assign_mode', 'you assign this bounty yourself; there is no draw');
    if (b.status !== 'posted') return fail(409, 'not_open', `this bounty is ${b.status}`);
    if (await this.live(bountyId)) return fail(409, 'already_assigned', 'somebody holds this bounty; unassign them first');
    if (!simulate && !this.d.attestor) return fail(503, 'attestor_not_configured', 'the draw needs Grainlify\'s attestor key, which is not set up yet');
    if (!simulate && b.escrow_state !== 'funded') return fail(409, 'escrow_not_ready', `the escrow is ${b.escrow_state}`);
    const pool = await this.d.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM bounty_applications ap
        WHERE ap.bounty_id = $1 AND ap.status IN ('applied','lost')
          AND ($2::text IS NULL OR lower(ap.github_login) <> lower($2))
          AND EXISTS (SELECT 1 FROM wallet_links w WHERE w.github_user_id = ap.github_user_id AND w.revoked_at IS NULL)`,
      [bountyId, b.exclude_login_next_draw]);
    if ((pool.rows[0]?.n ?? 0) === 0) {
      return fail(409, 'no_applicants', 'nobody with a linked wallet is waiting to be drawn yet');
    }

    const r = await this.d.draw.runDrawFor(bountyId, { triggeredBy: login, simulate, staleAt: new Date(b.deadline_at), requireWallet: true });
    if ('error' in r) return fail(409, r.error, r.detail);
    if (simulate || !r.winner) return { ok: true as const, draw: r, onChain: null };
    const wallet = await this.walletOf(r.winner.githubUserId);
    const signed = wallet ? await this.attestAssign(b, wallet) : { ok: false as const, error: 'winner has no linked wallet' };
    return { ok: true as const, draw: r, onChain: signed.ok ? signed.signature : null, onChainError: signed.ok ? null : signed.error };
  }

  /**
   * The attestor's assign. A failure leaves the assignment in place and
   * `reconcile` retries it: the winner has already been told, and taking a
   * win back because a signer was briefly unreachable would be worse.
   */
  private async attestAssign(b: FundedRow, wallet: string) {
    if (!this.d.attestor) return { ok: false as const, error: 'attestor not configured' };
    const s = await this.d.attestor.assign(b.escrow_pubkey, wallet);
    if (s.ok) {
      await this.d.escrow.recordAssigned(b.id, wallet, s.signature);
    } else {
      await this.d.db.query('UPDATE bounty_escrows SET last_error = $2, updated_at = now() WHERE id = $1',
        [b.escrow_id, `assign pending: ${s.error}`]);
    }
    return s;
  }

  // ------------------------------------------------------------ unassigning

  /**
   * End an assignment. Before a pull request, the funder's decision alone,
   * no reason needed. After one, only once both sides have agreed.
   *
   * Draw mode: the attestor signs and it is done. Self-assign: the funder
   * signs, so the first call returns their transaction and `unassignConfirm`
   * records it once the chain shows it.
   */
  async unassign(bountyId: string, login: string, reason: string) {
    const b = await this.asFunder(bountyId, login);
    if ('ok' in b) return b;
    const asg = await this.live(bountyId);
    if (!asg) return fail(409, 'no_active_assignment', 'nobody holds this bounty');
    const agreed = await this.agreedProposal(asg.id);
    if (asg.status === 'pr_submitted' && !agreed) {
      return fail(409, 'pr_open', 'a pull request is open, so unassigning needs the contributor to agree; propose it instead');
    }
    const why = reason.trim() || (agreed ? agreed.reason : '');

    if (b.assignment_mode === 'draw') {
      if (b.escrow_state === 'assigned') {
        if (!this.d.attestor) return fail(503, 'attestor_not_configured', 'unassigning needs Grainlify\'s attestor key, which is not set up yet');
        const s = await this.d.attestor.unassign(b.escrow_pubkey);
        if (!s.ok) return fail(502, 'attestor_failed', s.error);
        await this.d.escrow.recordUnassigned(b.id, s.signature, { by: login });
      }
      await this.release(b, asg, login, why, { proposalId: agreed?.id ?? null, onChainDirect: false });
      return { ok: true as const, contributor: asg.github_login, needsSignature: false as const };
    }

    // Self-assign: the funder's own signature.
    if (b.escrow_state !== 'assigned') {
      await this.release(b, asg, login, why, { proposalId: agreed?.id ?? null, onChainDirect: false });
      return { ok: true as const, contributor: asg.github_login, needsSignature: false as const };
    }
    const transaction = await this.d.escrow.funderUnassignTransaction(b.escrow_pubkey, b.funder_wallet);
    await this.escrowEvent(b.escrow_id, 'unassign_prepared', null, { by: login, reason: why, proposalId: agreed?.id ?? null });
    return { ok: true as const, contributor: asg.github_login, needsSignature: true as const, transaction, funderWallet: b.funder_wallet };
  }

  async unassignConfirm(bountyId: string, login: string, reason: string, signature: string) {
    const b = await this.asFunder(bountyId, login);
    if ('ok' in b) return b;
    const asg = await this.live(bountyId);
    if (!asg) return { ok: true as const, already: true };
    const chain = await this.d.escrow.readChain(b.escrow_pubkey);
    if (!chain || chain.state !== 'Funded' || chain.contributor) {
      return fail(409, 'not_unassigned_on_chain', 'the escrow still names the contributor; wait a moment and confirm again');
    }
    const agreed = await this.agreedProposal(asg.id);
    if (asg.status === 'pr_submitted' && !agreed) {
      // They signed it without the agreement our rules need. It happened, and
      // it is recorded as what it was.
      await this.d.escrow.recordUnassigned(b.id, signature, { by: login, withoutAgreement: true });
      await this.release(b, asg, login, reason.trim(), { proposalId: null, onChainDirect: true });
      return { ok: true as const, already: false, withoutAgreement: true };
    }
    await this.d.escrow.recordUnassigned(b.id, signature, { by: login });
    await this.release(b, asg, login, reason.trim() || agreed?.reason || '', { proposalId: agreed?.id ?? null, onChainDirect: false });
    return { ok: true as const, already: false };
  }

  private async agreedProposal(assignmentId: string) {
    return (await this.d.db.query<{ id: string; reason: string }>(
      `SELECT id, reason FROM bounty_unassign_proposals
        WHERE assignment_id = $1 AND status IN ('accepted','accepted_by_silence') AND carried_out_at IS NULL
        ORDER BY created_at DESC LIMIT 1`, [assignmentId])).rows[0] ?? null;
  }

  /** The assignment ends here; the chain has already been dealt with by the caller. */
  private async release(
    b: FundedRow, asg: LiveAssignment, actor: string, reason: string,
    o: { proposalId: string | null; onChainDirect: boolean },
  ) {
    const said = reason || (o.onChainDirect
      ? 'The funder unassigned this on-chain, without going through Grainlify.'
      : 'No reason was given.');
    await this.d.db.query(
      `UPDATE bounty_assignments
          SET status = 'released_voluntary', released_at = $2, release_reason = $3, released_by = $4,
              counts_as_abandon = false, unassigned_on_chain_directly = $5, updated_at = now()
        WHERE id = $1`,
      [asg.id, this.now().toISOString(), said, actor, o.onChainDirect]);
    await this.d.db.query(
      `UPDATE bounty_applications SET status = 'lost', updated_at = now() WHERE bounty_id = $1 AND github_user_id = $2 AND status = 'won'`,
      [b.id, asg.github_user_id]);
    if (b.assignment_mode === 'draw') {
      // The next draw is from whoever remains: handing it straight back to
      // the person just unassigned would read as a mistake.
      await this.d.db.query('UPDATE bounties SET exclude_login_next_draw = $2, updated_at = now() WHERE id = $1', [b.id, asg.github_login]);
    }
    if (o.proposalId) {
      await this.d.db.query('UPDATE bounty_unassign_proposals SET carried_out_at = $2 WHERE id = $1', [o.proposalId, this.now().toISOString()]);
    }
    await this.audit(actor, 'assignment.unassigned', b.id, {
      assignmentId: asg.id, contributor: asg.github_login, reason: said, funded: true,
      beforePullRequest: asg.qualifying_pr_number === null, agreedProposal: o.proposalId, onChainDirect: o.onChainDirect,
    });
    await enqueueEvent(this.d.db, {
      kind: 'bounty_unassigned',
      githubUserId: Number(asg.github_user_id),
      dedupeKey: dedupe.unassigned(asg.id),
      payload: {
        bountyId: b.id, repo: b.repo, issue_number: b.issue_number, amount_minor: b.amount_minor, currency: b.currency,
        // Before a pull request a funder need give no reason, and the
        // message says so rather than quoting the placeholder as one.
        reason: said, reasonGiven: reason.length > 0, actor, funded: true,
      },
    });
  }

  // ------------------------------------------------------------ both sides agree

  /** Who is asking, on which side. The funder by login; the contributor by GitHub id, never by login. */
  private async side(b: FundedRow, asg: LiveAssignment, login: string, githubUserId: number): Promise<'funder' | 'contributor' | null> {
    if (b.funded_by.toLowerCase() === login.toLowerCase()) return 'funder';
    if (Number(asg.github_user_id) === githubUserId) return 'contributor';
    return null;
  }

  async propose(bountyId: string, login: string, githubUserId: number, reason: string) {
    const b = await this.row(bountyId);
    if (!b) return fail(404, 'not_a_funded_bounty', 'that is not a funded bounty');
    if (!(await this.d.escrow.enabledFor(b.funded_by))) return fail(403, 'funded_bounties_disabled', 'funded bounties are switched off');
    const asg = await this.live(bountyId);
    if (!asg) return fail(409, 'no_active_assignment', 'nobody holds this bounty');
    const side = await this.side(b, asg, login, githubUserId);
    if (!side) return fail(403, 'not_a_party', 'only the funder and the assigned contributor can propose this');
    if (asg.status !== 'pr_submitted') {
      return side === 'funder'
        ? fail(409, 'no_pr_open', 'no pull request is open, so you can unassign directly')
        : fail(409, 'no_pr_open', 'this applies once your pull request is open');
    }
    const why = reason.trim();
    if (!why) return fail(400, 'reason_required', 'say why: the other side reads it, and so would an admin');
    const respondBy = new Date(this.now().getTime() + RESPOND_DAYS * 86_400_000);
    let id: string;
    try {
      id = (await this.d.db.query<{ id: string }>(
        `INSERT INTO bounty_unassign_proposals (bounty_id, assignment_id, proposed_by, proposer_login, reason, respond_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [bountyId, asg.id, side, login, why.slice(0, 2000), respondBy.toISOString()])).rows[0]!.id;
    } catch {
      return fail(409, 'proposal_pending', 'there is already a proposal waiting for an answer');
    }
    await this.audit(login, 'unassign.proposed', bountyId, { proposalId: id, side, reason: why, respondBy: respondBy.toISOString() });
    const otherId = side === 'funder' ? Number(asg.github_user_id) : Number(b.funded_by_github_user_id ?? 0);
    if (otherId) {
      await enqueueEvent(this.d.db, {
        kind: 'bounty_unassign_proposed',
        githubUserId: otherId,
        dedupeKey: dedupe.unassignProposed(id),
        payload: {
          bountyId, repo: b.repo, issue_number: b.issue_number, proposedBy: side, proposer: login,
          reason: why, respondBy: respondBy.toISOString(), prNumber: asg.qualifying_pr_number,
        },
      });
    }
    return { ok: true as const, proposalId: id, respondBy: respondBy.toISOString() };
  }

  async respond(proposalId: string, login: string, githubUserId: number, accept: boolean, response: string) {
    const p = (await this.d.db.query<{ id: string; bounty_id: string; assignment_id: string; proposed_by: string; proposer_login: string; status: string; reason: string }>(
      'SELECT id, bounty_id, assignment_id, proposed_by, proposer_login, status, reason FROM bounty_unassign_proposals WHERE id = $1', [proposalId])).rows[0];
    if (!p) return fail(404, 'no_such_proposal', 'that proposal does not exist');
    if (p.status !== 'pending') return fail(409, 'not_pending', `that proposal is ${p.status}`);
    const b = (await this.row(p.bounty_id))!;
    const asg = await this.live(p.bounty_id);
    if (!asg || asg.id !== p.assignment_id) return fail(409, 'assignment_changed', 'the assignment this was about has ended');
    const side = await this.side(b, asg, login, githubUserId);
    if (!side || side === p.proposed_by) return fail(403, 'not_the_other_side', 'only the other side can answer this');

    if (!accept) {
      const why = response.trim();
      if (!why) return fail(400, 'response_required', 'say why you are refusing: an admin may read both sides');
      await this.d.db.query(
        `UPDATE bounty_unassign_proposals SET status = 'refused', responder_login = $2, response = $3, responded_at = $4 WHERE id = $1`,
        [p.id, login, why.slice(0, 2000), this.now().toISOString()]);
      await this.audit(login, 'unassign.refused', p.bounty_id, { proposalId: p.id, side, response: why });
      const proposerId = p.proposed_by === 'funder' ? Number(b.funded_by_github_user_id ?? 0) : Number(asg.github_user_id);
      if (proposerId) {
        await enqueueEvent(this.d.db, {
          kind: 'bounty_unassign_refused',
          githubUserId: proposerId,
          dedupeKey: dedupe.unassignRefused(p.id),
          payload: {
            bountyId: p.bounty_id, repo: b.repo, issue_number: b.issue_number, refusedBy: login, response: why,
            deadlineAt: new Date(b.deadline_at).toISOString(),
          },
        });
      }
      return { ok: true as const, status: 'refused' as const };
    }
    await this.d.db.query(
      `UPDATE bounty_unassign_proposals SET status = 'accepted', responder_login = $2, response = NULLIF($3,''), responded_at = $4 WHERE id = $1`,
      [p.id, login, response.trim().slice(0, 2000), this.now().toISOString()]);
    await this.audit(login, 'unassign.accepted', p.bounty_id, { proposalId: p.id, side });
    const done = await this.carryOut(p.id);
    return { ok: true as const, status: 'accepted' as const, ...done };
  }

  async withdraw(proposalId: string, login: string) {
    const r = await this.d.db.query(
      `UPDATE bounty_unassign_proposals SET status = 'withdrawn', responded_at = $3
        WHERE id = $1 AND status = 'pending' AND lower(proposer_login) = lower($2) RETURNING bounty_id`,
      [proposalId, login, this.now().toISOString()]);
    if (!r.rowCount) return fail(409, 'not_withdrawable', 'only a pending proposal you made can be withdrawn');
    await this.audit(login, 'unassign.withdrawn', r.rows[0].bounty_id, { proposalId });
    return { ok: true as const };
  }

  /**
   * Agreed: make it so. Draw mode, the attestor signs now. Self-assign, the
   * agreement waits for the funder to sign it, and their page asks them to.
   */
  private async carryOut(proposalId: string): Promise<{ carriedOut: boolean; awaitingFunderSignature: boolean }> {
    const p = (await this.d.db.query<{ bounty_id: string; assignment_id: string; reason: string; proposer_login: string }>(
      'SELECT bounty_id, assignment_id, reason, proposer_login FROM bounty_unassign_proposals WHERE id = $1', [proposalId])).rows[0]!;
    const b = (await this.row(p.bounty_id))!;
    const asg = await this.live(p.bounty_id);
    if (!asg || asg.id !== p.assignment_id) return { carriedOut: false, awaitingFunderSignature: false };
    if (b.assignment_mode === 'self_assign' && b.escrow_state === 'assigned') {
      return { carriedOut: false, awaitingFunderSignature: true };
    }
    if (b.escrow_state === 'assigned') {
      if (!this.d.attestor) return { carriedOut: false, awaitingFunderSignature: false };
      const s = await this.d.attestor.unassign(b.escrow_pubkey);
      if (!s.ok) {
        await this.d.db.query('UPDATE bounty_escrows SET last_error = $2 WHERE id = $1', [b.escrow_id, `agreed unassign pending: ${s.error}`]);
        return { carriedOut: false, awaitingFunderSignature: false };
      }
      await this.d.escrow.recordUnassigned(b.id, s.signature, { agreedProposal: proposalId });
    }
    await this.release(b, asg, 'agreed', `Both sides agreed: ${p.reason}`, { proposalId, onChainDirect: false });
    return { carriedOut: true, awaitingFunderSignature: false };
  }

  /** Seven days of silence counts as accepting. Run by the scheduler. */
  async expireProposals(): Promise<string[]> {
    const due = await this.d.db.query<{ id: string; bounty_id: string }>(
      `UPDATE bounty_unassign_proposals SET status = 'accepted_by_silence', responded_at = $1
        WHERE status = 'pending' AND respond_by <= $1 RETURNING id, bounty_id`,
      [this.now().toISOString()]);
    for (const p of due.rows) {
      await this.audit('agent', 'unassign.accepted_by_silence', p.bounty_id, { proposalId: p.id, days: RESPOND_DAYS });
      await this.carryOut(p.id);
    }
    // Agreed in draw mode but the attestor was unreachable: try again.
    const stuck = await this.d.db.query<{ id: string }>(
      `SELECT p.id FROM bounty_unassign_proposals p JOIN bounty_escrows e ON e.bounty_id = p.bounty_id
        WHERE p.status IN ('accepted','accepted_by_silence') AND p.carried_out_at IS NULL AND e.assignment_mode = 'draw'`);
    for (const p of stuck.rows) await this.carryOut(p.id);
    return due.rows.map((x) => x.id);
  }

  // ------------------------------------------------------------ the chain is the truth

  /**
   * Bring the mirror into line with the chain, for every live funded escrow.
   *
   * Four things can differ, and each is recorded as what it was:
   * - the escrow is gone: the funder refunded after the deadline, or cancelled
   *   before anybody was assigned;
   * - it names somebody we have no assignment for: a self-assign funder
   *   assigned from their own wallet;
   * - it names nobody while we have an assignment: either a draw-mode assign
   *   we have yet to sign (retried here), or a self-assign funder unassigned
   *   from their own wallet;
   * - it names the person we expect but our row says otherwise: an earlier
   *   confirm never arrived.
   */
  async reconcile(): Promise<{ bountyId: string; what: string }[]> {
    const out: { bountyId: string; what: string }[] = [];
    const rows = await this.d.db.query<{ id: string }>(
      `SELECT b.id FROM bounties b JOIN bounty_escrows e ON e.bounty_id = b.id
        WHERE b.funded_by IS NOT NULL AND b.status IN ('posted','in_review','payable') AND e.state IN ('funded','assigned')`);
    for (const { id } of rows.rows) {
      try {
        const what = await this.reconcileOne(id);
        if (what) out.push({ bountyId: id, what });
      } catch (e) {
        console.log(`reconcile ${id} failed, continuing: ${String(e)}`);
      }
    }
    return out;
  }

  private async preparedRecently(escrowId: string, kind: string) {
    const r = await this.d.db.query<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM bounty_escrow_events WHERE escrow_id = $1 AND kind = $2 AND created_at >= $3 ORDER BY created_at DESC LIMIT 1`,
      [escrowId, kind, new Date(this.now().getTime() - PREPARED_WINDOW_MS).toISOString()]);
    return r.rows[0]?.detail ?? null;
  }

  private async reconcileOne(bountyId: string): Promise<string | null> {
    const b = (await this.row(bountyId))!;
    const asg = await this.live(bountyId);
    const chain = await this.d.escrow.readChain(b.escrow_pubkey);

    if (!chain) {
      // A release in flight closes the account before its payout row says
      // confirmed; that is ours, not the funder's.
      const releasing = await this.d.db.query(
        `SELECT 1 FROM payouts WHERE bounty_id = $1 AND status IN ('approved','submitted','confirmed')`, [bountyId]);
      if (releasing.rowCount) return null;
      // Closed, and not by a release we made. Only the funder closes an
      // escrow otherwise: refund after the deadline, or cancel before anybody
      // was ever assigned.
      const everAssigned = (await this.d.db.query('SELECT 1 FROM bounty_assignments WHERE bounty_id = $1 LIMIT 1', [bountyId])).rowCount;
      await this.d.escrow.recordClosed(bountyId, 'refunded', { seenBy: 'reconcile' });
      await this.d.db.query(`UPDATE bounties SET status = $2, updated_at = now() WHERE id = $1`, [bountyId, everAssigned ? 'expired' : 'cancelled']);
      if (asg) await this.release(b, asg, b.funded_by, 'The funder took the escrow back after its deadline.', { proposalId: null, onChainDirect: false });
      await this.audit('agent', 'bounty.escrow_closed_by_funder', bountyId, { everAssigned: Boolean(everAssigned) });
      return everAssigned ? 'refunded' : 'cancelled';
    }

    const named = chain.contributor?.toBase58() ?? null;
    if (named) {
      if (asg) {
        const wallet = b.contributor_wallet ?? await this.walletOf(asg.github_user_id);
        if (b.escrow_state !== 'assigned' && wallet === named) {
          await this.d.escrow.recordAssigned(bountyId, named, null);
          return 'assign_recorded';
        }
        return null;
      }
      // Assigned on-chain with nobody here: the funder, from their wallet.
      const app = (await this.d.db.query<{ github_user_id: string; github_login: string }>(
        `SELECT ap.github_user_id::text AS github_user_id, ap.github_login FROM bounty_applications ap
           JOIN wallet_links w ON w.github_user_id = ap.github_user_id AND w.revoked_at IS NULL
          WHERE ap.bounty_id = $1 AND w.address = $2`, [bountyId, named])).rows[0];
      if (!app) {
        await this.d.db.query('UPDATE bounty_escrows SET last_error = $2, updated_at = now() WHERE id = $1',
          [b.escrow_id, `assigned on-chain to ${named}, who has not applied with that wallet`]);
        await this.audit('agent', 'escrow.assigned_to_unknown', bountyId, { wallet: named });
        return 'assigned_to_unknown';
      }
      await this.recordAssignment(b, app, named, null, b.funded_by);
      return 'assigned_outside';
    }

    // The chain names nobody.
    if (!asg) {
      if (b.escrow_state === 'assigned') await this.d.escrow.recordUnassigned(bountyId, null, { seenBy: 'reconcile' });
      return null;
    }
    if (b.escrow_state === 'funded' && b.assignment_mode === 'draw') {
      const wallet = await this.walletOf(asg.github_user_id);
      if (wallet) await this.attestAssign(b, wallet);
      return 'assign_retried';
    }
    if (b.escrow_state === 'assigned') {
      const prepared = await this.preparedRecently(b.escrow_id, 'unassign_prepared');
      const agreed = await this.agreedProposal(asg.id);
      await this.d.escrow.recordUnassigned(bountyId, null, { seenBy: 'reconcile', prepared: Boolean(prepared) });
      if (prepared && (asg.status !== 'pr_submitted' || agreed)) {
        await this.release(b, asg, b.funded_by, String(prepared.reason ?? ''), { proposalId: agreed?.id ?? null, onChainDirect: false });
        return 'unassign_recorded';
      }
      await this.release(b, asg, b.funded_by, '', { proposalId: null, onChainDirect: true });
      return 'unassigned_outside';
    }
    return null;
  }

  // ------------------------------------------------------------ in public

  /**
   * The funder's record, shown to anybody deciding whether to apply. Three
   * numbers side by side, because one alone misleads: a funder who has
   * funded twenty and unassigned two is not one who funded two and
   * unassigned two.
   */
  async profile(login: string) {
    const r = await this.d.db.query<{ funded: number; unassigned_before_pr: number; disputes: number }>(
      `SELECT
         (SELECT count(*) FROM bounties b JOIN bounty_escrows e ON e.bounty_id = b.id
           WHERE lower(b.funded_by) = lower($1) AND e.fund_tx IS NOT NULL)::int AS funded,
         (SELECT count(*) FROM bounty_assignments a JOIN bounties b ON b.id = a.bounty_id
           WHERE lower(b.funded_by) = lower($1) AND a.status = 'released_voluntary' AND a.qualifying_pr_number IS NULL
             AND (lower(a.released_by) = lower($1) OR a.unassigned_on_chain_directly))::int AS unassigned_before_pr,
         (SELECT count(*) FROM bounty_unassign_proposals p JOIN bounties b ON b.id = p.bounty_id
           WHERE lower(b.funded_by) = lower($1) AND p.proposed_by = 'funder' AND p.status = 'refused')::int AS disputes`,
      [login]);
    const x = r.rows[0]!;
    return { login, bountiesFunded: x.funded, unassignedBeforePr: x.unassigned_before_pr, disputesRaised: x.disputes };
  }

  // ------------------------------------------------------------ arbitration

  /** Every refused proposal: the only cases an admin is ever asked to look at. */
  async disputes() {
    const r = await this.d.db.query(
      `SELECT p.id, p.bounty_id, p.proposed_by, p.proposer_login, p.reason, p.responder_login, p.response, p.responded_at,
              p.arbitration, p.arbitrated_by, p.arbitrated_at, p.created_at,
              r.owner||'/'||r.name AS repo, b.issue_number, b.issue_title, b.funded_by, b.currency,
              e.amount_minor::text AS amount_minor, e.fee_amount_minor::text AS fee_amount_minor, e.deadline_at, e.escrow_pubkey, e.network,
              a.github_login AS contributor, a.qualifying_pr_number AS pr_number, a.status AS assignment_status
         FROM bounty_unassign_proposals p
         JOIN bounties b ON b.id = p.bounty_id
         JOIN repos r ON r.id = b.repo_id
         JOIN bounty_escrows e ON e.bounty_id = b.id
         JOIN bounty_assignments a ON a.id = p.assignment_id
        WHERE p.status = 'refused'
        ORDER BY p.responded_at DESC`);
    return r.rows.map((x) => this.disputeShape(x));
  }

  private disputeShape(x: Record<string, unknown>) {
    const funderSays = x.proposed_by === 'funder' ? x.reason : x.response;
    const contributorSays = x.proposed_by === 'contributor' ? x.reason : x.response;
    return {
      id: x.id as string,
      bountyId: x.bounty_id as string,
      repo: x.repo as string,
      issueNumber: x.issue_number as number,
      issueTitle: x.issue_title as string | null,
      funder: x.funded_by as string,
      contributor: x.contributor as string,
      prNumber: x.pr_number as number | null,
      prUrl: x.pr_number ? `https://github.com/${x.repo}/pull/${x.pr_number}` : null,
      escrow: {
        address: x.escrow_pubkey as string, network: x.network as string, currency: x.currency as string,
        amountMinor: x.amount_minor as string, feeAmountMinor: x.fee_amount_minor as string,
        deadlineAt: new Date(x.deadline_at as Date).toISOString(),
      },
      proposedBy: x.proposed_by as string,
      funderSays: funderSays as string,
      contributorSays: contributorSays as string,
      refusedAt: x.responded_at ? new Date(x.responded_at as Date).toISOString() : null,
      arbitration: x.arbitration as string | null,
      arbitratedBy: x.arbitrated_by as string | null,
      arbitratedAt: x.arbitrated_at ? new Date(x.arbitrated_at as Date).toISOString() : null,
      stillHeld: x.assignment_status === 'active' || x.assignment_status === 'pr_submitted',
    };
  }

  async dispute(id: string) {
    const all = await this.disputes();
    const d = all.find((x) => x.id === id);
    if (!d) return fail(404, 'no_such_dispute', 'that is not a disputed proposal');
    const timeline = await this.d.db.query<{ at: Date; actor: string; action: string; detail: Record<string, unknown> }>(
      `SELECT at, actor, action, detail FROM audit_log WHERE subject = $1 ORDER BY at`, [d.bountyId]);
    const notes = await this.d.db.query<{ note: string; recorded_by: string; created_at: Date }>(
      `SELECT note, recorded_by, created_at FROM funder_conduct_notes WHERE bounty_id = $1 ORDER BY created_at`, [d.bountyId]);
    return {
      ok: true as const,
      ...d,
      timeline: timeline.rows.map((t) => ({ at: new Date(t.at).toISOString(), actor: t.actor, action: t.action, detail: t.detail })),
      conductNotes: notes.rows.map((n) => ({ note: n.note, by: n.recorded_by, at: new Date(n.created_at).toISOString() })),
      funderProfile: await this.profile(d.funder),
    };
  }

  /**
   * "Leave it to the deadline" - the default, made explicit. There is no
   * action that ends a dispute in the funder's favour before the deadline:
   * no instruction exists that could, and this is not a place to pretend
   * otherwise.
   */
  async leaveToDeadline(id: string, admin: string) {
    const r = await this.d.db.query(
      `UPDATE bounty_unassign_proposals SET arbitration = 'left_to_deadline', arbitrated_by = $2, arbitrated_at = $3
        WHERE id = $1 AND status = 'refused' RETURNING bounty_id`, [id, admin, this.now().toISOString()]);
    if (!r.rowCount) return fail(404, 'no_such_dispute', 'that is not a disputed proposal');
    await this.audit(admin, 'dispute.left_to_deadline', r.rows[0].bounty_id, { proposalId: id });
    return { ok: true as const };
  }

  async conductNote(id: string, admin: string, note: string) {
    const text = note.trim();
    if (!text) return fail(400, 'note_required', 'the note is empty');
    const p = (await this.d.db.query<{ bounty_id: string; funded_by: string }>(
      `SELECT p.bounty_id, b.funded_by FROM bounty_unassign_proposals p JOIN bounties b ON b.id = p.bounty_id
        WHERE p.id = $1 AND p.status = 'refused'`, [id])).rows[0];
    if (!p) return fail(404, 'no_such_dispute', 'that is not a disputed proposal');
    await this.d.db.query('INSERT INTO funder_conduct_notes (funder_login, bounty_id, note, recorded_by) VALUES ($1,$2,$3,$4)',
      [p.funded_by, p.bounty_id, text.slice(0, 2000), admin]);
    await this.audit(admin, 'dispute.conduct_note', p.bounty_id, { proposalId: id, funder: p.funded_by });
    return { ok: true as const };
  }
}
