// Talking to Grainlify-Backend about GrainHack: fetching results statements,
// and telling it what happened so it can notify winners. Every call carries
// bearer GRAINHACK_STATEMENT_TOKEN (statements say who is held for KYC, so
// none of this is public). The backend is authoritative for these routes
// (internal/handlers/grainhack_payout.go):
//
//   GET  /grainhack/results-statements/:statement_id           -> {statement, signature}
//   GET  /grainhack/hackathons/:hackathon_id/results-statement -> {statement, signature}, the head of the chain
//   POST /grainhack/payments        {statement_id, github_user_id, amount_minor, currency, network, tx_signature, recipient}
//                                   -> {accepted, duplicate, notified}
//   POST /grainhack/awaiting-wallet {statement_id, github_user_ids: [...]} -> {notified, skipped}
//
// Statements are found by polling the latest one for each settled event
// (discoverStatements), walking back through `supersedes` to whatever this
// agent already has, so a statement issued while the agent was down is not
// skipped. Importing never moves money: each payment still needs a person.
//
// Reports: an outbox (grainhack_reports). grainhack_paid after the signer
// confirms; grainhack_link_wallet for a payable winner with no live Solana
// wallet link. Each is delivered at most once per dedupe key. A refusal the
// backend gives by name (400, 409) is final: retrying cannot change it, so it
// is kept visible with its error and not retried. Anything else (network,
// 401, 5xx) is retried, up to ten attempts.

import type pg from 'pg';
import type { GrainhackService } from './service.ts';

export const REPORT_TICK_MS = 30_000;
export const MAX_REPORT_ATTEMPTS = 10;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface SignedStatement {
  statement: string;
  signature: string;
}

export interface StatementSource {
  fetch(statementId: string): Promise<SignedStatement>;
  /** The head of the event's contributor-pool chain, or null when none is issued (404) or it has been redacted (410). */
  latest(hackathonId: string): Promise<SignedStatement | null>;
  /** Events a statement can exist for: the backend's public list, settled ones only. */
  settledHackathons(): Promise<string[]>;
}

export class BackendStatementSource implements StatementSource {
  private readonly baseUrl: string;
  constructor(baseUrl: string, private readonly token: string, private readonly f: typeof fetch = fetch) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  private async get(path: string, auth: boolean) {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (auth) headers.authorization = `Bearer ${this.token}`;
    return this.f(`${this.baseUrl}${path}`, { headers });
  }

  private static async signed(r: Response): Promise<SignedStatement> {
    if (!r.ok) throw new Error(`backend: ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`);
    const j = (await r.json()) as { statement?: unknown; signature?: unknown };
    if (typeof j.statement !== 'string' || typeof j.signature !== 'string') throw new Error('backend: response is not { statement: string, signature: string }');
    return { statement: j.statement, signature: j.signature };
  }

  async fetch(statementId: string) {
    if (!UUID.test(statementId)) throw new Error('statement id must be a uuid');
    return BackendStatementSource.signed(await this.get(`/grainhack/results-statements/${statementId}`, true));
  }

  async latest(hackathonId: string) {
    if (!UUID.test(hackathonId)) throw new Error('hackathon id must be a uuid');
    const r = await this.get(`/grainhack/hackathons/${hackathonId}/results-statement`, true);
    if (r.status === 404 || r.status === 410) return null;
    return BackendStatementSource.signed(r);
  }

  async settledHackathons() {
    const r = await this.get('/hackathons', false);
    if (!r.ok) throw new Error(`backend: GET /hackathons ${r.status}`);
    const j = (await r.json()) as { hackathons?: { id?: unknown; phase?: unknown }[] };
    return (j.hackathons ?? []).filter((h) => h.phase === 'settled' && typeof h.id === 'string' && UUID.test(h.id)).map((h) => h.id as string);
  }
}

export interface DiscoverResult {
  checked: number;
  imported: { hackathonId: string; statementId: string }[];
  errors: { hackathonId: string; error: string }[];
}

/**
 * Imports any statement the backend has issued that this agent has not, for
 * each settled event and each event it already holds statements for. The
 * chain is walked back through `supersedes` until a statement already held
 * (or the root), then imported oldest first, so each one supersedes the
 * agent's current statement as importStatement requires.
 */
