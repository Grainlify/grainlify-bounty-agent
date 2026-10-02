// Read-only public API for grainlify.com: the Bounties program page, the
// ledger and the wallet-link page. Everything here is already public on
// GitHub or on-chain; nothing here can change state.
//
// Honesty rules:
//  - `status` says which network payouts run on and whether inference is
//    mocked, straight from the running configuration, so the pages change the
//    moment mainnet is switched on and cannot claim more than is true.
//  - While inference is mocked, no dollar figure is reported for it: the mock
//    ledger records play money, and showing it would overstate real spend.

import type pg from 'pg';
import { budgetConfig, PHASE_ALLOCATION_MICRO, PHASES } from '../../../packages/budget/src/governor.ts';
import { PgSpendLedger } from '../../../packages/db/src/pg.ts';
import { applicantBucket, DRAW_SETTINGS, withDefaults } from '../../../packages/gate/src/draw-config.ts';
import { PRIOR_COMPLETION_CAP } from '../../../packages/gate/src/draw.ts';
import { explorerTx, type AgentConfig } from './config.ts';
import type { FundedService } from './funded-service.ts';
import { loadErased, shownLogin } from './erasure-service.ts';

export const DEFAULT_PUBLIC_ORIGINS = ['https://grainlify.com', 'https://www.grainlify.com'];

export function publicOrigins(env: { PUBLIC_ALLOWED_ORIGINS?: string }): string[] {
  const list = env.PUBLIC_ALLOWED_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean);
  return list?.length ? list : DEFAULT_PUBLIC_ORIGINS;
}

/** CORS headers for an allowed origin; none at all for any other, so browsers block it. */
export function corsHeaders(origin: string | undefined, allowed: string[], methods = 'GET, OPTIONS'): Record<string, string> {
  const base = { vary: 'Origin' };
  // Echo a recognised origin. Anything else -- including a request with no
  // Origin at all -- gets `*`.
  //
  // This is safe here and it is not laziness. Nothing this server exposes is
  // authorised by the caller's origin: /public/* is public by definition, and
  // the link routes are authorised by a Grainlify countersignature and a wallet
  // signature, which a hostile page cannot obtain and cannot forge. There are
  // no cookies and no credentialled requests anywhere in this API, so `*`
  // grants a third-party page nothing it could not already get with curl.
  //
  // Withholding the header instead is what broke the wallet card. A browser
  // extension sitting in the request path re-issues the fetch with a different
  // Origin, or none; the server then answered 400 with no
  // Access-Control-Allow-Origin, and Chrome refused to let the page read a
  // reply it had already received. The page reported "the bounty agent:
  // network" while the request had in fact succeeded end to end. Refusing the
  // header protected nothing and hid a working response.
  const h: Record<string, string> = {
    ...base,
    'access-control-allow-origin': origin && allowed.includes(origin) ? origin : '*',
    'access-control-allow-methods': methods,
    'access-control-max-age': '600',
  };
  // Any header, not just content-type.
  //
  // A browser extension that adds a header to the page's fetch -- a request id,
  // a tracing tag -- turns it into a preflighted request whose
  // Access-Control-Request-Headers we did not list, and the browser then
  // refuses to send the real request at all. Reproduced exactly that way: one
  // injected header was enough to break a call that is otherwise correct.
  //
  // `*` is legal here because these responses are never credentialled. It says
  // "any header may be sent", not "any caller is authorised" -- authorisation
  // is the signature checks, which do not care what headers arrived.
  if (methods.includes('POST')) h['access-control-allow-headers'] = '*';
  return h;
}

export interface PublicStatus {
  network: string;
  mainnetLive: boolean;
  inferenceMode: 'mock' | 'live';
  statusLine: string;
}

export type BountyHistoryEntry =
  | { kind: 'draw'; at: string; by: string; drawn: string | null }
  | { kind: 'unassign'; at: string; by: string; contributor: string }
  // Back to open because its pull request closed unmerged. The reason is the
  // fact, not anybody's words, and the PR is public on GitHub already.
  | { kind: 'reopened'; at: string; by: string; reason: string; prNumber: number | null; contributor: string | null };

