// Retention: an erased account's GrainHack records, five years after the event's
// last payment.
//
// Erasure (erasure-service.ts) keeps an erased winner's GrainHack statement
// lines, payout rows and payment reports, because they are payout records. The
// Terms say payout records are kept for 5 years after the payment, then erased;
// Grainlify-Backend does that to its own copy (internal/erasure/retention.go),
// and this is the same rule for what the agent holds.
//
// # What a pass removes, for an erased account, in an event finished paying
// # more than PAYOUT_RECORD_YEARS ago
//
//   * audit_log: the GrainHack entries about the account's payout rows
//     (approval terms with login, GitHub id and receiving address; refreezes
//     with old and new address; paid, failed, released) - deleted;
//   * grainhack_reports: the reports sent to Grainlify about them (login,
//     receiving address, transaction) - deleted;
//   * grainhack_payouts: the account's rows (GitHub id, login, the frozen
//     receiving address, the signed approval, the transaction) - deleted;
//   * grainhack_statements: every statement of the event that has a line for
//     the account - redacted: those lines are taken out of the stored document,
//     and the signature, which was over the original bytes, is emptied. Every
//     other winner's line stays, and so do the statement's own columns (event,
//     pool, total, network, computation, and the sha256 of the original bytes,
//     which is how a re-import of the same statement is still recognised).
//
// # What stays, and what of it is public
//
// The public GrainHack ledger (grainhack_ledger) is append-only, refuses UPDATE
// and DELETE by trigger, and is never edited silently; a pass does not touch
// it. Its payout rows stay exactly as written: event, amount, network,
// transaction and time, and the login and GitHub id they were written with.
// Publicly an erased account's row shows "erased account" instead of the login
// (account_erasures, the list that does the masking, stays too: it is what
// keeps those two columns from being shown). The per-event public view keeps
// showing such a payment, from the ledger row, once its payout row is gone
// (ledger.ts publicGrainhackEvent). The transaction itself is on a public
// blockchain, with the receiving address, and nobody can remove it.
//
// A line that was never paid (held for KYC) has no ledger row; once its payout
// row and statement line are removed it is no longer listed in the per-event
// view. Nothing was paid, so no ledger row changes.
//
// # When an event has finished paying
//
// Nothing of it is open: no payout row payable and unpaid (awaiting a wallet
// or an approval), with the signer (submitted, unknown), or failed and not
// resolved by a superseding statement, and no payment report Grainlify has not
// received yet. A row held for KYC is not open: like the backend, it waits for
// the person, who may never verify, and must not keep everyone else's records
// for ever. The date counted from is the last payment (payout row or ledger
// row), or the latest statement's issue date if nothing was paid.
//
// # Switched off
//
// The pass runs only when RETENTION_JOB_ENABLED is exactly "true" (main.ts).
// `pnpm cli retention --dry-run` reports what one pass would do now, read-only,
// through the same selection (planRetention).

import type pg from 'pg';

/** How long an erased account's GrainHack payout records are kept after the event's last payment. */
export const PAYOUT_RECORD_YEARS = 5;

/** What a redacted statement says about itself. */
export const REDACTION_NOTE = 'lines of erased accounts removed five years after the payment, as the Terms say; the signature was over the original document and no longer applies';

/** The transaction-local setting that lets a pass past the statements' immutability trigger (0019_grainhack_retention.sql). */
export const RETENTION_SETTING = 'grainlify_agent.grainhack_retention';

/** On only when RETENTION_JOB_ENABLED is exactly "true": the pass deletes. */
export function retentionEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.RETENTION_JOB_ENABLED === 'true';
}

/** now minus PAYOUT_RECORD_YEARS calendar years: a row is due when its date is before this. */
export function retentionCutoff(now: Date): Date {
  const c = new Date(now.getTime());
  c.setUTCFullYear(c.getUTCFullYear() - PAYOUT_RECORD_YEARS);
  return c;
}

const ERASED = `SELECT github_user_id FROM account_erasures`;

/** Every GrainHack event finished paying before $1, with the date that counts from. */
const FINISHED_EVENTS = `
SELECT e.hackathon_id, e.paid_at FROM (
  SELECT h.hackathon_id, COALESCE(
           GREATEST(
             (SELECT max(p.paid_at) FROM grainhack_payouts p WHERE p.hackathon_id = h.hackathon_id),
             (SELECT max(l.at) FROM grainhack_ledger l WHERE l.hackathon_id = h.hackathon_id AND l.kind = 'grainhack_payout')),
           (SELECT max(s.issued_at) FROM grainhack_statements s WHERE s.hackathon_id = h.hackathon_id)) AS paid_at
  FROM (SELECT DISTINCT hackathon_id FROM grainhack_statements) h
  WHERE NOT EXISTS (SELECT 1 FROM grainhack_payouts p WHERE p.hackathon_id = h.hackathon_id
                      AND p.status IN ('awaiting_wallet', 'awaiting_approval', 'submitted', 'unknown', 'failed'))
    AND NOT EXISTS (SELECT 1 FROM grainhack_reports r WHERE r.delivered_at IS NULL
                      AND r.payload ->> 'hackathon_id' = h.hackathon_id::text)) e
WHERE e.paid_at < $1`;

