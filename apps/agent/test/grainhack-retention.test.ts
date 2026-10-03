// The GrainHack retention pass: an erased account's statement lines, payout
// rows, reports and audit entries go five years after the event's last
// payment; the public ledger stays as written. Needs TEST_DATABASE_URL.

import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase } from '../../../packages/db/src/testing.ts';
import { canonicalJson, type StatementLine } from '../../../packages/gate/src/grainhack-statement.ts';
import { statement } from '../../../packages/gate/test/grainhack-support.ts';
import { p2Config } from '../src/config.ts';
import { ERASED_LOGIN } from '../src/erasure-service.ts';
import { retentionCli } from '../src/grainhack/retention-cli.ts';
import { REDACTION_NOTE, RETENTION_SETTING, RETENTION_STEPS, retentionCutoff, retentionDryRun, retentionEnabled, runRetention } from '../src/grainhack/retention.ts';
import { PublicApi } from '../src/public.ts';

const dbUrl = process.env.TEST_DATABASE_URL;

describe('retention switch and dry-run command', () => {
  it('is on only when RETENTION_JOB_ENABLED is exactly "true"', () => {
    expect(retentionEnabled({ RETENTION_JOB_ENABLED: 'true' })).toBe(true);
    for (const v of [undefined, '', 'TRUE', 'True', '1', 'yes', 'on', ' true', 'true ']) {
      expect(retentionEnabled({ RETENTION_JOB_ENABLED: v })).toBe(false);
    }
  });

  it('the command refuses anything but --dry-run, before touching a database', async () => {
    const before = process.exitCode;
    for (const args of [[], ['--run'], ['--dry-run', 'extra'], ['dry-run']]) {
      process.exitCode = undefined;
      // No DATABASE_URL: reaching the database would throw instead.
      await retentionCli(args, {});
      expect(process.exitCode).toBe(2);
    }
    process.exitCode = before;
  });

  it('counts five calendar years back', () => {
    expect(retentionCutoff(new Date('2031-10-04T00:00:00Z')).toISOString()).toBe('2026-10-04T00:00:00.000Z');
  });
});