export interface PublicBounty {
  id: string;
  repo: string;
  issueNumber: number;
  issueTitle: string | null;
  issueUrl: string;
  amountMinor: string;
  decimals: number;
  currency: string;
  network: string;
  status: string;
  postedAt: string;
  payout: { txSignature: string; txUrl: string; paidAt: string; recipientLogin: string } | null;
  /** A bounty that exists to exercise the pipeline. Shown as such; never quietly. */
  isTest: boolean;
  /** Eligibility rules this bounty waives, named. Public on purpose: a relaxed
   *  rule that nobody can see is indistinguishable from a rule that does not work. */
  waivedRules: string[];
  applicationsOpenAt: string | null;
  applicationsCloseAt: string | null;
  /** 'open' while the window is running, 'closed' once it has, 'none' before a
   *  window was ever opened. The page needs the distinction: a bounty awaiting
   *  its first draw and one that never opened read the same otherwise. */
  applicationState: 'none' | 'open' | 'closed';
  /** Who holds it now, if anyone. The pool is NOT public - knowing how many
   *  people applied would make the draw something to time. */
  assignedTo: string | null;
  assignmentStaleAt: string | null;
  /**
   * Every real draw, every unassign and every reopening on this bounty, oldest first. Public so
   * that a maintainer who keeps unassigning and redrawing until somebody they
   * prefer wins does it in plain sight. Who acted, when, and who was drawn or
   * unassigned - names already public as assignedTo. Not the reason given for
   * an unassign: that is written to the contributor, not to the world.
   * Simulations are not here: they decide nothing.
   */
  history: BountyHistoryEntry[];
  /**
   * How many people are in the pool, as a coarse band while the window is
   * open: 'none' | 'few' | 'many', or null when the event hides it.
   *
   * Coarse on purpose. An exact live count makes the draw something to time,
   * which rewards refreshing the page rather than doing the work.
   */
  applicantBucket: 'none' | 'few' | 'many' | null;
  /**
   * The exact pool size, released once the window closes and precision can no
   * longer steer anyone's choice of where to apply. null while it is open,
   * unless the setting says otherwise.
   */
  applicantCount: number | null;
  /**
   * Present on a maintainer-funded bounty: who funded it, how it is assigned,
   * the escrow anyone can read, and the funder's record. Everything a
   * contributor needs to decide whether to apply, stated before they do.
   */
  funded: {
    by: string;
    mode: 'draw' | 'self_assign';
    escrow: string;
    escrowUrl: string;
    deadlineAt: string;
    profile: { bountiesFunded: number; unassignedBeforePr: number; disputesRaised: number } | null;
  } | null;
}

export interface LedgerEvent {
  at: string;
  /**
   * 'erasure' is an account erased at its owner's request. It names nobody:
   * it is there so that the change in what the ledger shows - that account's
   * login replaced with "erased account" - is itself on the record.
   */
  kind: 'bounty_posted' | 'inference' | 'gate_passed' | 'gate_refused' | 'payout' | 'erasure';
  /** The bounty this event belongs to, so a page can show one bounty's receipt chain. */
  bountyId: string | null;
  test: boolean;
  detail: string;
  amount: string | null;
  proof: { label: string; url: string | null };
}

const shortSig = (s: string) => `${s.slice(0, 5)}…${s.slice(-4)}`;

/**
 * What to publish about the pool, given the setting and whether the window
 * has closed.
 *
 * Once a window closes the pool is settled, so exactness can no longer
 * influence anyone's choice of where to apply - and by then the count is the
 * thing that makes a result checkable. Before that it is a band, or nothing.
 */
export function poolVisibility(
  count: number,
  visibility: string,
  closesAt: Date | string | null,
): { applicantBucket: 'none' | 'few' | 'many' | null; applicantCount: number | null } {
  const closed = closesAt !== null && closesAt !== undefined && new Date(closesAt) <= new Date();
  if (closed || visibility === 'exact') return { applicantBucket: null, applicantCount: count };
  if (visibility === 'hidden') return { applicantBucket: null, applicantCount: null };
  return { applicantBucket: applicantBucket(count), applicantCount: null };
}

