// Postgres implementations of the receipt store and spend ledger.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { decide, type BudgetConfig, type Phase, type SpendRequest } from '../../budget/src/governor.ts';
import { sumTotals, type Settlement, type SpendEntry, type SpendLedger } from '../../budget/src/ledger.ts';
import type { InferenceCallRecord, ReceiptStore } from '../../x402/src/receipts.ts';

/** Any constant works; it just has to be the same everywhere that reserves inference spend. */
const SPEND_LOCK_KEY = 0x6772_6169; // "grai"

export async function migrate(pool: pg.Pool, dir = join(import.meta.dirname, '../../../db/migrations')) {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const done = await pool.query(`SELECT 1 FROM schema_migrations WHERE version = $1`, [f]);
    if (done.rowCount) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(readFileSync(join(dir, f), 'utf8'));
      await client.query(`INSERT INTO schema_migrations (version) VALUES ($1)`, [f]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
}

export type LedgerMode = 'mock' | 'live';

/**
 * Binds this database to mock or live money on first use and refuses the
 * other mode afterwards. A ledger that ever recorded mock payments can never
 * be counted against the real budget, and vice versa.
 */
export async function bindLedgerMode(pool: pg.Pool, mode: LedgerMode): Promise<void> {
  await pool.query(`INSERT INTO ledger_meta (mode) VALUES ($1) ON CONFLICT (singleton) DO NOTHING`, [mode]);
  const r = await pool.query(`SELECT mode FROM ledger_meta`);
  const bound = r.rows[0]?.mode as LedgerMode | undefined;
  if (bound !== mode) {
    throw new Error(`this database is a ${bound} ledger; ${mode} inference needs its own database (never mix mock and real spend)`);
  }
}

const COLS: [keyof InferenceCallRecord, string][] = [
  ['id', 'id'], ['purpose', 'purpose'], ['phase', 'phase'], ['model', 'model'], ['path', 'path'], ['links', 'links'],
  ['routingRequested', 'routing_requested'], ['maxTokens', 'max_tokens'], ['requestSha256', 'request_sha256'], ['status', 'status'],
  ['quoteId', 'quote_id'], ['quoteCapMicro', 'quote_cap_micro'], ['quoteExpiresAt', 'quote_expires_at'], ['scheme', 'scheme'],
  ['payerWallet', 'payer_wallet'], ['payTxSignature', 'pay_tx_signature'], ['paidMicro', 'paid_micro'], ['feeMicro', 'fee_micro'],
  ['fee_lamports', 'fee_lamports'], ['chargedMicro', 'charged_micro'], ['paymentResponseRaw', 'payment_response_raw'], ['paymentResponse', 'payment_response'],
  ['responseHeaders', 'response_headers'], ['responseSha256', 'response_sha256'], ['usageIn', 'usage_in'], ['usageOut', 'usage_out'],
  ['latencyMs', 'latency_ms'], ['error', 'error'], ['createdAt', 'created_at'],
];
const JSON_COLS = new Set(['links', 'routing_requested', 'payment_response', 'response_headers']);
const NUM_COLS = new Set(['quote_cap_micro', 'paid_micro', 'fee_micro', 'charged_micro', 'fee_lamports']);

function toRow(rec: Partial<InferenceCallRecord>) {
  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const [k, c] of COLS) {
    if (!(k in rec) || rec[k] === undefined) continue;
    cols.push(c);
    vals.push(JSON_COLS.has(c) && rec[k] !== null ? JSON.stringify(rec[k]) : rec[k]);
  }
  return { cols, vals };
}

function fromRow(row: Record<string, unknown>): InferenceCallRecord {
  const out: Record<string, unknown> = {};
  for (const [k, c] of COLS) {
    const v = row[c];
    out[k] = NUM_COLS.has(c) && v !== null && v !== undefined ? Number(v) : v;
  }
  return out as unknown as InferenceCallRecord;
}

export class PgReceiptStore implements ReceiptStore {
  constructor(private readonly pool: pg.Pool) {}

  async insert(rec: InferenceCallRecord) {
    const { cols, vals } = toRow(rec);
    const r = await this.pool.query(`INSERT INTO inference_calls (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, vals);
    return fromRow(r.rows[0]);
  }

  async update(id: string, patch: Partial<InferenceCallRecord>) {
    const { cols, vals } = toRow({ ...patch, id: undefined, createdAt: undefined });
    if (!cols.length) return this.get(id);
    const r = await this.pool.query(
      `UPDATE inference_calls SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')}, updated_at = now() WHERE id = $${cols.length + 1} RETURNING *`,
      [...vals, id],
    );
    if (!r.rowCount) throw new Error(`no call ${id}`);
    return fromRow(r.rows[0]);
  }

  async get(id: string) {
    const r = await this.pool.query(`SELECT * FROM inference_calls WHERE id = $1`, [id]);
    if (!r.rowCount) throw new Error(`no call ${id}`);
    return fromRow(r.rows[0]);
  }

  async list() {
    const r = await this.pool.query(`SELECT * FROM inference_calls ORDER BY created_at`);
    return r.rows.map(fromRow);
  }
}

function toEntry(r: Record<string, unknown>): SpendEntry {
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    id: String(r.id), callId: (r.call_id as string | null) ?? null, phase: r.phase as Phase, kind: r.kind as SpendEntry['kind'],
    status: r.status as SpendEntry['status'], reservedMicro: Number(r.reserved_micro), amountMicro: n(r.amount_micro), feeMicro: n(r.fee_micro),
    txSignature: (r.tx_signature as string | null) ?? null, createdAt: r.created_at as Date, settledAt: (r.settled_at as Date | null) ?? null,
  };
}

export class PgSpendLedger implements SpendLedger {
  constructor(private readonly pool: pg.Pool, private readonly cfg: BudgetConfig) {}

  async reserve(req: SpendRequest & { callId: string | null }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialises every reservation: the sum we check is the sum we insert against.
      await client.query('SELECT pg_advisory_xact_lock($1)', [SPEND_LOCK_KEY]);
      const rows = (await client.query(`SELECT * FROM inference_spend`)).rows.map(toEntry);
      const decision = decide(this.cfg, sumTotals(rows), req);
      if (!decision.ok) {
        await client.query('ROLLBACK');
        return { decision, entryId: null };
      }
      const r = await client.query(
        `INSERT INTO inference_spend (call_id, phase, kind, status, reserved_micro) VALUES ($1, $2, $3, 'reserved', $4) RETURNING id`,
        [req.callId, req.phase, req.kind, req.amountMicro],
      );
      await client.query('COMMIT');
      return { decision, entryId: String(r.rows[0].id) };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async settle(entryId: string, s: Settlement) {
    const r = await this.pool.query(
      `UPDATE inference_spend SET status = 'settled', amount_micro = $2, fee_micro = $3, tx_signature = $4, settled_at = now() WHERE id = $1 AND status = 'reserved'`,
      [entryId, s.amountMicro, s.feeMicro, s.txSignature],
    );
    if (r.rowCount !== 1) throw new Error(`spend ${entryId} is not reserved`);
  }

  async release(entryId: string) {
    const r = await this.pool.query(`UPDATE inference_spend SET status = 'released' WHERE id = $1 AND status = 'reserved'`, [entryId]);
    if (r.rowCount !== 1) throw new Error(`spend ${entryId} is not reserved`);
  }

  async totals() {
    return sumTotals(await this.entries());
  }

  async entries() {
    return (await this.pool.query(`SELECT * FROM inference_spend ORDER BY id`)).rows.map(toEntry);
  }
}