/** The document inside a stored statement: the signed one, or the one kept under "statement" by an earlier redaction. */
const DOC = (alias: string) => `COALESCE(${alias}.statement_json::jsonb -> 'statement', ${alias}.statement_json::jsonb)`;

export interface RetentionStep {
  /** The table, and the key in the pass's counts. */
  table: string;
  action: 'delete' | 'redact';
  /** Selects (id, the date the period counts from) with $1 = the cutoff. The pass and the dry run both select through it. */
  sel: string;
  /** Acts on the selected ids, $1. */
  act: string;
}

/**
 * In the order they act. Every step selects before any acts (planRetention),
 * so the audit and report steps can still find the payout rows the payout step
 * deletes, and the statement step's lines are read from the documents as they
 * were.
 */
export const RETENTION_STEPS: RetentionStep[] = [
  {
    table: 'audit_log',
    action: 'delete',
    sel: `
SELECT a.id::text AS id, fe.paid_at AS at FROM audit_log a
JOIN grainhack_payouts p ON a.subject = p.id::text
JOIN (${FINISHED_EVENTS}) fe ON fe.hackathon_id = p.hackathon_id
WHERE a.action LIKE 'grainhack.%' AND p.github_user_id IN (${ERASED})`,
    act: `DELETE FROM audit_log WHERE id = ANY($1::bigint[])`,
  },
  {
    table: 'grainhack_reports',
    action: 'delete',
    sel: `
SELECT r.id::text AS id, fe.paid_at AS at FROM grainhack_reports r
JOIN (${FINISHED_EVENTS}) fe ON fe.hackathon_id::text = r.payload ->> 'hackathon_id'
WHERE r.github_user_id IN (${ERASED})`,
    act: `DELETE FROM grainhack_reports WHERE id = ANY($1::bigint[])`,
  },
  {
    table: 'grainhack_payouts',
    action: 'delete',
    sel: `
SELECT p.id::text AS id, fe.paid_at AS at FROM grainhack_payouts p
JOIN (${FINISHED_EVENTS}) fe ON fe.hackathon_id = p.hackathon_id
WHERE p.github_user_id IN (${ERASED})`,
    act: `DELETE FROM grainhack_payouts WHERE id = ANY($1::uuid[])`,
  },
  {
    table: 'grainhack_statements',
    action: 'redact',
    sel: `
SELECT s.statement_id::text AS id, fe.paid_at AS at FROM grainhack_statements s
JOIN (${FINISHED_EVENTS}) fe ON fe.hackathon_id = s.hackathon_id
WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(${DOC('s')} -> 'lines') e
              WHERE (e ->> 'github_user_id')::bigint IN (${ERASED}))`,
    act: `
UPDATE grainhack_statements s
SET statement_json = jsonb_build_object(
      'redacted', '${REDACTION_NOTE.replace(/'/g, "''")}',
      'statement', (${DOC('s')} - 'lines') || jsonb_build_object('lines', COALESCE((
          SELECT jsonb_agg(e ORDER BY ord)
          FROM jsonb_array_elements(${DOC('s')} -> 'lines') WITH ORDINALITY AS t(e, ord)
          WHERE (e ->> 'github_user_id')::bigint NOT IN (${ERASED})), '[]'::jsonb)))::text,
    signature = '',
    redacted_at = now()
WHERE s.statement_id = ANY($1::uuid[])`,
  },
];

export interface PlannedStep {
  table: string;
  action: RetentionStep['action'];
  ids: string[];
  oldest: Date | null;
  newest: Date | null;
}

type Querier = Pick<pg.PoolClient, 'query'>;

/** Selects every step's rows, before any is acted on. The pass and the dry run both call this. */
export async function planRetention(q: Querier, cutoff: Date): Promise<PlannedStep[]> {
  const out: PlannedStep[] = [];
  for (const st of RETENTION_STEPS) {
    const rows = (await q.query<{ id: string; at: Date | null }>(st.sel, [cutoff])).rows;
    const p: PlannedStep = { table: st.table, action: st.action, ids: [], oldest: null, newest: null };
    for (const r of rows) {
      p.ids.push(r.id);
      if (r.at) {
        const at = new Date(r.at);
        if (!p.oldest || at < p.oldest) p.oldest = at;
        if (!p.newest || at > p.newest) p.newest = at;
      }
    }
    out.push(p);
  }
  return out;
}

