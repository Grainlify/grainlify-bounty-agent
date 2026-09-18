// The signer's own spend journal. It lives in a file only the signer opens,
// so the agent's database being wrong, wiped or hostile cannot raise what the
// signer is willing to spend.

import { DatabaseSync } from 'node:sqlite';

export type PaymentStatus =
  /** Ceiling checked and amount reserved; nothing broadcast yet. */
  | 'reserved'
  /** Broadcast, or possibly broadcast. Outcome not yet known, so it stays counted. */
  | 'sent'
  | 'confirmed'
  /** Certain nothing reached the network. The only status that stops counting. */
  | 'failed_unsent';

export interface PaymentRow {
  id: number;
  quote_id: string;
  pay_to: string;
  amount_micro: number;
  fee_reserve_micro: number;
  fee_micro: number | null;
  status: PaymentStatus;
  tx_signature: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export class Journal {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS inference_payments (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        quote_id          TEXT NOT NULL UNIQUE,
        pay_to            TEXT NOT NULL,
        amount_micro      INTEGER NOT NULL CHECK (amount_micro > 0),
        fee_reserve_micro INTEGER NOT NULL CHECK (fee_reserve_micro >= 0),
        fee_micro         INTEGER,
        status            TEXT NOT NULL CHECK (status IN ('reserved','sent','confirmed','failed_unsent')),
        tx_signature      TEXT UNIQUE,
        error             TEXT,
        created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE IF NOT EXISTS balance_proofs (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        quote_id   TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
  }

  /** Micro-USD this journal counts as spent or possibly spent. */
  committedMicro(): number {
    const row = this.db
      .prepare(`
        SELECT COALESCE(SUM(CASE
          WHEN status = 'failed_unsent' THEN 0
          WHEN status = 'confirmed' THEN amount_micro + COALESCE(fee_micro, fee_reserve_micro)
          ELSE amount_micro + fee_reserve_micro END), 0) AS total
        FROM inference_payments`)
      .get() as { total: number };
    return Number(row.total);
  }

  /**
   * Checks the ceiling and inserts the reservation in one IMMEDIATE
   * transaction, so a second signer process on the same file cannot race it.
   */
  reserve(args: { quoteId: string; payTo: string; amountMicro: number; feeReserveMicro: number; ceilingMicro: number }):
    | { ok: true; id: number }
    | { ok: false; reason: string; existing?: PaymentRow } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.byQuote(args.quoteId);
      if (existing) {
        this.db.exec('ROLLBACK');
        return { ok: false, reason: `quote ${args.quoteId} already has a payment (${existing.status})`, existing };
      }
      const committed = this.committedMicro();
      const after = committed + args.amountMicro + args.feeReserveMicro;
      if (after > args.ceilingMicro) {
        this.db.exec('ROLLBACK');
        return { ok: false, reason: `signer lifetime ceiling: ${after} > ${args.ceilingMicro} micro-USD (already committed ${committed})` };
      }
      const res = this.db
        .prepare(`INSERT INTO inference_payments (quote_id, pay_to, amount_micro, fee_reserve_micro, status) VALUES (?, ?, ?, ?, 'reserved')`)
        .run(args.quoteId, args.payTo, args.amountMicro, args.feeReserveMicro);
      this.db.exec('COMMIT');
      return { ok: true, id: Number(res.lastInsertRowid) };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  markSent(id: number, txSignature: string) {
    this.update(id, `status = 'sent', tx_signature = ?`, [txSignature], ['reserved']);
  }

  markConfirmed(id: number, feeMicro: number) {
    this.update(id, `status = 'confirmed', fee_micro = ?`, [feeMicro], ['sent']);
  }

  markFailedUnsent(id: number, error: string) {
    this.update(id, `status = 'failed_unsent', error = ?`, [error.slice(0, 500)], ['reserved']);
  }

  markError(id: number, error: string) {
    this.db.prepare(`UPDATE inference_payments SET error = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(error.slice(0, 500), id);
  }

  recordBalanceProof(quoteId: string): boolean {
    const res = this.db.prepare(`INSERT OR IGNORE INTO balance_proofs (quote_id) VALUES (?)`).run(quoteId);
    return Number(res.changes) === 1;
  }

  byQuote(quoteId: string): PaymentRow | undefined {
    return this.db.prepare(`SELECT * FROM inference_payments WHERE quote_id = ?`).get(quoteId) as PaymentRow | undefined;
  }

  all(): PaymentRow[] {
    return this.db.prepare(`SELECT * FROM inference_payments ORDER BY id`).all() as unknown as PaymentRow[];
  }

  close() {
    this.db.close();
  }

  private update(id: number, set: string, params: (string | number)[], from: PaymentStatus[]) {
    const res = this.db
      .prepare(`UPDATE inference_payments SET ${set}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND status IN (${from.map(() => '?').join(',')})`)
      .run(...params, id, ...from);
    if (Number(res.changes) !== 1) throw new Error(`payment ${id}: illegal transition (expected status ${from.join('|')})`);
  }
}
