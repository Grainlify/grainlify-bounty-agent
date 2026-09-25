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
import { computeMetrics } from '../../../packages/budget/src/metrics.ts';
import { PgSpendLedger } from '../../../packages/db/src/pg.ts';
import { explorerTx, type AgentConfig } from './config.ts';

export const DEFAULT_PUBLIC_ORIGINS = ['https://grainlify.com', 'https://www.grainlify.com'];

export function publicOrigins(env: { PUBLIC_ALLOWED_ORIGINS?: string }): string[] {
  const list = env.PUBLIC_ALLOWED_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean);
  return list?.length ? list : DEFAULT_PUBLIC_ORIGINS;
}

/** CORS headers for an allowed origin; none at all for any other, so browsers block it. */
export function corsHeaders(origin: string | undefined, allowed: string[], methods = 'GET, OPTIONS'): Record<string, string> {
  const base = { vary: 'Origin' };
  if (!origin || !allowed.includes(origin)) return base;
  const h: Record<string, string> = { ...base, 'access-control-allow-origin': origin, 'access-control-allow-methods': methods, 'access-control-max-age': '600' };
  if (methods.includes('POST')) h['access-control-allow-headers'] = 'content-type';
  return h;
}

export interface PublicStatus {
  network: string;
  mainnetLive: boolean;
  inferenceMode: 'mock' | 'live';
  statusLine: string;
}

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
}

export interface LedgerEvent {
  at: string;
  kind: 'bounty_posted' | 'inference' | 'gate_passed' | 'gate_refused' | 'payout';
  bountyId: string | null;
  test: boolean;
  detail: string;
  amount: string | null;
  proof: { label: string; url: string | null };
}

export interface LedgerResponse {
  events: LedgerEvent[];
  metrics: {
    inferenceTotal: number | null;
    networkFeeTotal: number | null;
    costPerServedCall: number | null;
    costPerMergedPr: number | null;
    callCountOnChain: number;
    callCountSurplus: number;
  };
}

const shortSig = (s: string) => `${s.slice(0, 5)}…${s.slice(-4)}`;

export class PublicApi {
  constructor(private readonly db: pg.Pool, private readonly cfg: AgentConfig) {}

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
    return Object.values(this.cfg.mints).find((m) => m.mint === mint)?.decimals ?? 6;
  }

  async bounties(id?: string): Promise<PublicBounty[]> {
    const r = await this.db.query(
      `SELECT b.id, r.owner, r.name, b.issue_number, b.issue_title, b.amount_minor::text AS amount_minor, b.mint, b.currency, b.network, b.status, b.created_at,
              p.tx_signature, p.updated_at AS paid_at, s.author_login
         FROM bounties b
         JOIN repos r ON r.id = b.repo_id
         LEFT JOIN payouts p ON p.bounty_id = b.id AND p.status = 'confirmed'
         LEFT JOIN submissions s ON s.id = p.submission_id
        WHERE b.status IN ('posted','in_review','payable','paid') ${id ? 'AND b.id = $1' : ''}
        ORDER BY b.created_at DESC
        LIMIT 200`,
      id ? [id] : [],
    );
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
        ? { txSignature: b.tx_signature, txUrl: explorerTx(b.network, b.tx_signature), paidAt: new Date(b.paid_at).toISOString(), recipientLogin: b.author_login }
        : null,
    }));
  }

  async ledger(): Promise<LedgerResponse> {
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

    const calls = await this.db.query(`SELECT purpose, model, quote_id, pay_tx_signature, paid_micro, fee_micro, created_at, links->>'bountyId' AS bounty_id FROM inference_calls WHERE status = 'served' ORDER BY created_at DESC LIMIT 200`);
    for (const c of calls.rows) {
      events.push({ at: new Date(c.created_at).toISOString(), kind: 'inference', bountyId: c.bounty_id, test: mock, detail: `${c.model} (${c.purpose})`, amount: mock ? null : `${(Number(c.paid_micro) / 1e6).toFixed(6)} USDC`, proof: { label: shortSig(c.pay_tx_signature), url: explorerTx('solana-mainnet', c.pay_tx_signature) } });
    }

    const dbLedger = new PgSpendLedger(this.db);
    const metrics = await computeMetrics(dbLedger);

    return {
      events,
      metrics: {
        inferenceTotal: mock ? null : metrics.inferenceTotal,
        networkFeeTotal: mock ? null : metrics.networkFeeTotal,
        costPerServedCall: mock ? null : metrics.costPerServedCall,
        costPerMergedPr: mock ? null : metrics.costPerMergedPr,
        callCountOnChain: metrics.callCountOnChain,
        callCountSurplus: metrics.callCountSurplus,
      },
    };
  }
}