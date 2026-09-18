// The bounty loop.
//
//   propose  -> a maintainer picks an issue; one inference call prices it; the agent posts the bounty.
//   link     -> a contributor proves wallet ownership with a signed comment.
//   review   -> on a PR that closes a bounty issue, one inference call reviews it (advisory).
//   merge    -> the deterministic gate runs on facts read fresh from GitHub; a payout waits for approval.
//   approve  -> a human-signed approval goes to the payout signer, which re-checks and pays.

import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { verifyApproval, type Approval, type PayoutTerms } from '../../../packages/gate/src/approval.ts';
import { evaluateGate, type GateFacts, type GateResult } from '../../../packages/gate/src/gate.ts';
import { parseAndVerifyLinkComment } from '../../../packages/gate/src/link.ts';
import type { X402Client } from '../../../packages/x402/src/client.ts';
import type { InferenceCallRecord } from '../../../packages/x402/src/receipts.ts';
import { X402_PATHS } from '../../../packages/x402/src/protocol.ts';
import { explorerTx, formatAmount, type AgentConfig } from './config.ts';
import type { GitHubApi } from './github.ts';
import { assistantText, clampPriceMinor, parsePricing, parseReview, pricingMessages, reviewMessages } from './prompts.ts';

export interface PayoutSignerApi {
  pay(approval: Approval): Promise<{ ok: true; signature: string } | { ok: false; status: number; error: string }>;
}

export interface Deps {
  db: pg.Pool;
  gh: GitHubApi;
  x402: X402Client;
  payoutSigner: PayoutSignerApi;
  cfg: AgentConfig;
  now?: () => Date;
}

const FOOTER = '\n\n<sub>Grainlify Agent · every reasoning step is inference bought on UsePod over x402 · payment depends only on a maintainer merge and a human approval.</sub>';

export class BountyService {
  private readonly now: () => Date;

  constructor(private readonly d: Deps) {
    this.now = d.now ?? (() => new Date());
  }