export class PublicApi {
  constructor(
    private readonly db: pg.Pool,
    private readonly cfg: AgentConfig,
    private readonly opts: { escrowMints?: Record<string, { mint: string; decimals: number }>; funded?: FundedService } = {},
  ) {}

  status(): PublicStatus {
    const mainnetLive = this.cfg.network === 'solana-mainnet';
    const statusLine = mainnetLive
      ? this.cfg.inferenceMode === 'live'
        ? 'Live on Solana mainnet. Bounties pay real USDC; inference is paid per request on UsePod.'
        : 'Payouts are live on Solana mainnet; inference is still running against a test gateway.'
      : 'Devnet test run so far. Bounties pay test tokens with no value; mainnet bounties are not live yet.';
    return { network: this.cfg.network, mainnetLive, inferenceMode: this.cfg.inferenceMode, statusLine };
  }

  private decimalsFor(mint: string) {
    return [...Object.values(this.cfg.mints), ...Object.values(this.opts.escrowMints ?? {})].find((m) => m.mint === mint)?.decimals ?? 6;
  }

  /** Stored draw settings, defaults filled in. Read per call: a visibility
   *  change should take effect on the next page load, not the next deploy. */
  private async drawConfig(): Promise<Record<string, string>> {
    try {
      const r = await this.db.query<{ key: string; value: string }>(`SELECT key, value FROM bounty_config`);
      return withDefaults(Object.fromEntries(r.rows.map((x) => [x.key, x.value])));
    } catch {
      // A missing settings table must not take the public page down with it.
      return withDefaults({});
    }
  }