/**
 * One pass, in one transaction: an event's records go together or not at all.
 * Repeatable read, so every selection sees one snapshot and a row changed by
 * somebody else meanwhile fails the pass instead of being acted on from a
 * stale read. If a step would act on a different number of rows than it
 * selected, nothing is committed: the dry run would then have said something
 * the pass did not do. Safe to run again: a second pass finds nothing.
 */
export async function runRetention(db: pg.Pool, now: Date = new Date()): Promise<Record<string, number>> {
  const cutoff = retentionCutoff(now);
  const client = await db.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const plan = await planRetention(client, cutoff);
    // Only this transaction, and only when it has statements to redact, may
    // pass the statements' immutability trigger.
    if (plan.some((p) => p.action === 'redact' && p.ids.length > 0)) {
      await client.query(`SELECT set_config($1, txid_current()::text, true)`, [RETENTION_SETTING]);
    }
    const out: Record<string, number> = {};
    for (const p of plan) {
      out[p.table] = 0;
      if (!p.ids.length) continue;
      const step = RETENTION_STEPS.find((s) => s.table === p.table)!;
      const n = (await client.query(step.act, [p.ids])).rowCount ?? 0;
      if (n !== p.ids.length) {
        throw new Error(`retention: ${p.table}: selected ${p.ids.length} rows but ${p.action === 'delete' ? 'deleted' : 'redacted'} ${n}; nothing committed`);
      }
      out[p.table] = n;
    }
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export interface DryRunReport {
  generatedAt: string;
  rule: string;
  cutoff: string;
  /** Set when this database does not have what the pass needs yet; nothing else is reported then. */
  notApplicable?: string;
  tables: { table: string; action: RetentionStep['action']; rows: number; oldest: string | null; newest: string | null }[];
}

/**
 * What one runRetention would do now, done inside a READ ONLY transaction (the
 * database refuses any write in it) that is always rolled back. It names no
 * person: tables, actions, counts and dates. `ids` is for the tests.
 */
export async function retentionDryRun(db: pg.Pool, now: Date = new Date()): Promise<DryRunReport & { ids: Record<string, string[]> }> {
  const cutoff = retentionCutoff(now);
  const rep: DryRunReport & { ids: Record<string, string[]> } = {
    generatedAt: now.toISOString(),
    rule: `GrainHack payout records of erased accounts, ${PAYOUT_RECORD_YEARS} years after the event's last payment`,
    cutoff: cutoff.toISOString(),
    tables: [],
    ids: {},
  };
  const client = await db.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      for (const p of await planRetention(client, cutoff)) {
        rep.tables.push({ table: p.table, action: p.action, rows: p.ids.length, oldest: p.oldest?.toISOString() ?? null, newest: p.newest?.toISOString() ?? null });
        rep.ids[p.table] = p.ids;
      }
    } catch (e) {
      // undefined table / column: an agent database not yet migrated this far.
      const code = (e as { code?: string }).code;
      if (code !== '42P01' && code !== '42703') throw e;
      rep.notApplicable = `not applicable before this release: ${(e as Error).message}`;
      rep.tables = [];
      rep.ids = {};
    }
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
  return rep;
}

/** The report for a person to read. */
export function dryRunText(rep: DryRunReport): string {
  const day = (s: string | null) => (s ? s.slice(0, 10) : '-');
  const lines = [
    `GrainHack retention dry run, ${rep.generatedAt}`,
    'What one pass of the retention job would do now. Read-only transaction: nothing was written.',
    `rule:   ${rep.rule}`,
    `cutoff: before ${rep.cutoff}`,
  ];
  if (rep.notApplicable) return [...lines, rep.notApplicable, ''].join('\n');
  lines.push(`${'table'.padEnd(22)} ${'action'.padEnd(7)} ${'rows'.padStart(6)}  ${'oldest'.padEnd(10)}  newest`);
  let total = 0;
  for (const t of rep.tables) {
    total += t.rows;
    lines.push(`${t.table.padEnd(22)} ${t.action.padEnd(7)} ${String(t.rows).padStart(6)}  ${day(t.oldest).padEnd(10)}  ${day(t.newest)}`);
  }
  lines.push(`${'total'.padEnd(22)} ${''.padEnd(7)} ${String(total).padStart(6)}`);
  lines.push('The public GrainHack ledger is never in it: its rows stay as written, an erased account shown as "erased account".');
  return [...lines, ''].join('\n');
}

/** Runs the pass now and then daily. Only call it when retentionEnabled(). Returns a stop function. */
export function startRetentionJob(db: pg.Pool, log: (m: string) => void = console.log, everyMs = 24 * 60 * 60_000): () => void {
  const pass = () => {
    runRetention(db)
      .then((n) => {
        const total = Object.values(n).reduce((a, b) => a + b, 0);
        if (total > 0) log(`retention pass: ${JSON.stringify(n)}`);
      })
      .catch((e) => log(`retention pass failed, continuing: ${e instanceof Error ? e.message : String(e)}`));
  };
  pass();
  const timer = setInterval(pass, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
