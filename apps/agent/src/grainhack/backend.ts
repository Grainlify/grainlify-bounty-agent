// Talking to Grainlify-Backend about GrainHack: fetching a results statement,
// and telling it what happened so it can notify winners.
//
// Statements: GET {GRAINHACK_BACKEND_URL}/grainhack/results-statements/:id with
// bearer GRAINHACK_STATEMENT_TOKEN (contract §1). They say who is held for KYC,
// so they are not public.
//
// Reports: an outbox (grainhack_reports), delivered to
// {GRAINHACK_BACKEND_URL}{GRAINHACK_REPORT_PATH} with bearer
// GRAINHACK_REPORT_TOKEN. The path is configurable because the backend's
// endpoint is not fixed by the contract yet. Kinds: grainhack_paid (after the
// signer confirms) and grainhack_link_wallet (a payable winner with no live
// Solana wallet link). Each is delivered at most once per dedupe key, retried
// on failure, and left visible with its error after ten attempts.

import type pg from 'pg';

export const DEFAULT_REPORT_PATH = '/internal/grainhack/payout-events';
export const REPORT_TICK_MS = 30_000;

export interface StatementSource {
  fetch(statementId: string): Promise<{ statement: string; signature: string }>;
}

export class BackendStatementSource implements StatementSource {
  private readonly baseUrl: string;
  constructor(baseUrl: string, private readonly token: string, private readonly f: typeof fetch = fetch) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async fetch(statementId: string) {
    if (!/^[0-9a-f-]{36}$/.test(statementId)) throw new Error('statement id must be a uuid');
    const r = await this.f(`${this.baseUrl}/grainhack/results-statements/${statementId}`, { headers: { authorization: `Bearer ${this.token}`, accept: 'application/json' } });
    if (!r.ok) throw new Error(`backend: ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`);
    const j = (await r.json()) as { statement?: unknown; signature?: unknown };
    if (typeof j.statement !== 'string' || typeof j.signature !== 'string') throw new Error('backend: response is not { statement: string, signature: string }');
    return { statement: j.statement, signature: j.signature };
  }
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
  path?: string;
  token?: string;
  f?: typeof fetch;
  log?: (line: string) => void;
}

/** Delivers one batch; returns how many were delivered. */
export async function deliverReports(d: ReporterDeps, limit = 20): Promise<number> {
  if (!d.backendUrl || !d.token) return 0;
  const f = d.f ?? fetch;
  const url = `${d.backendUrl.replace(/\/+$/, '')}${d.path || DEFAULT_REPORT_PATH}`;
  const rows = await d.db.query<{ id: string; kind: string; github_user_id: string; payload: unknown; created_at: Date }>(
    `SELECT id, kind, github_user_id, payload, created_at FROM grainhack_reports WHERE delivered_at IS NULL AND attempts < 10 ORDER BY created_at LIMIT $1`,
    [limit],
  );
  let sent = 0;
  for (const row of rows.rows) {
    const body = JSON.stringify({ id: String(row.id), kind: row.kind, github_user_id: Number(row.github_user_id), payload: row.payload, occurred_at: new Date(row.created_at).toISOString() });
    try {
      const res = await f(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${d.token}` }, body });
      if (res.ok) {
        await d.db.query(`UPDATE grainhack_reports SET delivered_at = now(), last_error = NULL WHERE id = $1`, [row.id]);
        sent++;
      } else {
        await d.db.query(`UPDATE grainhack_reports SET attempts = attempts + 1, last_error = $2 WHERE id = $1`, [row.id, `${res.status} ${await res.text().catch(() => '')}`.slice(0, 500)]);
      }
    } catch (e) {
      await d.db.query(`UPDATE grainhack_reports SET attempts = attempts + 1, last_error = $2 WHERE id = $1`, [row.id, String(e instanceof Error ? e.message : e).slice(0, 500)]);
    }
  }
  return sent;
}