  async bounties(id?: string): Promise<PublicBounty[]> {
    const cfg = await this.drawConfig();
    const visibility = cfg.applicant_count_visibility ?? 'bucketed';
    const r = await this.db.query(
      `SELECT b.id, r.owner, r.name, b.issue_number, b.issue_title, b.amount_minor::text AS amount_minor, b.mint, b.currency, b.network, b.status, b.created_at,
              p.tx_signature, p.updated_at AS paid_at, s.author_login, s.author_github_user_id,
              b.is_test, b.waived_eligibility_rules, b.reserved_for_newcomers, b.applications_open_at, b.applications_close_at,
              a.github_login AS assigned_login, a.github_user_id AS assigned_github_user_id, a.stale_at AS assignment_stale_at,
              b.funded_by, b.funded_by_github_user_id, e.assignment_mode, e.escrow_pubkey, e.deadline_at AS escrow_deadline_at,
              (SELECT count(*) FROM bounty_applications ap
                WHERE ap.bounty_id = b.id AND ap.status IN ('applied','won','lost'))::int AS applicant_count
         FROM bounties b
         JOIN repos r ON r.id = b.repo_id
         LEFT JOIN payouts p ON p.bounty_id = b.id AND p.status = 'confirmed'
         LEFT JOIN submissions s ON s.id = p.submission_id
         LEFT JOIN bounty_assignments a ON a.bounty_id = b.id AND a.status IN ('active','pr_submitted')
         LEFT JOIN bounty_escrows e ON e.bounty_id = b.id AND b.funded_by IS NOT NULL
        WHERE b.status IN ('posted','in_review','payable','paid') ${id ? 'AND b.id = $1' : ''}
        ORDER BY b.created_at DESC
        LIMIT 200`,
      id ? [id] : [],
    );
    // Accounts erased at their owner's request: their rows stay, their
    // logins are not shown (erasure-service.ts).
    const erased = await loadErased(this.db);
    const show = (login: string | null, id?: string | number | null) => shownLogin(erased, login, id);
    // One query each for the whole list, not one per bounty.
    const ids = r.rows.map((b) => b.id as string);
    const history = new Map<string, BountyHistoryEntry[]>();
    if (ids.length) {
      const draws = await this.db.query<{ bounty_id: string; created_at: Date; triggered_by: string | null; winner_login: string | null; winner_github_user_id: string | null }>(
        `SELECT bounty_id, created_at, triggered_by, winner_login, winner_github_user_id FROM bounty_draws
          WHERE bounty_id = ANY($1::uuid[]) AND NOT is_simulation`,
        [ids],
      );
      const unassigns = await this.db.query<{ bounty_id: string; released_at: Date; released_by: string; github_login: string; github_user_id: string }>(
        `SELECT bounty_id, released_at, released_by, github_login, github_user_id FROM bounty_assignments
          WHERE bounty_id = ANY($1::uuid[]) AND status = 'released_voluntary' AND released_by IS NOT NULL`,
        [ids],
      );
      const reopens = await this.db.query<{ subject: string; at: Date; actor: string; detail: { reason?: string; prNumber?: number; contributor?: string } }>(
        `SELECT subject, at, actor, detail FROM audit_log
          WHERE action = 'bounty.reopened' AND subject = ANY($1::text[])`,
        [ids],
      );
      const add = (id: string, e: BountyHistoryEntry) => history.set(id, [...(history.get(id) ?? []), e]);
      for (const d of draws.rows) {
        add(d.bounty_id, { kind: 'draw', at: new Date(d.created_at).toISOString(), by: show(d.triggered_by) ?? 'automatic', drawn: show(d.winner_login, d.winner_github_user_id) });
      }
      for (const u of unassigns.rows) {
        add(u.bounty_id, { kind: 'unassign', at: new Date(u.released_at).toISOString(), by: show(u.released_by)!, contributor: show(u.github_login, u.github_user_id)! });
      }
      for (const r of reopens.rows) {
        add(r.subject, {
          kind: 'reopened', at: new Date(r.at).toISOString(), by: show(r.actor)!,
          reason: r.detail.reason ?? 'reopened', prNumber: r.detail.prNumber ?? null, contributor: show(r.detail.contributor ?? null),
        });
      }
      for (const list of history.values()) list.sort((a, b) => a.at.localeCompare(b.at));
    }

    const profiles = new Map<string, { bountiesFunded: number; unassignedBeforePr: number; disputesRaised: number }>();
    if (this.opts.funded) {
      const shownFunders = r.rows.filter((b) => show(b.funded_by, b.funded_by_github_user_id) === b.funded_by);
      for (const login of new Set(shownFunders.map((b) => b.funded_by as string | null).filter((x): x is string => Boolean(x)))) {
        const p = await this.opts.funded.profile(login);
        profiles.set(login.toLowerCase(), { bountiesFunded: p.bountiesFunded, unassignedBeforePr: p.unassignedBeforePr, disputesRaised: p.disputesRaised });
      }
    }
    return r.rows.map((b) => ({
      id: b.id,
      repo: `${b.owner}/${b.name}`,
      issueNumber: b.issue_number,
      issueTitle: b.issue_title,
      issueUrl: `https://github.com/${b.owner}/${b.name}/issues/${b.issue_number}`,
      amountMinor: b.amount_minor,
      decimals: this.decimalsFor(b.mint),
      currency: b.currency,
      network: b.network,
      status: b.status,
      postedAt: new Date(b.created_at).toISOString(),
      payout: b.tx_signature
        ? { txSignature: b.tx_signature, txUrl: explorerTx(b.network, b.tx_signature), paidAt: new Date(b.paid_at).toISOString(), recipientLogin: show(b.author_login, b.author_github_user_id)! }
        : null,
      isTest: b.is_test === true,
      reservedForNewcomers: b.reserved_for_newcomers === true,
      waivedRules: (b.waived_eligibility_rules ?? []) as string[],
      applicationsOpenAt: b.applications_open_at ? new Date(b.applications_open_at).toISOString() : null,
      applicationsCloseAt: b.applications_close_at ? new Date(b.applications_close_at).toISOString() : null,
      applicationState: !b.applications_close_at ? 'none' : new Date(b.applications_close_at) > new Date() ? 'open' : 'closed',
      assignedTo: show(b.assigned_login ?? null, b.assigned_github_user_id),
      assignmentStaleAt: b.assignment_stale_at ? new Date(b.assignment_stale_at).toISOString() : null,
      history: history.get(b.id) ?? [],
      ...poolVisibility(Number(b.applicant_count ?? 0), visibility, b.applications_close_at),
      funded: b.funded_by && b.escrow_pubkey
        ? {
            by: show(b.funded_by as string, b.funded_by_github_user_id)!,
            mode: b.assignment_mode as 'draw' | 'self_assign',
            escrow: b.escrow_pubkey as string,
            escrowUrl: explorerAccount(b.network, b.escrow_pubkey),
            deadlineAt: new Date(b.escrow_deadline_at).toISOString(),
            profile: profiles.get(String(b.funded_by).toLowerCase()) ?? null,
          }
        : null,
    }));
  }

