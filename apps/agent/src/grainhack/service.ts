// GrainHack payouts on the agent (contract §3): import the backend's signed
// results statement, keep one row per winner, hand a person's approval to the
// grainhack-signer, and record what happened.
//
// The agent decides nothing about money here. The statement says who is owed
// what; a person approves each payment on their own machine; the signer
// re-checks all of it. What the agent adds is bookkeeping, the wallet each
// winner linked, and refusing to forward an approval that does not match its
// own records exactly.

import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { sameGrainhackTerms, verifyGrainhackApproval, type GrainhackApproval, type GrainhackTerms } from '../../../../packages/gate/src/grainhack-approval.ts';
import { verifyStatement, type ResultsStatement } from '../../../../packages/gate/src/grainhack-statement.ts';
import { explorerTx } from '../config.ts';
import { enqueueReport } from './backend.ts';
import type { GrainhackConfig } from './config.ts';
import type { GrainhackSignerApi } from './signer-client.ts';

export type RowStatus = 'held_kyc' | 'awaiting_wallet' | 'awaiting_approval' | 'submitted' | 'paid' | 'unknown' | 'failed' | 'removed';
/** Rows a superseding statement may change. Anything sent to the signer stays as it is. */
export const UNPAID: RowStatus[] = ['held_kyc', 'awaiting_wallet', 'awaiting_approval', 'removed'];

export interface PayoutRow {
  id: string;
  hackathon_id: string;
  pool: string;
  github_user_id: number;
  login: string;
  statement_id: string;
  amount_minor: string;
  currency: string;
  mint: string;
  network: string;
  recipient: string | null;
  status: RowStatus;
  approved_by: string | null;
  approved_at: Date | null;
  tx_signature: string | null;
  paid_at: Date | null;
  last_error: string | null;
  updated_at: Date;
}

export interface StatementRow {
  statement_id: string;
  supersedes: string | null;
  superseded_by: string | null;
  hackathon_id: string;
  hackathon_name: string;
  pool: string;
  computation_id: string;
  currency: string;
  network: string;
  pool_minor: string;
  statement_json: string;
  signature: string;
  statement_sha256: string;
  issued_at: Date;
  imported_at: Date;
  imported_by: string;
}

export type ImportResult =
  | { ok: true; alreadyImported: boolean; statementId: string; hackathonId: string; created: number; updated: number; kept: number; removed: number; byStatus: Record<string, number> }
  | { ok: false; error: string };

export type ApproveResult =
  | { ok: true; signature: string; txUrl: string }
  | { ok: false; status: number; error: string; rowStatus?: RowStatus };

const ROW_COLS = `id, hackathon_id, pool, github_user_id::float8 AS github_user_id, login, statement_id, amount_minor::text AS amount_minor, currency, mint, network,
  recipient, status, approved_by, approved_at, tx_signature, paid_at, last_error, updated_at`;
const STMT_COLS = `statement_id, supersedes, superseded_by, hackathon_id, hackathon_name, pool, computation_id, currency, network, pool_minor::text AS pool_minor,
  statement_json, signature, statement_sha256, issued_at, imported_at, imported_by`;

export interface GrainhackDeps {
  db: pg.Pool;
  cfg: GrainhackConfig;
  /** Absent in the CLI, which imports statements but never pays. */
  signer?: GrainhackSignerApi;
  now?: () => Date;
  /** How long a forwarded approval the signer has never heard of stays 'unknown' before it may be approved again. */
  orphanAfterMs?: number;
}

export class GrainhackService {
  constructor(private readonly d: GrainhackDeps) {}

  private now() {
    return this.d.now ? this.d.now() : new Date();
  }

  config() {
    return this.d.cfg;
  }

  private async audit(db: pg.Pool | pg.PoolClient, actor: string, action: string, subject: string, detail: Record<string, unknown>) {
    await db.query(`INSERT INTO audit_log (actor, action, subject, detail) VALUES ($1, $2, $3, $4)`, [actor, action, subject, JSON.stringify(detail)]);
  }

  // --- import ---------------------------------------------------------------

