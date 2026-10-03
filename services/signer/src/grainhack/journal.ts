// The grainhack-signer's own record of every GrainHack payment it has made or
// attempted. Its own file, its own process, its own key: nothing here is
// shared with the bounty payout journal.
//
// Three rules live in the schema rather than in code that could forget them:
//   - one row per (hackathon_id, pool, github_user_id), whatever its status:
//     a winner is paid at most once, ever, by this signer;
//   - the transaction signature is NOT NULL: it is known before the row
//     exists, so it is on disk before anything is broadcast;
//   - rows are never deleted, and every status change is appended to
//     grainhack_transitions with who made it and why.

import { DatabaseSync } from 'node:sqlite';

export type GrainhackJournalStatus = 'reserved' | 'sent' | 'confirmed' | 'unknown' | 'failed_unsent';

export interface GrainhackJournalRow {
  id: number;
  payout_id: string;
  approval_signature: string;
  approver: string;
  statement_id: string;
  statement_sha256: string;
  hackathon_id: string;
  pool: string;
  github_user_id: number;
  login: string;
  recipient: string;
  currency: string;
  network: string;
  mint: string;
  amount_minor: string;
  day: string;
  status: GrainhackJournalStatus;
  tx_signature: string;
  last_valid_block_height: number | null;
  error: string | null;
  resolved_by: string | null;
  resolved_reason: string | null;
  resolved_at: string | null;
  resolution: string | null;
  created_at: string;
  updated_at: string;
}

export interface Reservation {
  payoutId: string;
  approvalSignature: string;
  approver: string;
  statementId: string;
  statementSha256: string;
  hackathonId: string;
  pool: string;
  githubUserId: number;
  login: string;
  recipient: string;
  currency: string;
  network: string;
  mint: string;
  amountMinor: bigint;
  day: string;
  txSignature: string;
  lastValidBlockHeight: number | null;
}

export interface CapLimits {
  /** min(per-event cap, the statement's pool). */
  eventMaxMinor: bigint;
  dailyMaxMinor: bigint;
}

export type ReserveRefusal = { ok: false; status: 403 | 409; reason: string; existing?: GrainhackJournalRow };

// Transitions the payment path makes by itself. A person resolving an outcome
// uses resolve(), which has its own, narrower set.
const AUTO: Record<GrainhackJournalStatus, GrainhackJournalStatus[]> = {
  reserved: [],
  sent: ['reserved'],
  confirmed: ['sent'],
  unknown: ['sent'],
  failed_unsent: [],
};