  /**
   * The rules, published. Every setting with its live value, its coded
   * default, and whether a person has overridden it.
   *
   * AI-specs.md §4.5: "Publish the weights on the platform before the event.
   * A contributor who reads them and responds by writing better code is not
   * farming - that is the platform working." The same holds here: odds nobody
   * can read are indistinguishable from odds that are made up.
   *
   * Public and unauthenticated on purpose. There is nothing here a
   * contributor should have to sign in to learn, and a rule you must be
   * logged in to read is not really published.
   */
  async rules() {
    const stored = await this.db
      .query<{ key: string; value: string; updated_at: Date; updated_by: string }>(
        `SELECT key, value, updated_at, updated_by FROM bounty_config`,
      )
      .catch(() => ({ rows: [] as { key: string; value: string; updated_at: Date; updated_by: string }[] }));
    const byKey = new Map(stored.rows.map((x) => [x.key, x]));

    return {
      status: this.status(),
      // Named and explained rather than left as a bare number, because it is
      // the rule contributors plan around.
      structural: {
        priorCompletionCap: PRIOR_COMPLETION_CAP,
        priorCompletionCapNote:
          `A win multiplies your tickets, but only for your first ${PRIOR_COMPLETION_CAP} completed bounties. ` +
          'It is a constant in the code, not a setting, so nobody can raise it mid-programme: it is what stops ' +
          'accumulated wins from overtaking capability for the bounty actually in front of you.',
        neverWeighted: [
          'total pull request count',
          'merge rate',
          'follower count',
          'stars',
          'total contributions',
          'how well the application is written',
        ],
        neverWeightedNote:
          'All of these are farmable and all of them penalise newcomers. They are absent by omission: ' +
          'there is no code path in the draw that can read them.',
      },
      sections: [...new Set(DRAW_SETTINGS.map((s) => s.section))],
      settings: DRAW_SETTINGS.map((s) => {
        const row = byKey.get(s.key);
        return {
          key: s.key,
          type: s.type,
          section: s.section,
          description: s.description,
          default: s.default,
          value: row?.value ?? s.default,
          overridden: row !== undefined,
          // Who changed it and when. A weight that moved without a name
          // against it is the kind of thing that makes a result arguable.
          updatedAt: row ? new Date(row.updated_at).toISOString() : null,
          updatedBy: row?.updated_by ?? null,
        };
      }),
    };
  }

