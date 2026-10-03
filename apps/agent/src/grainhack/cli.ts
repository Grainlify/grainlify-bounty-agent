// GrainHack operator commands (`pnpm cli grainhack ...`). They need
// DATABASE_URL and the GRAINHACK_* settings, not the GitHub App or inference.
//
//   grainhack import <statement_id> [--file <json>] [--actor <login>]
//       fetch the backend-signed results statement (or read {statement, signature}
//       from a file), verify it, store it, and create or update the winner rows
//   grainhack discover [<hackathon_id>]
//       import whatever the backend has issued since the last look, for one
//       event or for every settled one (what the agent's poll does)
//   grainhack show <hackathon_id>
//       the event's rows and totals, from this database
//   grainhack pool-funded <hackathon_id> <tx_signature> --amount <usdc> --actor <login> [--currency USDC] [--note <text>]
//       record a deposit to the GrainHack float after reading it from the chain
//   grainhack history-event1 <hackathon_id> --actor <login> [--name <event name>]
//       record event 1's two KeeperHub legs on Base Sepolia as testnet history
//   grainhack refreeze <payout_id> --actor <login> --reason <text>
//       re-read a winner's live wallet link for a row not yet approved
//   grainhack deliver-reports
//       send queued payment reports to the backend once

import { readFileSync } from 'node:fs';
import pg from 'pg';
import { migrate } from '../../../../packages/db/src/pg.ts';
import { formatAmount } from '../config.ts';
import { deliverReports, discoverStatements } from './backend.ts';
import { grainhackConfigFromEnv } from './config.ts';
import { recordEvent1History, recordPoolFunding, SolanaDepositChain } from './ledger.ts';
import { GrainhackService } from './service.ts';
import { reporterFromEnv, statementsFromEnv } from './wiring.ts';

/** "4.5" with 6 decimals -> 4500000n. Strict: no exponent, no sign, no more decimals than the token has. */
export function parseAmount(s: string | undefined, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s ?? '');
  if (!m) throw new Error(`amount ${s ?? '(missing)'} is not a plain decimal`);
  const frac = m[2] ?? '';
  if (frac.length > decimals) throw new Error(`amount ${s} has more than ${decimals} decimals`);
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

