// The payout signer's own record of every bounty payment it has made or
// attempted. Separate file, separate key, separate process from inference.

import { DatabaseSync } from 'node:sqlite';

export type PayoutJournalStatus = 'reserved' | 'sent' | 'confirmed' | 'failed_unsent';

export interface PayoutJournalRow {
  id: number;
  payout_id: string;
  bounty_id: string;
  approval_signature: string;
  recipient: string;
  currency: string;
  amount_minor: string;
  day: string;
  status: PayoutJournalStatus;
  tx_signature: string | null;
  error: string | null;
  created_at: string;
}

export class PayoutJournal {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS payouts (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        payout_id           TEXT NOT NULL UNIQUE,
        bounty_id           TEXT NOT NULL UNIQUE,
        approval_signature  TEXT NOT NULL UNIQUE,
        recipient           TEXT NOT NULL,
        currency            TEXT NOT NULL,
        amount_minor        TEXT NOT NULL,
        day                 TEXT NOT NULL,
        status              TEXT NOT NULL CHECK (status IN ('reserved','sent','confirmed','failed_unsent')),
        tx_signature        TEXT UNIQUE,
        error               TEXT,
        created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
  }

  /** Minor units committed today in a currency (everything except failed_unsent). */
  committedToday(currency: string, day: string): bigint {
    const rows = this.db.prepare(`SELECT amount_minor FROM payouts WHERE currency = ? AND day = ? AND status <> 'failed_unsent'`).all(currency, day) as { amount_minor: string }[];
    return rows.reduce((a, r) => a + BigInt(r.amount_minor), 0n);
  }

  reserve(a: { payoutId: string; bountyId: string; approvalSignature: string; recipient: string; currency: string; amountMinor: bigint; day: string; dailyMaxMinor: bigint }):
    | { ok: true; id: number }
    | { ok: false; reason: string; existing?: PayoutJournalRow } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare(`SELECT * FROM payouts WHERE payout_id = ? OR bounty_id = ? OR approval_signature = ?`).get(a.payoutId, a.bountyId, a.approvalSignature) as PayoutJournalRow | undefined;
      if (existing) {
        this.db.exec('ROLLBACK');
        return { ok: false, reason: `already recorded: payout ${existing.payout_id} for bounty ${existing.bounty_id} is ${existing.status}`, existing };
      }
      const today = this.committedToday(a.currency, a.day);
      if (today + a.amountMinor > a.dailyMaxMinor) {
        this.db.exec('ROLLBACK');
        return { ok: false, reason: `daily cap: ${today} already committed today + ${a.amountMinor} > ${a.dailyMaxMinor}` };
      }
      const r = this.db
        .prepare(`INSERT INTO payouts (payout_id, bounty_id, approval_signature, recipient, currency, amount_minor, day, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved')`)
        .run(a.payoutId, a.bountyId, a.approvalSignature, a.recipient, a.currency, a.amountMinor.toString(), a.day);
      this.db.exec('COMMIT');
      return { ok: true, id: Number(r.lastInsertRowid) };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  mark(id: number, status: PayoutJournalStatus, fields: { tx_signature?: string; error?: string } = {}) {
    const from: Record<PayoutJournalStatus, PayoutJournalStatus[]> = { reserved: [], sent: ['reserved'], confirmed: ['sent'], failed_unsent: ['reserved'] };
    const allowed = from[status];
    const r = this.db
      .prepare(`UPDATE payouts SET status = ?, tx_signature = COALESCE(?, tx_signature), error = COALESCE(?, error) WHERE id = ? AND status IN (${allowed.map(() => '?').join(',') || "''"})`)
      .run(status, fields.tx_signature ?? null, fields.error ?? null, id, ...allowed);
    if (Number(r.changes) !== 1) throw new Error(`payout journal ${id}: illegal transition to ${status}`);
  }

  noteError(id: number, error: string) {
    this.db.prepare(`UPDATE payouts SET error = ? WHERE id = ?`).run(error.slice(0, 500), id);
  }

  all(): PayoutJournalRow[] {
    return this.db.prepare(`SELECT * FROM payouts ORDER BY id`).all() as unknown as PayoutJournalRow[];
  }
}