  async importStatement(input: { statement: string; signature: string }, importedBy: string): Promise<ImportResult> {
    const v = verifyStatement(input.statement, input.signature, this.d.cfg.resultsPubkey);
    if (!v.ok) return { ok: false, error: `statement refused: ${v.reason}` };
    const s = v.statement;
    if (s.network !== this.d.cfg.network) return { ok: false, error: `statement is for ${s.network}; this agent's GRAINHACK_NETWORK is ${this.d.cfg.network}` };
    const mint = this.d.cfg.mints[s.currency];
    if (!mint) return { ok: false, error: `no GrainHack mint configured for ${s.currency}` };

    const client = await this.d.db.connect();
    try {
      await client.query('BEGIN');
      // One import per event pool at a time.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`grainhack:${s.hackathon_id}:${s.pool}`]);
      const same = await client.query<{ statement_sha256: string }>(`SELECT statement_sha256 FROM grainhack_statements WHERE statement_id = $1`, [s.statement_id]);
      if (same.rows[0]) {
        await client.query('ROLLBACK');
        if (same.rows[0].statement_sha256 !== v.sha256) return { ok: false, error: `statement ${s.statement_id} was already imported with different content; statements are immutable` };
        await this.refreshWallets(s.hackathon_id);
        return { ok: true, alreadyImported: true, statementId: s.statement_id, hackathonId: s.hackathon_id, created: 0, updated: 0, kept: 0, removed: 0, byStatus: await this.countByStatus(s.hackathon_id, s.pool) };
      }
      const cur = (await client.query<StatementRow>(`SELECT ${STMT_COLS} FROM grainhack_statements WHERE hackathon_id = $1 AND pool = $2 AND superseded_by IS NULL`, [s.hackathon_id, s.pool])).rows[0];
      if (cur) {
        const why =
          s.supersedes !== cur.statement_id ? `statement ${s.statement_id} supersedes ${s.supersedes ?? 'nothing'}, but the current statement for this event is ${cur.statement_id}`
          : s.computation_id !== cur.computation_id ? `statement ${s.statement_id} is for computation ${s.computation_id}, not the current ${cur.computation_id}`
          : s.currency !== cur.currency || s.network !== cur.network ? 'a superseding statement cannot change currency or network'
          : null;
        if (why) {
          await client.query('ROLLBACK');
          return { ok: false, error: why };
        }
        await client.query(`UPDATE grainhack_statements SET superseded_by = $2 WHERE statement_id = $1`, [cur.statement_id, s.statement_id]);
      }
      await client.query(
        `INSERT INTO grainhack_statements (statement_id, supersedes, hackathon_id, hackathon_name, pool, computation_id, currency, network, pool_minor,
           statement_json, signature, statement_sha256, issued_at, imported_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [s.statement_id, s.supersedes, s.hackathon_id, s.hackathon_name, s.pool, s.computation_id, s.currency, s.network, s.pool_minor,
          input.statement, input.signature, v.sha256, s.issued_at, importedBy],
      );

      const wallets = await this.liveWallets(client, s.lines.map((l) => l.github_user_id));
      const existing = new Map(
        (await client.query<PayoutRow>(`SELECT ${ROW_COLS} FROM grainhack_payouts WHERE hackathon_id = $1 AND pool = $2 FOR UPDATE`, [s.hackathon_id, s.pool])).rows.map((r) => [r.github_user_id, r]),
      );
      let created = 0, updated = 0, kept = 0, removed = 0;
      const listed = new Set<number>();
      for (const line of s.lines) {
        if (BigInt(line.amount_minor) === 0n) continue; // nothing to pay; a row for it would only say so
        listed.add(line.github_user_id);
        const wallet = wallets.get(line.github_user_id) ?? null;
        const row = existing.get(line.github_user_id);
        const status: RowStatus = line.status === 'held_kyc' ? 'held_kyc' : wallet ? 'awaiting_approval' : 'awaiting_wallet';
        // Frozen once: a row already awaiting approval keeps the address it was frozen with.
        const recipient = status === 'awaiting_approval' ? (row?.status === 'awaiting_approval' && row.recipient ? row.recipient : wallet) : null;
        if (!row) {
          await client.query(
            `INSERT INTO grainhack_payouts (id, hackathon_id, pool, github_user_id, login, statement_id, amount_minor, currency, mint, network, recipient, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [randomUUID(), s.hackathon_id, s.pool, line.github_user_id, line.login, s.statement_id, line.amount_minor, s.currency, mint.mint, s.network, recipient, status],
          );
          created++;
        } else if (UNPAID.includes(row.status)) {
          await client.query(
            `UPDATE grainhack_payouts SET statement_id = $2, login = $3, amount_minor = $4, mint = $5, recipient = $6, status = $7, last_error = NULL, updated_at = now() WHERE id = $1`,
            [row.id, s.statement_id, line.login, line.amount_minor, mint.mint, recipient, status],
          );
          updated++;
        } else {
          kept++;
        }
      }
      for (const row of existing.values()) {
        if (!listed.has(row.github_user_id) && UNPAID.includes(row.status) && row.status !== 'removed') {
          await client.query(`UPDATE grainhack_payouts SET status = 'removed', statement_id = $2, recipient = NULL, updated_at = now() WHERE id = $1`, [row.id, s.statement_id]);
          removed++;
        }
      }
      await this.audit(client, importedBy, 'grainhack.statement_imported', s.statement_id, {
        hackathonId: s.hackathon_id, supersedes: s.supersedes, sha256: v.sha256, created, updated, kept, removed,
      });
      await this.queueLinkWalletReports(client, s);
      await client.query('COMMIT');
      return { ok: true, alreadyImported: false, statementId: s.statement_id, hackathonId: s.hackathon_id, created, updated, kept, removed, byStatus: await this.countByStatus(s.hackathon_id, s.pool) };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  private async liveWallets(db: pg.Pool | pg.PoolClient, ids: number[]): Promise<Map<number, string>> {
    if (!ids.length) return new Map();
    const r = await db.query<{ github_user_id: string; address: string }>(
      `SELECT github_user_id::text, address FROM wallet_links WHERE revoked_at IS NULL AND github_user_id = ANY($1::bigint[])`,
      [ids],
    );
    return new Map(r.rows.map((x) => [Number(x.github_user_id), x.address]));
  }

  private async queueLinkWalletReports(db: pg.Pool | pg.PoolClient, s: Pick<ResultsStatement, 'hackathon_id' | 'pool' | 'hackathon_name' | 'statement_id'>) {
    const r = await db.query<PayoutRow>(`SELECT ${ROW_COLS} FROM grainhack_payouts WHERE hackathon_id = $1 AND pool = $2 AND status = 'awaiting_wallet'`, [s.hackathon_id, s.pool]);
    for (const row of r.rows) {
      await enqueueReport(db, {
        kind: 'grainhack_link_wallet', githubUserId: row.github_user_id, dedupeKey: `grainhack_link_wallet:${row.id}:${s.statement_id}`,
        payload: { hackathon_id: s.hackathon_id, hackathon_name: s.hackathon_name, pool: s.pool, statement_id: s.statement_id, payout_id: row.id, login: row.login, amount_minor: row.amount_minor, currency: row.currency, network: row.network },
      });
    }
  }

  private async countByStatus(hackathonId: string, pool: string) {
    const r = await this.d.db.query<{ status: string; n: number }>(`SELECT status, count(*)::int AS n FROM grainhack_payouts WHERE hackathon_id = $1 AND pool = $2 GROUP BY status`, [hackathonId, pool]);
    return Object.fromEntries(r.rows.map((x) => [x.status, x.n]));
  }

  /** Payable winners who have since linked a wallet move to awaiting_approval, their address frozen now. */
  async refreshWallets(hackathonId?: string): Promise<number> {
    const r = await this.d.db.query(
      `UPDATE grainhack_payouts p SET status = 'awaiting_approval', recipient = w.address, last_error = NULL, updated_at = now()
         FROM wallet_links w
        WHERE p.status = 'awaiting_wallet' AND w.github_user_id = p.github_user_id AND w.revoked_at IS NULL ${hackathonId ? 'AND p.hackathon_id = $1' : ''}`,
      hackathonId ? [hackathonId] : [],
    );
    return r.rowCount ?? 0;
  }

  /**
   * Re-reads the live wallet link for a row awaiting approval, when the one it
   * was frozen with is no longer the winner's live link. A person does this,
   * named, with a reason; it is never automatic.
   */
  async refreeze(payoutId: string, actor: string, reason: string) {
    if (!actor.trim() || !reason.trim()) throw new Error('refreeze needs --actor and --reason');
    const row = await this.row(payoutId);
    if (!row) throw new Error('no such GrainHack payout');
    if (row.status !== 'awaiting_approval' && row.status !== 'awaiting_wallet') throw new Error(`payout is ${row.status}; only a row not yet approved can be refrozen`);
    const wallet = (await this.liveWallets(this.d.db, [row.github_user_id])).get(row.github_user_id) ?? null;
    await this.d.db.query(`UPDATE grainhack_payouts SET recipient = $2, status = $3, updated_at = now() WHERE id = $1`, [payoutId, wallet, wallet ? 'awaiting_approval' : 'awaiting_wallet']);
    await this.audit(this.d.db, actor, 'grainhack.recipient_refrozen', payoutId, { from: row.recipient, to: wallet, reason });
    return { from: row.recipient, to: wallet };
  }

  // --- reading --------------------------------------------------------------

  async row(payoutId: string): Promise<PayoutRow | null> {
    if (!/^[0-9a-f-]{36}$/.test(payoutId)) return null;
    return (await this.d.db.query<PayoutRow>(`SELECT ${ROW_COLS} FROM grainhack_payouts WHERE id = $1`, [payoutId])).rows[0] ?? null;
  }

  async statement(statementId: string): Promise<StatementRow | null> {
    return (await this.d.db.query<StatementRow>(`SELECT ${STMT_COLS} FROM grainhack_statements WHERE statement_id = $1`, [statementId])).rows[0] ?? null;
  }

  async currentStatement(hackathonId: string, pool = 'contributor'): Promise<StatementRow | null> {
    return (await this.d.db.query<StatementRow>(`SELECT ${STMT_COLS} FROM grainhack_statements WHERE hackathon_id = $1 AND pool = $2 AND superseded_by IS NULL`, [hackathonId, pool])).rows[0] ?? null;
  }

  /** The terms a person approves for this row: everything from the agent's own records. */
  termsFor(row: PayoutRow, st: StatementRow): GrainhackTerms | null {
    if (!row.recipient) return null;
    return {
      payout_id: row.id, statement_id: st.statement_id, statement_sha256: st.statement_sha256, hackathon_id: row.hackathon_id, pool: row.pool,
      github_user_id: row.github_user_id, login: row.login, recipient: row.recipient, amount_minor: row.amount_minor, currency: row.currency, mint: row.mint, network: row.network,
    };
  }

  /** The operator's view of one event: the statement, every row, and totals. Bearer-protected: it shows who is held. */
  async eventView(hackathonId: string, pool = 'contributor') {
    const st = await this.currentStatement(hackathonId, pool);
    const rows = (await this.d.db.query<PayoutRow>(`SELECT ${ROW_COLS} FROM grainhack_payouts WHERE hackathon_id = $1 AND pool = $2 ORDER BY github_user_id`, [hackathonId, pool])).rows;
    const wallets = await this.liveWallets(this.d.db, rows.map((r) => r.github_user_id));
    const statements = new Map<string, StatementRow>();
    for (const id of new Set(rows.map((r) => r.statement_id))) {
      const s = await this.statement(id);
      if (s) statements.set(id, s);
    }
    const sum = (f: (r: PayoutRow) => boolean) => rows.filter(f).reduce((a, r) => a + BigInt(r.amount_minor), 0n).toString();
    return {
      hackathonId,
      pool,
      network: this.d.cfg.network,
      statement: st
        ? { statementId: st.statement_id, supersedes: st.supersedes, hackathonName: st.hackathon_name, computationId: st.computation_id, currency: st.currency, network: st.network,
            poolMinor: st.pool_minor, issuedAt: new Date(st.issued_at).toISOString(), sha256: st.statement_sha256, statement: st.statement_json, signature: st.signature }
        : null,
      rows: rows.map((r) => {
        const s = statements.get(r.statement_id);
        const live = wallets.get(r.github_user_id) ?? null;
        return {
          payoutId: r.id, githubUserId: r.github_user_id, login: r.login, amountMinor: r.amount_minor, currency: r.currency, network: r.network, status: r.status,
          recipient: r.recipient, liveWallet: live, walletChanged: r.status === 'awaiting_approval' && r.recipient !== live,
          txSignature: r.tx_signature, txUrl: r.tx_signature ? explorerTx(r.network, r.tx_signature) : null, lastError: r.last_error,
          terms: r.status === 'awaiting_approval' && s ? this.termsFor(r, s) : null,
        };
      }),
      totals: {
        poolMinor: st?.pool_minor ?? null,
        rowsMinor: sum((r) => r.status !== 'removed'),
        paidMinor: sum((r) => r.status === 'paid'),
        awaitingApprovalMinor: sum((r) => r.status === 'awaiting_approval'),
        heldMinor: sum((r) => r.status === 'held_kyc'),
        awaitingWalletMinor: sum((r) => r.status === 'awaiting_wallet'),
        inFlightMinor: sum((r) => r.status === 'submitted' || r.status === 'unknown'),
      },
    };
  }

  // --- approve --------------------------------------------------------------

  /**
   * Checks a person's approval against the agent's own records and forwards
   * it, with the statement it refers to, to the grainhack-signer.
   */
  async approve(payoutId: string, approval: GrainhackApproval): Promise<ApproveResult> {
    if (!this.d.signer) return { ok: false, status: 503, error: 'grainhack-signer is not configured on this agent' };
    const row = await this.row(payoutId);
    if (!row) return { ok: false, status: 404, error: 'no such GrainHack payout' };
    if (row.status !== 'awaiting_approval') return { ok: false, status: 409, error: `payout is ${row.status}, not awaiting approval`, rowStatus: row.status };
    const st = await this.statement(row.statement_id);
    if (!st) return { ok: false, status: 409, error: 'the statement for this row is missing' };
    const terms = this.termsFor(row, st);
    if (!terms || !approval?.terms || !sameGrainhackTerms(approval.terms, terms)) return { ok: false, status: 409, error: 'approval terms do not match this payout' };
    if (st.network !== this.d.cfg.network) return { ok: false, status: 409, error: `statement network ${st.network} is not GRAINHACK_NETWORK ${this.d.cfg.network}` };
    const v = verifyGrainhackApproval(approval, this.d.cfg.trustedApprovers, this.now());
    if (!v.ok) return { ok: false, status: 403, error: `approval rejected: ${v.reason}` };
    const live = (await this.liveWallets(this.d.db, [row.github_user_id])).get(row.github_user_id) ?? null;
    if (live !== row.recipient) {
      return { ok: false, status: 409, error: `the winner's live wallet link is no longer ${row.recipient}; a person must run "grainhack refreeze ${row.id}" and approve again` };
    }

    const claimed = await this.d.db.query(
      `UPDATE grainhack_payouts SET status = 'submitted', approval = $2, approved_by = $3, approved_at = now(), last_error = NULL, updated_at = now() WHERE id = $1 AND status = 'awaiting_approval'`,
      [payoutId, JSON.stringify(approval), approval.approver],
    );
    if (claimed.rowCount !== 1) return { ok: false, status: 409, error: 'payout was approved concurrently' };
    await this.audit(this.d.db, approval.approver, 'grainhack.approved', payoutId, { terms });

    const res = await this.d.signer.pay({ approval, statement: st.statement_json, statement_signature: st.signature });
    if (res.ok) {
      await this.markPaid(row, st, res.signature, 'grainhack-signer');
      return { ok: true, signature: res.signature, txUrl: explorerTx(row.network, res.signature) };
    }
    // Refused outright (the signer journalled nothing): the row waits for a
    // new approval, with the reason on it. Anything that might have been
    // sent, or that the signer already has a record of, is 'unknown' until
    // reconcile() reads the signer's journal.
    const unknown = res.unknown || res.status === 409;
    await this.d.db.query(`UPDATE grainhack_payouts SET status = $2, last_error = $3, updated_at = now() WHERE id = $1`, [payoutId, unknown ? 'unknown' : 'awaiting_approval', res.error.slice(0, 1000)]);
    await this.audit(this.d.db, 'grainhack-signer', unknown ? 'grainhack.unknown' : 'grainhack.refused_by_signer', payoutId, { error: res.error, status: res.status, existing: res.existing ?? null });
    return { ok: false, status: unknown ? 502 : res.status, error: `grainhack-signer: ${res.error}`, rowStatus: unknown ? 'unknown' : 'awaiting_approval' };
  }

  private async markPaid(row: PayoutRow, st: StatementRow, signature: string, actor: string) {
    const client = await this.d.db.connect();
    try {
      await client.query('BEGIN');
      const u = await client.query(
        `UPDATE grainhack_payouts SET status = 'paid', tx_signature = $2, paid_at = now(), last_error = NULL, updated_at = now() WHERE id = $1 AND status IN ('submitted','unknown')`,
        [row.id, signature],
      );
      if (u.rowCount !== 1) {
        await client.query('ROLLBACK');
        return;
      }
      const decimals = this.d.cfg.mints[row.currency]?.decimals ?? 6;
      await client.query(
        `INSERT INTO grainhack_ledger (kind, hackathon_id, hackathon_name, pool, network, currency, decimals, amount_minor, tx_signature, login, github_user_id, payout_id, recorded_by, at)
         VALUES ('grainhack_payout', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
         ON CONFLICT DO NOTHING`,
        [row.hackathon_id, st.hackathon_name, row.pool, row.network, row.currency, decimals, row.amount_minor, signature, row.login, row.github_user_id, row.id, actor],
      );
      await enqueueReport(client, {
        kind: 'grainhack_paid', githubUserId: row.github_user_id, dedupeKey: `grainhack_paid:${row.id}`,
        payload: {
          hackathon_id: row.hackathon_id, hackathon_name: st.hackathon_name, pool: row.pool, payout_id: row.id, statement_id: st.statement_id, login: row.login,
          amount_minor: row.amount_minor, currency: row.currency, network: row.network, recipient: row.recipient, tx_signature: signature, tx_url: explorerTx(row.network, signature),
        },
      });
      await this.audit(client, actor, 'grainhack.paid', row.id, { tx: signature });
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Brings submitted and unknown rows into line with the signer's journal,
   * which is the record of what was actually sent. Never sends anything.
   */
  async reconcile(hackathonId?: string): Promise<{ paid: number; failed: number; unknown: number; released: number } | null> {
    if (!this.d.signer) return null;
    // Age by the database's clock, the same clock that stamped updated_at.
    const rows = (await this.d.db.query<PayoutRow & { age_ms: number }>(
      `SELECT ${ROW_COLS}, (EXTRACT(EPOCH FROM now() - updated_at) * 1000)::float8 AS age_ms
         FROM grainhack_payouts WHERE status IN ('submitted','unknown') ${hackathonId ? 'AND hackathon_id = $1' : ''}`,
      hackathonId ? [hackathonId] : [],
    )).rows;
    if (!rows.length) return { paid: 0, failed: 0, unknown: 0, released: 0 };
    const journal = await this.d.signer.payouts();
    if (!journal) return null;
    const byPayout = new Map(journal.map((j) => [j.payout_id, j]));
    const byWinner = new Map(journal.map((j) => [`${j.hackathon_id}:${j.pool}:${j.github_user_id}`, j]));
    const out = { paid: 0, failed: 0, unknown: 0, released: 0 };
    for (const row of rows) {
      const j = byPayout.get(row.id);
      if (j?.status === 'confirmed') {
        const st = await this.statement(row.statement_id);
        if (st) await this.markPaid(row, st, j.tx_signature, 'grainhack-signer');
        out.paid++;
      } else if (j?.status === 'failed_unsent') {
        await this.d.db.query(`UPDATE grainhack_payouts SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1 AND status IN ('submitted','unknown')`, [
          row.id, `the signer resolved this as never sent (${j.resolved_by ?? '?'}: ${j.resolved_reason ?? '?'}); one payout per winner, so it is not retried`,
        ]);
        await this.audit(this.d.db, j.resolved_by ?? 'grainhack-signer', 'grainhack.failed', row.id, { tx: j.tx_signature, reason: j.resolved_reason });
        out.failed++;
      } else if (j) {
        if (row.status !== 'unknown') await this.d.db.query(`UPDATE grainhack_payouts SET status = 'unknown', updated_at = now() WHERE id = $1`, [row.id]);
        out.unknown++;
      } else if (byWinner.has(`${row.hackathon_id}:${row.pool}:${row.github_user_id}`)) {
        // The signer has paid or tried to pay this winner under another payout id.
        const other = byWinner.get(`${row.hackathon_id}:${row.pool}:${row.github_user_id}`)!;
        await this.d.db.query(`UPDATE grainhack_payouts SET status = 'unknown', last_error = $2, updated_at = now() WHERE id = $1`, [
          row.id, `the signer has payout ${other.payout_id} (${other.status}) for this winner; a person must look`,
        ]);
        out.unknown++;
      } else if (row.age_ms >= (this.d.orphanAfterMs ?? 5 * 60_000)) {
        // The signer never recorded it, so it never reserved or sent it. Waits
        // for a new approval; it is not re-sent.
        await this.d.db.query(`UPDATE grainhack_payouts SET status = 'awaiting_approval', approval = NULL, last_error = $2, updated_at = now() WHERE id = $1 AND status IN ('submitted','unknown')`, [
          row.id, 'the grainhack-signer has no record of this payout, so nothing was sent; approve it again',
        ]);
        await this.audit(this.d.db, 'grainhack-reconcile', 'grainhack.released', row.id, {});
        out.released++;
      } else {
        out.unknown++;
      }
    }
    return out;
  }
}