export async function grainhackCli(sub: string | undefined, rest: string[]): Promise<void> {
  const flag = (name: string) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const env = process.env;
  const cfg = grainhackConfigFromEnv(env);
  if (!cfg) throw new Error('GRAINHACK_NETWORK is not set: GrainHack payouts are off');
  const url = env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const db = new pg.Pool({ connectionString: url });
  try {
    await migrate(db);
    const service = new GrainhackService({ db, cfg });
    const actor = flag('actor') ?? env.MAINTAINER ?? '';
    if (sub === 'import' && rest[0]) {
      const file = flag('file');
      let input: { statement: string; signature: string };
      if (file) {
        input = JSON.parse(readFileSync(file, 'utf8')) as { statement: string; signature: string };
      } else {
        const src = statementsFromEnv(env);
        if (!src) throw new Error('GRAINHACK_BACKEND_URL and GRAINHACK_STATEMENT_TOKEN are required to fetch a statement (or pass --file)');
        input = await src.fetch(rest[0]);
      }
      let id: unknown;
      try {
        id = (JSON.parse(input.statement) as { statement_id?: unknown }).statement_id;
      } catch {
        id = undefined;
      }
      if (id !== rest[0]) throw new Error(`the statement received is ${String(id)}, not the ${rest[0]} asked for; nothing imported`);
      const r = await service.importStatement(input, actor || 'cli');
      if (!r.ok) throw new Error(r.error);
      console.log(`${r.alreadyImported ? 'already imported' : 'imported'} statement ${r.statementId} for hackathon ${r.hackathonId}`);
      if (!r.alreadyImported) console.log(`  rows: ${r.created} created, ${r.updated} updated, ${r.kept} kept (already sent), ${r.removed} removed`);
      console.log(`  by status: ${Object.entries(r.byStatus).map(([k, v]) => `${k}=${v}`).join(' ') || 'none'}`);
    } else if (sub === 'discover') {
      const src = statementsFromEnv(env);
      if (!src) throw new Error('GRAINHACK_BACKEND_URL and GRAINHACK_STATEMENT_TOKEN are required to discover statements');
      const r = await discoverStatements({ db, source: src, service, log: console.log }, rest[0] ? [rest[0]] : undefined);
      console.log(`checked ${r.checked} event(s); imported ${r.imported.length}; ${r.errors.length} error(s)`);
      if (r.errors.length) process.exitCode = 1;
    } else if (sub === 'show' && rest[0]) {
      const v = await service.eventView(rest[0]);
      if (!v.statement && !v.rows.length) throw new Error('nothing imported for that hackathon');
      const dec = (c: string) => cfg.mints[c]?.decimals ?? 6;
      console.log(`${v.statement?.hackathonName ?? rest[0]} on ${v.network}; statement ${v.statement?.statementId ?? '-'} (pool ${v.statement ? formatAmount(BigInt(v.statement.poolMinor), dec(v.statement.currency), v.statement.currency) : '-'})`);
      for (const r of v.rows) console.log(`  ${r.login.padEnd(24)} ${formatAmount(BigInt(r.amountMinor), dec(r.currency), r.currency).padStart(16)}  ${r.status.padEnd(17)} ${r.recipient ?? ''}${r.walletChanged ? '  (WALLET CHANGED)' : ''}${r.txUrl ? `  ${r.txUrl}` : ''}`);
      console.log(`  paid ${v.totals.paidMinor}, awaiting approval ${v.totals.awaitingApprovalMinor}, held ${v.totals.heldMinor}, awaiting wallet ${v.totals.awaitingWalletMinor}, in flight ${v.totals.inFlightMinor} (minor units)`);
    } else if (sub === 'pool-funded' && rest[0] && rest[1]) {
      const rpc = env.GRAINHACK_RPC_URL?.trim();
      if (!rpc) throw new Error('GRAINHACK_RPC_URL is required to read the deposit from the chain');
      const currency = flag('currency') ?? 'USDC';
      const decimals = cfg.mints[currency]?.decimals;
      if (decimals === undefined) throw new Error(`no GrainHack mint for ${currency}`);
      const r = await recordPoolFunding(
        { db, cfg, chain: new SolanaDepositChain(rpc) },
        { hackathonId: rest[0], txSignature: rest[1], expectedAmountMinor: parseAmount(flag('amount'), decimals), currency, actor, note: flag('note') },
      );
      if (!r.ok) throw new Error(r.error);
      console.log(`${r.recorded ? 'recorded' : 'already recorded'}: ${formatAmount(BigInt(r.amountMinor), decimals, currency)} into ${r.account} at ${r.at}`);
    } else if (sub === 'history-event1' && rest[0]) {
      const n = await recordEvent1History(db, { hackathonId: rest[0], hackathonName: flag('name'), actor });
      console.log(n ? `recorded ${n} testnet history row(s) for event 1` : 'already recorded; nothing added');
    } else if (sub === 'refreeze' && rest[0]) {
      const r = await service.refreeze(rest[0], actor, flag('reason') ?? '');
      console.log(`recipient ${r.from ?? '(none)'} -> ${r.to ?? '(none: awaiting wallet)'}`);
    } else if (sub === 'deliver-reports') {
      console.log(`delivered ${await deliverReports(reporterFromEnv(env, db))}`);
    } else {
      console.error(
        'usage: grainhack import <statement_id> [--file <json>] [--actor <login>]\n' +
          '     | grainhack discover [<hackathon_id>]\n' +
          '     | grainhack show <hackathon_id>\n' +
          '     | grainhack pool-funded <hackathon_id> <tx_signature> --amount <usdc> --actor <login> [--currency USDC] [--note <text>]\n' +
          '     | grainhack history-event1 <hackathon_id> --actor <login> [--name <event name>]\n' +
          '     | grainhack refreeze <payout_id> --actor <login> --reason <text>\n' +
          '     | grainhack deliver-reports',
      );
      process.exitCode = 2;
    }
  } finally {
    await db.end();
  }
}