  private async audit(actor: string, action: string, subject: string | null, detail: Record<string, unknown> = {}) {
    await this.d.db.query(`INSERT INTO audit_log (actor, action, subject, detail) VALUES ($1, $2, $3, $4)`, [actor, action, subject, JSON.stringify(detail, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))]);
  }

  private receiptLine(r: InferenceCallRecord): string {
    if (this.d.cfg.inferenceMode === 'mock') return `\`${r.model}\` via the local x402 mock gateway (test run, no real payment), quote \`${r.quoteId}\``;
    const how = r.scheme === 'balance' ? 'paid from x402 surplus credit' : r.payTxSignature ? `paid on-chain: ${explorerTx('solana-mainnet', r.payTxSignature)}` : 'unpaid';
    return `\`${r.model}\` via UsePod x402, quote \`${r.quoteId}\`, ${how}`;
  }

  async repo(fullName: string) {
    const [owner, name] = fullName.split('/');
    const r = await this.d.db.query(`SELECT * FROM repos WHERE lower(owner) = lower($1) AND lower(name) = lower($2)`, [owner, name]);
    return (r.rows[0] as { id: string; owner: string; name: string; enabled: boolean } | undefined) ?? null;
  }

  async addRepo(fullName: string, enabled: boolean) {
    const [owner, name] = fullName.split('/');
    if (!owner || !name) throw new Error('repo must be owner/name');
    const installationId = await this.d.gh.installationIdFor(fullName);
    await this.d.db.query(
      `INSERT INTO repos (owner, name, installation_id, enabled) VALUES ($1, $2, $3, $4)
       ON CONFLICT (owner, name) DO UPDATE SET installation_id = EXCLUDED.installation_id, enabled = EXCLUDED.enabled`,
      [owner, name, installationId, enabled],
    );
    await this.audit('maintainer', 'repo.upsert', fullName, { enabled, installationId });
  }

  // --- propose -------------------------------------------------------------

  async proposeBounty(fullName: string, issueNumber: number, createdBy: string, currency = this.d.cfg.defaultCurrency) {
    const repo = await this.repo(fullName);
    if (!repo?.enabled) throw new Error(`${fullName} is not an enabled, allowlisted repo`);
    const mint = this.d.cfg.mints[currency];
    if (!mint) throw new Error(`no ${currency} mint configured for ${this.d.cfg.network}`);
    const open = await this.d.db.query(`SELECT id FROM bounties WHERE repo_id = $1 AND issue_number = $2 AND status NOT IN ('paid','cancelled','expired')`, [repo.id, issueNumber]);
    if (open.rowCount) throw new Error(`issue #${issueNumber} already has an open bounty`);

    const issue = await this.d.gh.getIssue(fullName, issueNumber);
    if (issue.state !== 'open') throw new Error(`issue #${issueNumber} is ${issue.state}`);

    const bountyId = randomUUID();
    const { record, response } = await this.d.x402.call({
      purpose: 'price',
      phase: this.d.cfg.inferencePhase,
      path: X402_PATHS.chat,
      body: { model: this.d.cfg.routing.price.model, max_tokens: this.d.cfg.routing.price.max_tokens, messages: pricingMessages({ repo: fullName, number: issueNumber, title: issue.title, body: issue.body }) },
      links: { bountyId, repo: fullName, issueNumber },
    });
    const pricing = parsePricing(assistantText(response));
    const amount = clampPriceMinor(pricing.suggested_usd, this.d.cfg.priceRangeUsd.min, this.d.cfg.priceRangeUsd.max, mint.decimals);

    await this.d.db.query(
      `INSERT INTO bounties (id, repo_id, issue_number, amount_minor, currency, mint, network, status, price_call_id, pricing, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'proposed', $8, $9, $10)`,
      [bountyId, repo.id, issueNumber, amount.toString(), currency, mint.mint, this.d.cfg.network, record.id, JSON.stringify(pricing), createdBy],
    );

    const testNote = this.d.cfg.network === 'solana-mainnet' ? '' : `\n\n> **Test bounty on ${this.d.cfg.network}.** It pays test tokens with no real value.`;
    const body = [
      `### Bounty: ${formatAmount(amount, mint.decimals, currency)}`,
      testNote,
      `\n**How to claim**`,
      `1. Link your Solana wallet once: sign the message at ${this.d.cfg.linkPageUrl} and post the \`/grainlify link …\` line it gives you as a comment here.`,
      `2. Open a pull request that says \`Closes #${issueNumber}\`.`,
      `3. When a maintainer merges it, the payout goes to a human for approval, then to your wallet.`,
      `\n**Rules:** one wallet per GitHub account; accounts must be at least ${this.d.cfg.gate.minAccountAgeDays} days old; self-merged PRs are not paid; one payout per bounty.`,
      `\n**Pricing:** ~${pricing.effort_hours}h, ${pricing.complexity}. ${pricing.rationale}`,
      `Receipt: ${this.receiptLine(record)}`,
      FOOTER,
    ].join('\n');
    const c = await this.d.gh.comment(fullName, issueNumber, body);
    await this.d.db.query(`UPDATE bounties SET status = 'posted', comment_id = $2, updated_at = now() WHERE id = $1`, [bountyId, c.id]);
    await this.audit(createdBy, 'bounty.posted', bountyId, { repo: fullName, issueNumber, amount: amount.toString(), currency, priceCall: record.id });
    return { bountyId, amount, pricing, priceCall: record, commentUrl: c.url };
  }

  // --- link ----------------------------------------------------------------

  async onIssueComment(fullName: string, p: { issue: { number: number }; comment: { body: string; html_url: string; user: { id: number; login: string; type: string }; performed_via_github_app?: unknown } }) {
    if (p.comment.user.type !== 'User' || p.comment.performed_via_github_app) return; // never react to bots, including ourselves
    const parsed = parseAndVerifyLinkComment(p.comment.body, p.comment.user.login, this.now());
    if (parsed === null) return;
    const who = `@${p.comment.user.login}`;
    if (!parsed.ok) {
      await this.d.gh.comment(fullName, p.issue.number, `${who} wallet not linked: ${parsed.reason}.${FOOTER}`);
      return;
    }
    const user = await this.d.gh.getUser(fullName, p.comment.user.login);
    await this.d.db.query(
      `INSERT INTO contributors (github_user_id, login, account_created_at, is_bot) VALUES ($1, $2, $3, $4)
       ON CONFLICT (github_user_id) DO UPDATE SET login = EXCLUDED.login, account_created_at = EXCLUDED.account_created_at, is_bot = EXCLUDED.is_bot`,
      [user.id, user.login, user.createdAt, user.type !== 'User'],
    );
    const client = await this.d.db.connect();
    try {
      await client.query('BEGIN');
      const taken = await client.query(`SELECT github_user_id FROM wallet_links WHERE address = $1 AND revoked_at IS NULL AND github_user_id <> $2`, [parsed.wallet, user.id]);
      if (taken.rowCount) {
        await client.query('ROLLBACK');
        await this.d.gh.comment(fullName, p.issue.number, `${who} wallet not linked: that wallet is already linked to another GitHub account.${FOOTER}`);
        return;
      }
      await client.query(`UPDATE wallet_links SET revoked_at = now() WHERE github_user_id = $1 AND revoked_at IS NULL`, [user.id]);
      await client.query(`INSERT INTO wallet_links (github_user_id, address, message, signature, source) VALUES ($1, $2, $3, $4, $5)`, [user.id, parsed.wallet, parsed.message, parsed.signature, p.comment.html_url]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    await this.audit(p.comment.user.login, 'wallet.linked', String(user.id), { wallet: parsed.wallet, source: p.comment.html_url });
    await this.d.gh.comment(fullName, p.issue.number, `${who} linked wallet \`${parsed.wallet}\`. Bounties you earn will be paid there.${FOOTER}`);
  }

  // --- review --------------------------------------------------------------

  /** Open bounties in this repo that the PR closes. */
  private async bountiesClosedBy(fullName: string, prNumber: number) {
    const repo = await this.repo(fullName);
    if (!repo?.enabled) return { repo: null, bounties: [] as Record<string, unknown>[] };
    const closes = await this.d.gh.closingIssues(fullName, prNumber);
    if (!closes.length) return { repo, bounties: [] };
    const b = await this.d.db.query(`SELECT * FROM bounties WHERE repo_id = $1 AND issue_number = ANY($2::int[]) AND status IN ('posted','in_review','payable')`, [repo.id, closes]);
    return { repo, bounties: b.rows as Record<string, unknown>[] };
  }

  async onPullRequestActivity(fullName: string, prNumber: number) {
    const pr = await this.d.gh.getPull(fullName, prNumber);
    if (pr.state !== 'open') return;
    const { bounties } = await this.bountiesClosedBy(fullName, prNumber);
    for (const b of bounties) {
      const submissionId = await this.upsertSubmission(String(b.id), pr, 'open');
      if (b.status === 'posted') await this.d.db.query(`UPDATE bounties SET status = 'in_review', updated_at = now() WHERE id = $1 AND status = 'posted'`, [b.id]);
      const done = await this.d.db.query(`SELECT 1 FROM reviews WHERE submission_id = $1 AND head_sha = $2`, [submissionId, pr.headSha]);
      if (done.rowCount) continue; // one review per commit
      await this.reviewSubmission(fullName, b, submissionId, pr);
    }
  }

  private async upsertSubmission(bountyId: string, pr: { number: number; authorId: number; authorLogin: string; headSha: string; mergedByLogin: string | null; mergedAt: string | null }, state: 'open' | 'closed' | 'merged') {
    const r = await this.d.db.query(
      `INSERT INTO submissions (id, bounty_id, pr_number, author_github_user_id, author_login, head_sha, state, merged_by_login, merged_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (bounty_id, pr_number) DO UPDATE SET head_sha = EXCLUDED.head_sha, state = EXCLUDED.state, merged_by_login = EXCLUDED.merged_by_login, merged_at = EXCLUDED.merged_at, updated_at = now()
       RETURNING id`,
      [randomUUID(), bountyId, pr.number, pr.authorId, pr.authorLogin, pr.headSha, state, pr.mergedByLogin, pr.mergedAt],
    );
    return String(r.rows[0].id);
  }

  private async reviewSubmission(fullName: string, b: Record<string, unknown>, submissionId: string, pr: { number: number; title: string; body: string; headSha: string }) {
    const issue = await this.d.gh.getIssue(fullName, Number(b.issue_number));
    const [diff, ci] = await Promise.all([this.d.gh.getPullDiff(fullName, pr.number, this.d.cfg.maxDiffChars), this.d.gh.ciState(fullName, pr.headSha)]);
    const { record, response } = await this.d.x402.call({
      purpose: 'review',
      phase: this.d.cfg.inferencePhase,
      path: X402_PATHS.chat,
      body: { model: this.d.cfg.routing.review.model, max_tokens: this.d.cfg.routing.review.max_tokens, messages: reviewMessages({ repo: fullName, issue, pr, diff, ci }) },
      links: { bountyId: String(b.id), submissionId, repo: fullName, issueNumber: Number(b.issue_number), prNumber: pr.number },
    });
    const review = parseReview(assistantText(response));
    const label = { looks_complete: 'Looks complete', needs_changes: 'Needs changes', unclear: 'Unclear' }[review.verdict];
    const body = [
      `### Advisory review for bounty on #${b.issue_number}: ${label}`,
      review.summary,
      review.concerns.length ? `\n**Concerns**\n${review.concerns.map((c) => `- ${c}`).join('\n')}` : '',
      `\nCI: ${ci}.`,
      `\nThis review does not approve the PR or trigger payment. A maintainer's merge does, followed by a human approval.`,
      `Receipt: ${this.receiptLine(record)}`,
      FOOTER,
    ].join('\n');
    const posted = await this.d.gh.review(fullName, pr.number, pr.headSha, body);
    await this.d.db.query(
      `INSERT INTO reviews (id, submission_id, head_sha, verdict, summary, call_ids, ci_state, github_review_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
      [randomUUID(), submissionId, pr.headSha, review.verdict, review.summary, [record.id], ci, posted.id],
    );
    await this.audit('agent', 'review.posted', submissionId, { verdict: review.verdict, call: record.id });
  }

  // --- merge -> gate -------------------------------------------------------

  async onPullRequestClosed(fullName: string, prNumber: number) {
    const pr = await this.d.gh.getPull(fullName, prNumber); // fresh, not the webhook payload
    const { repo, bounties } = await this.bountiesClosedBy(fullName, prNumber);
    const results: { bountyId: string; payoutId: string; gate: GateResult }[] = [];
    for (const b of bounties) {
      const submissionId = await this.upsertSubmission(String(b.id), pr, pr.merged ? 'merged' : 'closed');
      if (!pr.merged) continue;
      const gate = await this.runGate(fullName, repo!, b, pr);
      const payoutId = randomUUID();
      const wallet = gate.facts.wallet?.address ?? '';
      await this.d.db.query(
        `INSERT INTO payouts (id, bounty_id, submission_id, recipient, recipient_github_user_id, amount_minor, currency, mint, network, gate_result, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [payoutId, b.id, submissionId, wallet || '-', pr.authorId, String(b.amount_minor), b.currency, b.mint, b.network, JSON.stringify(gate.result), gate.result.pass ? 'awaiting_approval' : 'refused'],
      );
      if (gate.result.pass) await this.d.db.query(`UPDATE bounties SET status = 'payable', updated_at = now() WHERE id = $1`, [b.id]);
      await this.audit('agent', gate.result.pass ? 'payout.awaiting_approval' : 'payout.refused', payoutId, { bounty: b.id, gate: gate.result });

      const lines = gate.result.checks.map((c) => `- ${c.pass ? '✅' : '❌'} \`${c.name}\`: ${c.detail}`).join('\n');
      const head = gate.result.pass
        ? `### Payout ready for approval\nThe merge passed every check. A human approver now signs off before anything is paid (payout \`${payoutId}\`).`
        : `### Payout refused by the gate\nThis merge did not pass every check, so nothing will be paid for it.`;
      await this.d.gh.comment(fullName, prNumber, `${head}\n\n${lines}${FOOTER}`);
      results.push({ bountyId: String(b.id), payoutId, gate: gate.result });
    }
    return results;
  }

  private async runGate(fullName: string, repo: { id: string; enabled: boolean }, b: Record<string, unknown>, pr: Awaited<ReturnType<GitHubApi['getPull']>>) {
    const [closes, mergedByPermission, author, wallet, existing, today] = await Promise.all([
      this.d.gh.closingIssues(fullName, pr.number),
      pr.mergedByLogin ? this.d.gh.permission(fullName, pr.mergedByLogin).catch(() => null) : Promise.resolve(null),
      this.d.gh.getUser(fullName, pr.authorLogin).catch(() => null),
      this.d.db.query(`SELECT address FROM wallet_links WHERE github_user_id = $1 AND revoked_at IS NULL`, [pr.authorId]),
      this.d.db.query(`SELECT 1 FROM payouts WHERE bounty_id = $1 AND status <> 'refused'`, [b.id]),
      this.d.db.query(
        `SELECT COALESCE(SUM(amount_minor), 0)::text AS s FROM payouts WHERE currency = $1 AND status NOT IN ('refused','failed') AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
        [b.currency],
      ),
    ]);
    const facts: GateFacts = {
      repo: { fullName, allowlisted: true, enabled: repo.enabled },
      bounty: { id: String(b.id), status: String(b.status), issueNumber: Number(b.issue_number), amountMinor: BigInt(String(b.amount_minor)), currency: String(b.currency), network: String(b.network) },
      pr: {
        number: pr.number, merged: pr.merged, mergedByLogin: pr.mergedByLogin, mergedByPermission, authorId: pr.authorId, authorLogin: pr.authorLogin,
        authorType: pr.authorType, closesIssues: closes,
      },
      // The author must be who GitHub says opened the PR; a lookup for a different id is treated as a failed lookup.
      author: author && author.id === pr.authorId ? { createdAt: author.createdAt } : null,
      wallet: wallet.rows[0] ? { address: String(wallet.rows[0].address) } : null,
      bountyAlreadyHasPayout: (existing.rowCount ?? 0) > 0,
      paidTodayMinor: BigInt(String(today.rows[0].s)),
    };
    return { facts, result: evaluateGate(facts, this.d.cfg.gate, this.now()) };
  }

  // --- approve -------------------------------------------------------------

  async payoutTerms(payoutId: string): Promise<{ terms: PayoutTerms; status: string; gate: GateResult } | null> {
    const r = await this.d.db.query(
      `SELECT p.*, b.issue_number, s.pr_number, s.author_login, r.owner, r.name FROM payouts p
       JOIN bounties b ON b.id = p.bounty_id JOIN submissions s ON s.id = p.submission_id JOIN repos r ON r.id = b.repo_id WHERE p.id = $1`,
      [payoutId],
    );
    const p = r.rows[0] as Record<string, unknown> | undefined;
    if (!p) return null;
    return {
      status: String(p.status),
      gate: p.gate_result as GateResult,
      terms: {
        payout_id: String(p.id), bounty_id: String(p.bounty_id), repo: `${p.owner}/${p.name}`, issue_number: Number(p.issue_number), pr_number: Number(p.pr_number),
        author_login: String(p.author_login), recipient: String(p.recipient), amount_minor: String(p.amount_minor), currency: String(p.currency), mint: String(p.mint), network: String(p.network),
      },
    };
  }

  async approvePayout(payoutId: string, approval: Approval) {
    const view = await this.payoutTerms(payoutId);
    if (!view) throw new Error('no such payout');
    if (view.status !== 'awaiting_approval') throw new Error(`payout is ${view.status}, not awaiting approval`);
    const canon = (t: PayoutTerms) => JSON.stringify(Object.keys(t).sort().map((k) => [k, t[k as keyof PayoutTerms]]));
    if (canon(approval.terms) !== canon(view.terms)) throw new Error('approval terms do not match this payout');
    const v = verifyApproval(approval, this.d.cfg.trustedApprovers, this.now());
    if (!v.ok) throw new Error(`approval rejected: ${v.reason}`);

    const claimed = await this.d.db.query(`UPDATE payouts SET status = 'approved', approval = $2, approved_at = now(), updated_at = now() WHERE id = $1 AND status = 'awaiting_approval'`, [payoutId, JSON.stringify(approval)]);
    if (claimed.rowCount !== 1) throw new Error('payout was approved concurrently');
    await this.audit(approval.approver, 'payout.approved', payoutId, { terms: view.terms });

    const res = await this.d.payoutSigner.pay(approval);
    if (!res.ok) {
      const unknown = res.status >= 500 && res.status !== 503;
      await this.d.db.query(`UPDATE payouts SET status = $2, error = $3, updated_at = now() WHERE id = $1`, [payoutId, unknown ? 'submitted' : 'failed', res.error]);
      await this.audit('payout-signer', unknown ? 'payout.unknown' : 'payout.refused_by_signer', payoutId, { error: res.error });
      throw new Error(`payout signer: ${res.error}`);
    }
    await this.d.db.query(`UPDATE payouts SET status = 'confirmed', tx_signature = $2, updated_at = now() WHERE id = $1`, [payoutId, res.signature]);
    await this.d.db.query(`UPDATE bounties SET status = 'paid', updated_at = now() WHERE id = $1`, [view.terms.bounty_id]);
    await this.audit('payout-signer', 'payout.confirmed', payoutId, { tx: res.signature });
    const mint = Object.values(this.d.cfg.mints).find((m) => m.mint === view.terms.mint);
    await this.d.gh.comment(
      view.terms.repo,
      view.terms.pr_number,
      `### Paid\n${formatAmount(BigInt(view.terms.amount_minor), mint?.decimals ?? 6, view.terms.currency)} sent to \`${view.terms.recipient}\` for #${view.terms.issue_number}.\nTransaction: ${explorerTx(view.terms.network, res.signature)}${FOOTER}`,
    );
    return { signature: res.signature };
  }
}