export class GrainhackJournal {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS grainhack_payouts (
        id                      INTEGER PRIMARY KEY AUTOINCREMENT,
        payout_id               TEXT NOT NULL UNIQUE,
        approval_signature      TEXT NOT NULL UNIQUE,
        approver                TEXT NOT NULL,
        statement_id            TEXT NOT NULL,
        statement_sha256        TEXT NOT NULL,
        hackathon_id            TEXT NOT NULL,
        pool                    TEXT NOT NULL,
        github_user_id          INTEGER NOT NULL,
        login                   TEXT NOT NULL,
        recipient               TEXT NOT NULL,
        currency                TEXT NOT NULL,
        network                 TEXT NOT NULL,
        mint                    TEXT NOT NULL,
        amount_minor            TEXT NOT NULL,
        day                     TEXT NOT NULL,
        status                  TEXT NOT NULL CHECK (status IN ('reserved','sent','confirmed','unknown','failed_unsent')),
        tx_signature            TEXT NOT NULL UNIQUE,
        last_valid_block_height INTEGER,
        error                   TEXT,
        resolved_by             TEXT,
        resolved_reason         TEXT,
        resolved_at             TEXT,
        resolution              TEXT,
        created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE (hackathon_id, pool, github_user_id)
      );
      CREATE TABLE IF NOT EXISTS grainhack_transitions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        payout_row  INTEGER NOT NULL REFERENCES grainhack_payouts(id),
        from_status TEXT,
        to_status   TEXT NOT NULL,
        actor       TEXT NOT NULL,
        reason      TEXT,
        at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TRIGGER IF NOT EXISTS grainhack_payouts_never_deleted BEFORE DELETE ON grainhack_payouts
        BEGIN SELECT RAISE(ABORT, 'grainhack journal rows are never deleted'); END;
      CREATE TRIGGER IF NOT EXISTS grainhack_transitions_append_only BEFORE UPDATE ON grainhack_transitions
        BEGIN SELECT RAISE(ABORT, 'grainhack transitions are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS grainhack_transitions_never_deleted BEFORE DELETE ON grainhack_transitions
        BEGIN SELECT RAISE(ABORT, 'grainhack transitions are append-only'); END;
    `);
  }

  /** Minor units committed to one event's pool: every row except one that provably sent nothing. */
  committedToEvent(hackathonId: string, pool: string, currency: string, network: string): bigint {
    const rows = this.db
      .prepare(`SELECT amount_minor FROM grainhack_payouts WHERE hackathon_id = ? AND pool = ? AND currency = ? AND network = ? AND status <> 'failed_unsent'`)
      .all(hackathonId, pool, currency, network) as { amount_minor: string }[];
    return rows.reduce((a, r) => a + BigInt(r.amount_minor), 0n);
  }

  /** Minor units committed in one UTC day, per (currency, network). */
  committedOnDay(currency: string, network: string, day: string): bigint {
    const rows = this.db
      .prepare(`SELECT amount_minor FROM grainhack_payouts WHERE currency = ? AND network = ? AND day = ? AND status <> 'failed_unsent'`)
      .all(currency, network, day) as { amount_minor: string }[];
    return rows.reduce((a, r) => a + BigInt(r.amount_minor), 0n);
  }

  forWinner(hackathonId: string, pool: string, githubUserId: number): GrainhackJournalRow | undefined {
    return this.db.prepare(`SELECT * FROM grainhack_payouts WHERE hackathon_id = ? AND pool = ? AND github_user_id = ?`).get(hackathonId, pool, githubUserId) as
      | GrainhackJournalRow
      | undefined;
  }

  byPayoutId(payoutId: string): GrainhackJournalRow | undefined {
    return this.db.prepare(`SELECT * FROM grainhack_payouts WHERE payout_id = ?`).get(payoutId) as GrainhackJournalRow | undefined;
  }

  /**
   * Contract §2 checks 6 and 7, in that order, against the journal. Read-only;
   * reserve() runs the same checks again inside its transaction.
   */
  check(r: Pick<Reservation, 'payoutId' | 'approvalSignature' | 'hackathonId' | 'pool' | 'githubUserId' | 'currency' | 'network' | 'amountMinor' | 'day'>, caps: CapLimits): ReserveRefusal | null {
    const event = this.committedToEvent(r.hackathonId, r.pool, r.currency, r.network);
    if (event + r.amountMinor > caps.eventMaxMinor) {
      return { ok: false, status: 403, reason: `event cap: ${event} already committed to this pool + ${r.amountMinor} > ${caps.eventMaxMinor}` };
    }
    const today = this.committedOnDay(r.currency, r.network, r.day);
    if (today + r.amountMinor > caps.dailyMaxMinor) {
      return { ok: false, status: 403, reason: `daily cap: ${today} already committed on ${r.day} + ${r.amountMinor} > ${caps.dailyMaxMinor}` };
    }
    const winner = this.forWinner(r.hackathonId, r.pool, r.githubUserId);
    if (winner) {
      return { ok: false, status: 409, reason: `already recorded: winner ${r.githubUserId} of ${r.hackathonId}/${r.pool} has payout ${winner.payout_id} (${winner.status}); one payout per winner, ever`, existing: winner };
    }
    const same = this.db.prepare(`SELECT * FROM grainhack_payouts WHERE payout_id = ? OR approval_signature = ?`).get(r.payoutId, r.approvalSignature) as GrainhackJournalRow | undefined;
    if (same) return { ok: false, status: 409, reason: `already recorded: payout ${same.payout_id} is ${same.status}`, existing: same };
    return null;
  }

  /** Re-checks caps and uniqueness and inserts, under one write lock. The row carries its transaction signature from birth. */
  reserve(r: Reservation, caps: CapLimits): { ok: true; id: number } | ReserveRefusal {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const refused = this.check(r, caps);
      if (refused) {
        this.db.exec('ROLLBACK');
        return refused;
      }
      const ins = this.db
        .prepare(
          `INSERT INTO grainhack_payouts (payout_id, approval_signature, approver, statement_id, statement_sha256, hackathon_id, pool, github_user_id, login,
             recipient, currency, network, mint, amount_minor, day, status, tx_signature, last_valid_block_height)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`,
        )
        .run(
          r.payoutId, r.approvalSignature, r.approver, r.statementId, r.statementSha256, r.hackathonId, r.pool, r.githubUserId, r.login,
          r.recipient, r.currency, r.network, r.mint, r.amountMinor.toString(), r.day, r.txSignature, r.lastValidBlockHeight,
        );
      const id = Number(ins.lastInsertRowid);
      this.db.prepare(`INSERT INTO grainhack_transitions (payout_row, from_status, to_status, actor) VALUES (?, NULL, 'reserved', 'grainhack-signer')`).run(id);
      this.db.exec('COMMIT');
      return { ok: true, id };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** The payment path's own transitions: reserved -> sent -> confirmed | unknown. */
  mark(id: number, status: GrainhackJournalStatus, error?: string) {
    this.transition(id, status, AUTO[status], 'grainhack-signer', null, { error: error ?? null });
  }

  /**
   * A person deciding an outcome the signer could not confirm, from what the
   * chain says. Only to confirmed or failed_unsent, only from a status that is
   * not already final, and always with a name and a reason.
   */
  resolve(payoutId: string, to: 'confirmed' | 'failed_unsent', actor: string, reason: string, evidence: unknown): GrainhackJournalRow {
    if (!actor.trim() || !reason.trim()) throw new Error('resolve needs an actor and a reason');
    const row = this.byPayoutId(payoutId);
    if (!row) throw new Error(`no journal row for payout ${payoutId}`);
    this.transition(row.id, to, ['reserved', 'sent', 'unknown'], actor, reason, { resolution: JSON.stringify(evidence) });
    return this.byPayoutId(payoutId)!;
  }

  private transition(id: number, to: GrainhackJournalStatus, from: GrainhackJournalStatus[], actor: string, reason: string | null, f: { error?: string | null; resolution?: string }) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const cur = this.db.prepare(`SELECT status FROM grainhack_payouts WHERE id = ?`).get(id) as { status: GrainhackJournalStatus } | undefined;
      if (!cur || !from.includes(cur.status)) throw new Error(`grainhack journal ${id}: illegal transition ${cur?.status ?? '(none)'} -> ${to}`);
      const resolving = f.resolution !== undefined;
      this.db
        .prepare(
          `UPDATE grainhack_payouts SET status = ?, error = COALESCE(?, error), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
             resolved_by = CASE WHEN ? THEN ? ELSE resolved_by END, resolved_reason = CASE WHEN ? THEN ? ELSE resolved_reason END,
             resolved_at = CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE resolved_at END, resolution = COALESCE(?, resolution)
           WHERE id = ?`,
        )
        .run(to, f.error ? f.error.slice(0, 500) : null, resolving ? 1 : 0, actor, resolving ? 1 : 0, reason, resolving ? 1 : 0, f.resolution ?? null, id);
      this.db.prepare(`INSERT INTO grainhack_transitions (payout_row, from_status, to_status, actor, reason) VALUES (?, ?, ?, ?, ?)`).run(id, cur.status, to, actor, reason);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  all(): GrainhackJournalRow[] {
    return this.db.prepare(`SELECT * FROM grainhack_payouts ORDER BY id`).all() as unknown as GrainhackJournalRow[];
  }

  transitions(payoutId: string): { from_status: string | null; to_status: string; actor: string; reason: string | null; at: string }[] {
    return this.db
      .prepare(`SELECT t.from_status, t.to_status, t.actor, t.reason, t.at FROM grainhack_transitions t JOIN grainhack_payouts p ON p.id = t.payout_row WHERE p.payout_id = ? ORDER BY t.id`)
      .all(payoutId) as never;
  }

  close() {
    this.db.close();
  }
}