describe.skipIf(!dbUrl)('GrainHack retention', () => {
  let db: pg.Pool;
  let api: PublicApi;
  const NOW = new Date('2031-10-04T00:00:00Z'); // cutoff 2026-10-04T00:00:00Z

  // Event A: finished paying 2026-09-02, more than five years before NOW.
  const A = 'a0000000-0000-4000-8000-00000000000a';
  // Event B: last payment one second after the cutoff: not yet five years.
  const B = 'b0000000-0000-4000-8000-00000000000b';
  // Event C: old, but a winner still waits for a wallet: not finished.
  const C = 'c0000000-0000-4000-8000-00000000000c';
  // Event D: old and finished, only a live account in it.
  const D = 'd0000000-0000-4000-8000-00000000000d';
  const ALICE = { github_user_id: 101, login: 'alice' }; // erased, paid
  const BOB = { github_user_id: 202, login: 'bob' }; // erased, held for KYC, never paid
  const CAROL = { github_user_id: 303, login: 'carol' }; // live
  const DAVE = { github_user_id: 404, login: 'dave' }; // live, no wallet yet

  const ids: Record<string, string> = {};

  const insertStatement = async (hackathonId: string, lines: StatementLine[], issuedAt: string, o: { id?: string; supersedes?: string | null; supersededBy?: string | null } = {}) => {
    const id = o.id ?? randomUUID();
    const pool = lines.reduce((a, l) => a + BigInt(l.amount_minor), 0n).toString();
    const s = statement({ statement_id: id, supersedes: o.supersedes ?? null, hackathon_id: hackathonId, hackathon_name: `Event ${hackathonId[0]}`, pool_minor: pool, lines, issued_at: issuedAt });
    await db.query(
      `INSERT INTO grainhack_statements (statement_id, supersedes, superseded_by, hackathon_id, hackathon_name, pool, computation_id, currency, network, pool_minor,
         statement_json, signature, statement_sha256, issued_at, imported_by)
       VALUES ($1,$2,$3,$4,$5,'contributor',$6,'USDC','solana-devnet',$7,$8,'c2lnbmF0dXJl',$9,$10,'t')`,
      [id, o.supersedes ?? null, o.supersededBy ?? null, hackathonId, s.hackathon_name, s.computation_id, pool, canonicalJson(s), randomBytes(32).toString('hex'), issuedAt],
    );
    return id;
  };
  const line = (who: { github_user_id: number; login: string }, amount: string, status: StatementLine['status'] = 'payable'): StatementLine => ({ ...who, amount_minor: amount, status });

  const insertPayout = async (hackathonId: string, statementId: string, who: { github_user_id: number; login: string }, amount: string, status: string, paidAt?: string) => {
    const id = randomUUID();
    const tx = paidAt ? `Tx${hackathonId[0]}${who.github_user_id}` : null;
    const recipient = status === 'paid' ? `Wallet${who.github_user_id}` : null;
    await db.query(
      `INSERT INTO grainhack_payouts (id, hackathon_id, pool, github_user_id, login, statement_id, amount_minor, currency, mint, network, recipient, status, approval, approved_by, tx_signature, paid_at)
       VALUES ($1,$2,'contributor',$3,$4,$5,$6,'USDC','mint','solana-devnet',$7,$8,$9,$10,$11,$12)`,
      [id, hackathonId, who.github_user_id, who.login, statementId, amount, recipient, status,
        paidAt ? JSON.stringify({ terms: { login: who.login, recipient } }) : null, paidAt ? 'approver' : null, tx, paidAt ?? null],
    );
    if (paidAt) {
      await db.query(
        `INSERT INTO grainhack_ledger (kind, hackathon_id, hackathon_name, pool, network, currency, decimals, amount_minor, tx_signature, login, github_user_id, payout_id, recorded_by, at)
         VALUES ('grainhack_payout',$1,$2,'contributor','solana-devnet','USDC',6,$3,$4,$5,$6,$7,'grainhack-signer',$8)`,
        [hackathonId, `Event ${hackathonId[0]}`, amount, tx, who.login, who.github_user_id, id, paidAt],
      );
      await db.query(
        `INSERT INTO grainhack_reports (kind, github_user_id, payload, dedupe_key, delivered_at) VALUES ('grainhack_paid',$1,$2,$3,$4)`,
        [who.github_user_id, JSON.stringify({ hackathon_id: hackathonId, login: who.login, recipient, tx_signature: tx }), `grainhack_paid:${id}`, paidAt],
      );
      await db.query(`INSERT INTO audit_log (actor, action, subject, detail) VALUES ('approver','grainhack.approved',$1,$2), ('grainhack-signer','grainhack.paid',$1,$3)`, [
        id, JSON.stringify({ terms: { login: who.login, recipient } }), JSON.stringify({ tx }),
      ]);
    }
    return id;
  };

  const snapshot = async (tables: string[]) => {
    const out: Record<string, unknown> = {};
    for (const t of tables) out[t] = (await db.query(`SELECT to_jsonb(x) AS r FROM ${t} x ORDER BY to_jsonb(x)::text`)).rows.map((r) => r.r);
    return JSON.stringify(out);
  };
  const ALL = ['grainhack_statements', 'grainhack_payouts', 'grainhack_ledger', 'grainhack_reports', 'audit_log', 'account_erasures', 'grainhack_retention_log'];
  const docOf = async (statementId: string) => {
    const r = (await db.query<{ statement_json: string; signature: string; redacted_at: Date | null }>(`SELECT statement_json, signature, redacted_at FROM grainhack_statements WHERE statement_id = $1`, [statementId])).rows[0]!;
    return { ...r, json: JSON.parse(r.statement_json) as Record<string, unknown> };
  };

  beforeAll(async () => {
    db = await freshDatabase(dbUrl!, 'test_grainhack_retention');
    api = new PublicApi(db, p2Config({ mints: {}, trustedApprovers: [] }));
  });
  beforeEach(async () => {
    await db.query(`ALTER TABLE grainhack_ledger DISABLE TRIGGER grainhack_ledger_append_only`);
    await db.query(`ALTER TABLE grainhack_statements DISABLE TRIGGER grainhack_statements_immutable`);
    await db.query(`TRUNCATE grainhack_ledger, grainhack_reports, grainhack_payouts, grainhack_statements, grainhack_retention_log, account_erasures, audit_log`);
    await db.query(`ALTER TABLE grainhack_ledger ENABLE TRIGGER grainhack_ledger_append_only`);
    await db.query(`ALTER TABLE grainhack_statements ENABLE TRIGGER grainhack_statements_immutable`);

    // Event A: a first statement, superseded by a second; both name alice and bob.
    ids.A2 = randomUUID();
    ids.A1 = await insertStatement(A, [line(ALICE, '4000000'), line(BOB, '3000000', 'held_kyc'), line(CAROL, '3000000')], '2026-08-30T00:00:00Z', { supersededBy: ids.A2 });
    await insertStatement(A, [line(ALICE, '4000000'), line(BOB, '3500000', 'held_kyc'), line(CAROL, '2500000')], '2026-09-01T00:00:00Z', { id: ids.A2, supersedes: ids.A1 });
    ids.aliceA = await insertPayout(A, ids.A2, ALICE, '4000000', 'paid', '2026-09-02T00:00:00Z');
    ids.bobA = await insertPayout(A, ids.A2, BOB, '3500000', 'held_kyc');
    ids.carolA = await insertPayout(A, ids.A2, CAROL, '2500000', 'paid', '2026-09-01T12:00:00Z');
    await db.query(`INSERT INTO audit_log (actor, action, subject, detail) VALUES ('t','grainhack.statement_imported',$1,'{}')`, [ids.A2]);
    await db.query(
      `INSERT INTO grainhack_ledger (kind, hackathon_id, hackathon_name, network, currency, decimals, amount_minor, tx_signature, recorded_by, at)
       VALUES ('grainhack_pool_funded',$1,'Event a','solana-devnet','USDC',6,10000000,'TxFundA','op','2026-08-31T00:00:00Z')`,
      [A],
    );

    // Event B: alice paid one second inside the five years.
    ids.B = await insertStatement(B, [line(ALICE, '1000000'), line(CAROL, '1000000')], '2026-10-01T00:00:00Z');
    ids.aliceB = await insertPayout(B, ids.B, ALICE, '1000000', 'paid', '2026-10-04T00:00:01Z');
    ids.carolB = await insertPayout(B, ids.B, CAROL, '1000000', 'paid', '2026-10-03T00:00:00Z');

    // Event C: old, alice paid, dave still waiting for a wallet.
    ids.C = await insertStatement(C, [line(ALICE, '1000000'), line(DAVE, '1000000')], '2025-01-01T00:00:00Z');
    ids.aliceC = await insertPayout(C, ids.C, ALICE, '1000000', 'paid', '2025-01-02T00:00:00Z');
    ids.daveC = await insertPayout(C, ids.C, DAVE, '1000000', 'awaiting_wallet');

    // Event D: old and finished, carol alone.
    ids.D = await insertStatement(D, [line(CAROL, '1000000')], '2025-01-01T00:00:00Z');
    ids.carolD = await insertPayout(D, ids.D, CAROL, '1000000', 'paid', '2025-01-02T00:00:00Z');

    await db.query(`INSERT INTO account_erasures (github_user_id, logins, erased_at) VALUES (101, '{alice}', '2026-10-01'), (202, '{bob}', '2026-10-01')`);
  });
  afterAll(async () => {
    await db?.end();
  });

  const auditIdsFor = async (payoutId: string) =>
    (await db.query<{ id: string }>(`SELECT id::text FROM audit_log WHERE subject = $1 ORDER BY id`, [payoutId])).rows.map((r) => r.id);
  const reportIdsFor = async (payoutId: string) =>
    (await db.query<{ id: string }>(`SELECT id::text FROM grainhack_reports WHERE dedupe_key = $1`, [`grainhack_paid:${payoutId}`])).rows.map((r) => r.id);

  it('the dry run selects exactly what the pass removes, and writes nothing', async () => {
    const before = await snapshot(ALL);
    const dry = await retentionDryRun(db, NOW);
    expect(await snapshot(ALL)).toBe(before);

    expect(dry.notApplicable).toBeUndefined();
    expect(dry.cutoff).toBe('2026-10-04T00:00:00.000Z');
    const sorted = (xs: string[]) => [...xs].sort();
    expect(sorted(dry.ids.audit_log!)).toEqual(sorted(await auditIdsFor(ids.aliceA!)));
    expect(dry.ids.grainhack_reports).toEqual(await reportIdsFor(ids.aliceA!));
    expect(sorted(dry.ids.grainhack_payouts!)).toEqual(sorted([ids.aliceA!, ids.bobA!]));
    expect(sorted(dry.ids.grainhack_statements!)).toEqual(sorted([ids.A1!, ids.A2!]));
    expect(dry.tables.map((t) => [t.table, t.action, t.rows])).toEqual([
      ['audit_log', 'delete', 2], ['grainhack_reports', 'delete', 1], ['grainhack_payouts', 'delete', 2], ['grainhack_statements', 'redact', 2],
    ]);
    expect(dry.tables.every((t) => t.newest === '2026-09-02T00:00:00.000Z')).toBe(true);
    // The public ledger is never a step.
    expect(RETENTION_STEPS.map((s) => s.table)).not.toContain('grainhack_ledger');

    const n = await runRetention(db, NOW);
    expect(n).toEqual({ audit_log: 2, grainhack_reports: 1, grainhack_payouts: 2, grainhack_statements: 2 });
    for (const id of dry.ids.audit_log!) expect((await db.query(`SELECT 1 FROM audit_log WHERE id = $1`, [id])).rowCount).toBe(0);
    for (const id of dry.ids.grainhack_reports!) expect((await db.query(`SELECT 1 FROM grainhack_reports WHERE id = $1`, [id])).rowCount).toBe(0);
    for (const id of dry.ids.grainhack_payouts!) expect((await db.query(`SELECT 1 FROM grainhack_payouts WHERE id = $1`, [id])).rowCount).toBe(0);
    for (const id of dry.ids.grainhack_statements!) expect((await docOf(id)).redacted_at).not.toBeNull();
  });

  it('redacts the statements: the erased lines go, the signature is emptied, everything else stays', async () => {
    const original = (await docOf(ids.A2!)).json;
    const cols = async () => (await db.query(`SELECT to_jsonb(s) - ARRAY['statement_json','signature','redacted_at'] AS r FROM grainhack_statements s WHERE statement_id = $1`, [ids.A2])).rows[0]!.r;
    const colsBefore = await cols();
    await runRetention(db, NOW);
    const after = await docOf(ids.A2!);
    expect(after.signature).toBe('');
    expect(after.redacted_at).not.toBeNull();
    expect(after.json.redacted).toBe(REDACTION_NOTE);
    const doc = after.json.statement as Record<string, unknown>;
    expect(doc.lines).toEqual([line(CAROL, '2500000')]);
    const { lines: _a, ...restBefore } = original;
    const { lines: _b, ...restAfter } = doc;
    expect(restAfter).toEqual(restBefore);
    expect(after.statement_json).not.toMatch(/alice|bob|"github_user_id":101|"github_user_id":202/);
    expect(await cols()).toEqual(colsBefore);
    expect((await docOf(ids.A1!)).statement_json).not.toMatch(/alice|bob/);
    // Each redaction is logged, naming a statement and a transaction only.
    const log = (await db.query(`SELECT op, statement_id FROM grainhack_retention_log ORDER BY statement_id`)).rows;
    expect(log).toEqual([ids.A1, ids.A2].sort().map((id) => ({ op: 'statement_redacted', statement_id: id })));
  });

  it('leaves the public ledger exactly as written, and still lists the payment as an erased account\'s', async () => {
    const ledgerBefore = await snapshot(['grainhack_ledger']);
    const publicLedgerBefore = (await api.ledger()).events.filter((e) => e.kind.startsWith('grainhack'));
    const viewBefore = (await api.grainhack(A))!;
    expect(viewBefore.winners.map((w) => [w.login, w.status])).toEqual([[ERASED_LOGIN, 'paid'], [ERASED_LOGIN, 'waiting'], ['carol', 'paid']]);

    await runRetention(db, NOW);

    expect(await snapshot(['grainhack_ledger'])).toBe(ledgerBefore);
    expect((await api.ledger()).events.filter((e) => e.kind.startsWith('grainhack'))).toEqual(publicLedgerBefore);
    const view = (await api.grainhack(A))!;
    // The paid erased winner is still there, from the ledger row, unchanged;
    // the never-paid held line is gone with its row and statement line.
    const paidErased = (v: typeof view) => v.winners.filter((w) => w.login === ERASED_LOGIN && w.status === 'paid');
    expect(paidErased(view)).toEqual(paidErased(viewBefore));
    expect(view.winners.map((w) => [w.login, w.status]).sort()).toEqual([['carol', 'paid'], [ERASED_LOGIN, 'paid']]);
    expect(view.totals.paidMinor).toBe(viewBefore.totals.paidMinor);
    expect(view.funding).toEqual(viewBefore.funding);
    expect(JSON.stringify(view)).not.toMatch(/alice|bob/);
  });

  it('touches nothing under five years, in an event still open, or of a live account', async () => {
    const keep = ['B', 'C', 'D'];
    const rowsOf = async () => snapshot(['grainhack_payouts', 'grainhack_reports', 'audit_log']);
    const others = async () => {
      const out: string[] = [];
      for (const k of keep) out.push((await docOf(ids[k]!)).statement_json, (await docOf(ids[k]!)).signature);
      for (const k of ['aliceB', 'carolB', 'aliceC', 'daveC', 'carolD', 'carolA']) {
        out.push(JSON.stringify((await db.query(`SELECT to_jsonb(p) AS r FROM grainhack_payouts p WHERE id = $1`, [ids[k]])).rows[0]?.r ?? null));
        out.push(JSON.stringify(await auditIdsFor(ids[k]!)), JSON.stringify(await reportIdsFor(ids[k]!)));
      }
      return out;
    };
    const before = await others();
    await runRetention(db, NOW);
    expect(await others()).toEqual(before);
    expect(before.every((x) => x !== 'null')).toBe(true);

    // A pass a day earlier than five years after event A's last payment removes nothing at all.
    await db.query(`ALTER TABLE grainhack_statements DISABLE TRIGGER grainhack_statements_immutable`);
    await db.query(`TRUNCATE grainhack_ledger, grainhack_reports, grainhack_payouts, grainhack_statements, grainhack_retention_log, audit_log`);
    await db.query(`ALTER TABLE grainhack_statements ENABLE TRIGGER grainhack_statements_immutable`);
    const s = await insertStatement(A, [line(ALICE, '4000000')], '2026-09-01T00:00:00Z');
    await insertPayout(A, s, ALICE, '4000000', 'paid', '2026-09-02T00:00:00Z');
    const snap = await rowsOf();
    expect(await runRetention(db, new Date('2031-09-01T00:00:00Z'))).toEqual({ audit_log: 0, grainhack_reports: 0, grainhack_payouts: 0, grainhack_statements: 0 });
    expect(await rowsOf()).toBe(snap);
    // An undelivered payment report keeps the event open, whatever its age.
    await db.query(`UPDATE grainhack_reports SET delivered_at = NULL`);
    expect((await retentionDryRun(db, NOW)).tables.every((t) => t.rows === 0)).toBe(true);
  });

  it('is idempotent: a second pass, and the dry run after it, find nothing', async () => {
    await runRetention(db, NOW);
    const after = await snapshot(ALL);
    expect(await runRetention(db, NOW)).toEqual({ audit_log: 0, grainhack_reports: 0, grainhack_payouts: 0, grainhack_statements: 0 });
    expect(await snapshot(ALL)).toBe(after);
    expect((await retentionDryRun(db, NOW)).tables.map((t) => t.rows)).toEqual([0, 0, 0, 0]);
  });

  it('redacts again when another winner of the same statement is erased later', async () => {
    await runRetention(db, NOW);
    await db.query(`INSERT INTO account_erasures (github_user_id, logins) VALUES (303, '{carol}')`);
    // carol's rows in A and D; her lines in A1, A2 and D. Event B is not five years old.
    expect(await runRetention(db, NOW)).toMatchObject({ grainhack_payouts: 2, grainhack_statements: 3 });
    const doc = (await docOf(ids.A2!)).json;
    expect((doc.statement as { lines: unknown[] }).lines).toEqual([]);
    expect(Object.keys(doc).sort()).toEqual(['redacted', 'statement']);
  });

  it('the statements stay immutable to everything but a retention pass', async () => {
    const redacted = canonicalJson({ redacted: REDACTION_NOTE, statement: { ...JSON.parse((await docOf(ids.A2!)).statement_json), lines: [line(CAROL, '2500000')] } });
    const update = (c: pg.PoolClient | pg.Pool, json = redacted) =>
      c.query(`UPDATE grainhack_statements SET statement_json = $2, signature = '', redacted_at = now() WHERE statement_id = $1`, [ids.A2, json]);
    // Outside a pass.
    await expect(update(db)).rejects.toThrow(/immutable/);
    const c = await db.connect();
    try {
      // A session-wide setting, or one naming another transaction, does not match.
      await c.query(`SELECT set_config($1, '1', false)`, [RETENTION_SETTING]);
      await expect(update(c)).rejects.toThrow(/immutable/);
      await c.query(`RESET ALL`);
      const inPass = async (f: () => Promise<unknown>) => {
        await c.query('BEGIN');
        try {
          await c.query(`SELECT set_config($1, txid_current()::text, true)`, [RETENTION_SETTING]);
          return await f();
        } finally {
          await c.query('ROLLBACK');
        }
      };
      // Even in a pass: keeping an erased account's line, adding or changing a
      // line, changing another column, keeping the signature, or deleting.
      const keepsAlice = canonicalJson({ redacted: REDACTION_NOTE, statement: { ...JSON.parse((await docOf(ids.A2!)).statement_json), lines: [line(ALICE, '4000000'), line(CAROL, '2500000')] } });
      const changed = canonicalJson({ redacted: REDACTION_NOTE, statement: { ...JSON.parse((await docOf(ids.A2!)).statement_json), lines: [line(CAROL, '9999999')] } });
      const otherPool = canonicalJson({ redacted: REDACTION_NOTE, statement: { ...JSON.parse((await docOf(ids.A2!)).statement_json), pool_minor: '1', lines: [line(CAROL, '2500000')] } });
      await expect(inPass(() => update(c, keepsAlice))).rejects.toThrow(/immutable/);
      await expect(inPass(() => update(c, changed))).rejects.toThrow(/immutable/);
      await expect(inPass(() => update(c, otherPool))).rejects.toThrow(/immutable/);
      await expect(inPass(() => c.query(`UPDATE grainhack_statements SET statement_json = $2, redacted_at = now() WHERE statement_id = $1`, [ids.A2, redacted]))).rejects.toThrow(/immutable/);
      await expect(inPass(() => c.query(`UPDATE grainhack_statements SET statement_json = $2, signature = '', redacted_at = now(), hackathon_name = 'x' WHERE statement_id = $1`, [ids.A2, redacted]))).rejects.toThrow(/immutable/);
      await expect(inPass(() => c.query(`DELETE FROM grainhack_statements WHERE statement_id = $1`, [ids.A2]))).rejects.toThrow(/never deleted/);
      // The one change allowed.
      await expect(inPass(() => update(c))).resolves.toBeTruthy();
    } finally {
      c.release();
    }
    // The ledger refuses every edit, a pass or not.
    await expect(db.query(`UPDATE grainhack_ledger SET login = 'x'`)).rejects.toThrow(/append-only/);
  });

  it('the dry run reports a database not migrated this far as not applicable', async () => {
    const admin = new pg.Pool({ connectionString: dbUrl!, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS test_grainhack_retention_empty WITH (FORCE)`);
    await admin.query(`CREATE DATABASE test_grainhack_retention_empty`);
    const url = new URL(dbUrl!);
    url.pathname = '/test_grainhack_retention_empty';
    const empty = new pg.Pool({ connectionString: url.toString(), max: 1 });
    try {
      const rep = await retentionDryRun(empty, NOW);
      expect(rep.notApplicable).toMatch(/not applicable before this release/);
      expect(rep.tables).toEqual([]);
    } finally {
      await empty.end();
      await admin.query(`DROP DATABASE IF EXISTS test_grainhack_retention_empty WITH (FORCE)`);
      await admin.end();
    }
  }, 30_000); // creates and drops a database: slow on a loaded machine
});