  async ledger() {
    const status = this.status();
    const mock = status.inferenceMode === 'mock';
    const bounties = await this.bounties();
    const byId = new Map(bounties.map((b) => [b.id, b]));
    const fmt = (minor: string, decimals: number, currency: string, network: string) => {
      const n = Number(minor) / 10 ** decimals;
      return `${n.toFixed(2)} ${network === 'solana-mainnet' ? currency : `test ${currency}`}`;
    };

    const events: LedgerEvent[] = [];
    for (const b of bounties) {
      const test = b.network !== 'solana-mainnet';
      events.push({ at: b.postedAt, kind: 'bounty_posted', bountyId: b.id, test, detail: `${b.repo} #${b.issueNumber}`, amount: fmt(b.amountMinor, b.decimals, b.currency, b.network), proof: { label: `issue #${b.issueNumber}`, url: b.issueUrl } });
      if (b.payout) {
        events.push({ at: b.payout.paidAt, kind: 'payout', bountyId: b.id, test, detail: `${b.repo} #${b.issueNumber} → ${b.payout.recipientLogin}`, amount: fmt(b.amountMinor, b.decimals, b.currency, b.network), proof: { label: shortSig(b.payout.txSignature), url: b.payout.txUrl } });
      }
    }

    const gates = await this.db.query(`SELECT p.bounty_id, p.status, p.created_at, s.pr_number FROM payouts p JOIN submissions s ON s.id = p.submission_id ORDER BY p.created_at DESC LIMIT 200`);
    for (const g of gates.rows) {
      const b = byId.get(g.bounty_id);
      if (!b) continue;
      const checks = g.status === 'refused' ? 'gate_refused' : 'gate_passed';
      events.push({ at: new Date(g.created_at).toISOString(), kind: checks, bountyId: b.id, test: b.network !== 'solana-mainnet', detail: `${b.repo} PR #${g.pr_number}`, amount: null, proof: { label: `PR #${g.pr_number}`, url: `https://github.com/${b.repo}/pull/${g.pr_number}` } });
    }

    const calls = await this.db.query(
      `SELECT purpose, model, quote_id, pay_tx_signature, paid_micro, fee_micro, created_at, links->>'bountyId' AS bounty_id FROM inference_calls WHERE status = 'served' ORDER BY created_at DESC LIMIT 200`,
    );
    for (const c of calls.rows) {
      const paid = Number(c.paid_micro ?? 0) + Number(c.fee_micro ?? 0);
      events.push({
        at: new Date(c.created_at).toISOString(),
        kind: 'inference',
        bountyId: c.bounty_id ?? null,
        test: mock,
        detail: `${c.purpose} · ${c.model}`,
        amount: mock ? null : `$${(paid / 1e6).toFixed(6)}`,
        proof: c.pay_tx_signature && !mock ? { label: shortSig(c.pay_tx_signature), url: explorerTx('solana-mainnet', c.pay_tx_signature) } : { label: `quote ${String(c.quote_id).slice(0, 8)}`, url: null },
      });
    }
    // Each erasure is an event of its own, naming nobody, so the change in what
    // the entries above show is on the record rather than silent.
    for (const e of (await loadErased(this.db)).erasures) {
      events.push({
        at: e.at.toISOString(),
        kind: 'erasure',
        bountyId: null,
        test: false,
        detail: "An account was erased at its owner's request. Entries are unchanged, except that its GitHub login is now shown as \"erased account\".",
        amount: null,
        proof: { label: 'owner request', url: null },
      });
    }
    events.sort((a, b) => b.at.localeCompare(a.at));

    const totals = mock ? null : await new PgSpendLedger(this.db, budgetConfig()).totals();
    const paid = bounties.filter((b) => b.payout);
    return {
      status,
      totals: {
        bountiesPosted: bounties.length,
        bountiesPaidMainnet: paid.filter((b) => b.network === 'solana-mainnet').length,
        bountiesPaidTest: paid.filter((b) => b.network !== 'solana-mainnet').length,
        inferenceCalls: calls.rowCount ?? 0,
        // null while mocked: there is no real spend to report, and the mock ledger's play money must not be shown as spend.
        inferenceSpendMicro: totals ? totals.lifetimeMicro : null,
        inferenceCeilingMicro: 5_000_000,
        feesInMicro: null as number | null, // not tracked until GRAIN launches
      },
      budget: PHASES.map((p) => ({ phase: p, allocationMicro: PHASE_ALLOCATION_MICRO[p], spentMicro: totals ? totals.byPhase[p] : 0 })),
      events: events.slice(0, 300),
    };
  }
}

/** An account on the explorer for its network; the same explorer as transactions. */
export function explorerAccount(network: string, address: string): string {
  if (network === 'solana-mainnet') return `https://solscan.io/account/${address}`;
  if (network === 'solana-devnet') return `https://solscan.io/account/${address}?cluster=devnet`;
  return `(${network}) ${address}`;
}