export async function discoverStatements(
  d: { db: pg.Pool; source: StatementSource; service: GrainhackService; log?: (l: string) => void },
  hackathonIds?: string[],
): Promise<DiscoverResult> {
  const log = d.log ?? (() => {});
  let ids = hackathonIds;
  if (!ids) {
    const known = (await d.db.query<{ hackathon_id: string }>(`SELECT DISTINCT hackathon_id::text FROM grainhack_statements`)).rows.map((r) => r.hackathon_id);
    ids = [...new Set([...(await d.source.settledHackathons()), ...known])];
  }
  const out: DiscoverResult = { checked: 0, imported: [], errors: [] };
  for (const hid of ids) {
    out.checked++;
    try {
      const head = await d.source.latest(hid);
      if (!head) continue;
      const chain: SignedStatement[] = [head];
      for (let depth = 0; depth < 50; depth++) {
        const s = JSON.parse(chain[0]!.statement) as { statement_id?: unknown; supersedes?: unknown };
        if (typeof s.statement_id !== 'string') throw new Error('statement has no statement_id');
        if (await d.service.statement(s.statement_id)) {
          chain.shift(); // already held: nothing to import from here back
          break;
        }
        if (typeof s.supersedes !== 'string') break;
        chain.unshift(await d.source.fetch(s.supersedes));
      }
      for (const st of chain) {
        const r = await d.service.importStatement(st, 'grainhack-poll');
        if (!r.ok) throw new Error(r.error);
        if (!r.alreadyImported) {
          out.imported.push({ hackathonId: r.hackathonId, statementId: r.statementId });
          log(`grainhack: imported statement ${r.statementId} for ${r.hackathonId} (${Object.entries(r.byStatus).map(([k, v]) => `${k}=${v}`).join(' ')})`);
        }
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      out.errors.push({ hackathonId: hid, error });
      log(`grainhack: could not import the statement for ${hid}: ${error}`);
    }
  }
  return out;
}

export type ReportKind = 'grainhack_paid' | 'grainhack_link_wallet';

/** Queues a report, or does nothing if one with this key exists. Never throws: a payment must not fail because a notification could not be queued. */
export async function enqueueReport(db: pg.Pool | pg.PoolClient, r: { kind: ReportKind; githubUserId: number; dedupeKey: string; payload: Record<string, unknown> }): Promise<boolean> {
  try {
    const q = await db.query(
      `INSERT INTO grainhack_reports (kind, github_user_id, payload, dedupe_key) VALUES ($1, $2, $3::jsonb, $4) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
      [r.kind, r.githubUserId, JSON.stringify(r.payload), r.dedupeKey],
    );
    return (q.rowCount ?? 0) > 0;
  } catch (e) {
    console.log(`grainhack report enqueue failed, continuing: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

export interface ReporterDeps {
  db: pg.Pool;
  backendUrl?: string;
  /** GRAINHACK_STATEMENT_TOKEN: the same bearer the statement routes take. */
  token?: string;
  f?: typeof fetch;
  log?: (line: string) => void;
}

/** The backend route and body for one queued report. */
export function reportRequest(kind: string, githubUserId: number, payload: Record<string, unknown>): { path: string; body: Record<string, unknown> } {
  if (kind === 'grainhack_paid') {
    return {
      path: '/grainhack/payments',
      body: {
        statement_id: payload.statement_id, github_user_id: githubUserId, amount_minor: payload.amount_minor, currency: payload.currency,
        network: payload.network, tx_signature: payload.tx_signature, recipient: payload.recipient,
      },
    };
  }
  if (kind === 'grainhack_link_wallet') {
    return { path: '/grainhack/awaiting-wallet', body: { statement_id: payload.statement_id, github_user_ids: [githubUserId] } };
  }
  throw new Error(`unknown GrainHack report kind ${kind}`);
}

/** Delivers one batch; returns how many were delivered. */
export async function deliverReports(d: ReporterDeps, limit = 20): Promise<number> {
  if (!d.backendUrl || !d.token) return 0;
  const f = d.f ?? fetch;
  const log = d.log ?? console.log;
  const base = d.backendUrl.replace(/\/+$/, '');
  const rows = await d.db.query<{ id: string; kind: string; github_user_id: string; payload: Record<string, unknown> }>(
    `SELECT id, kind, github_user_id, payload FROM grainhack_reports WHERE delivered_at IS NULL AND attempts < $2 ORDER BY created_at LIMIT $1`,
    [limit, MAX_REPORT_ATTEMPTS],
  );
  let sent = 0;
  for (const row of rows.rows) {
    const fail = (error: string, final: boolean) =>
      final
        ? d.db.query(`UPDATE grainhack_reports SET attempts = $3, last_error = $2 WHERE id = $1`, [row.id, error.slice(0, 500), MAX_REPORT_ATTEMPTS])
        : d.db.query(`UPDATE grainhack_reports SET attempts = attempts + 1, last_error = $2 WHERE id = $1`, [row.id, error.slice(0, 500)]);
    let req: ReturnType<typeof reportRequest>;
    try {
      req = reportRequest(row.kind, Number(row.github_user_id), row.payload);
    } catch (e) {
      await fail(String(e instanceof Error ? e.message : e), true);
      continue;
    }
    try {
      const res = await f(`${base}${req.path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${d.token}` }, body: JSON.stringify(req.body) });
      const text = await res.text().catch(() => '');
      if (res.ok) {
        await d.db.query(`UPDATE grainhack_reports SET delivered_at = now(), last_error = NULL, attempts = attempts + 1 WHERE id = $1`, [row.id]);
        sent++;
      } else if (res.status === 400 || res.status === 409) {
        // The backend refused it by name; it will say the same thing every time.
        log(`GRAINHACK REPORT REFUSED (${row.kind} for github_user_id ${row.github_user_id}): ${res.status} ${text.slice(0, 300)}`);
        await fail(`refused: ${res.status} ${text}`, true);
      } else {
        await fail(`${res.status} ${text}`, false);
      }
    } catch (e) {
      await fail(String(e instanceof Error ? e.message : e), false);
    }
  }
  return sent;
}
