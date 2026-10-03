// Builds the agent's GrainHack side from its own environment variables.
// Everything is off unless GRAINHACK_NETWORK is set, and nothing here touches
// the bounty settings.

import type pg from 'pg';
import { compareMints } from '../mint-check.ts';
import { BackendStatementSource, deliverReports, discoverStatements, REPORT_TICK_MS, type ReporterDeps } from './backend.ts';
import { grainhackConfigFromEnv, type GrainhackConfig } from './config.ts';
import { GrainhackService } from './service.ts';
import { GrainhackSignerClient } from './signer-client.ts';

export interface GrainhackWiring {
  cfg: GrainhackConfig;
  service: GrainhackService;
  reporter: ReporterDeps;
  statements: BackendStatementSource | null;
}

/** Reports go to the backend's own GrainHack routes, with the statement token. */
export function reporterFromEnv(env: NodeJS.ProcessEnv, db: pg.Pool): ReporterDeps {
  return {
    db,
    backendUrl: env.GRAINHACK_BACKEND_URL?.trim() || undefined,
    token: env.GRAINHACK_STATEMENT_TOKEN?.trim() || undefined,
  };
}

export function statementsFromEnv(env: NodeJS.ProcessEnv): BackendStatementSource | null {
  const url = env.GRAINHACK_BACKEND_URL?.trim();
  const token = env.GRAINHACK_STATEMENT_TOKEN?.trim();
  return url && token ? new BackendStatementSource(url, token) : null;
}

/**
 * The server's GrainHack wiring. With a signer (GRAINHACK_SIGNER_URL and
 * GRAINHACK_SIGNER_TOKEN) it can forward approvals; without, it can only show
 * and import. A signer that disagrees about network, mints or float is
 * reported loudly and not used to pay.
 */
export async function wireGrainhack(env: NodeJS.ProcessEnv, db: pg.Pool, log: (l: string) => void = console.log): Promise<GrainhackWiring | null> {
  const cfg = grainhackConfigFromEnv(env);
  if (!cfg) {
    log('grainhack: GRAINHACK_NETWORK not set; GrainHack payouts are off on this agent');
    return null;
  }
  const url = env.GRAINHACK_SIGNER_URL?.trim();
  const token = env.GRAINHACK_SIGNER_TOKEN?.trim();
  let signer: GrainhackSignerClient | undefined;
  if (url && token) {
    const client = new GrainhackSignerClient(url, token);
    const remote = await client.config();
    if (!remote) {
      log('grainhack: could not read the grainhack-signer config; approvals will be forwarded but NOT verified against it at boot');
      signer = client;
    } else {
      const problems = compareMints({ network: cfg.network, mints: cfg.mints }, remote);
      if (cfg.floatAddress && remote.address !== cfg.floatAddress) problems.push(`float: GRAINHACK_FLOAT_ADDRESS ${cfg.floatAddress}, signer ${remote.address}`);
      if (problems.length) {
        for (const p of problems) log(`GRAINHACK SIGNER MISMATCH: ${p}`);
        log('grainhack: approvals are OFF until GRAINHACK_* on the agent and the grainhack-signer agree');
      } else {
        signer = client;
        log(`grainhack: agent and grainhack-signer agree (${cfg.network}, float ${remote.address})`);
      }
    }
  } else {
    log('grainhack: GRAINHACK_SIGNER_URL/GRAINHACK_SIGNER_TOKEN not set; statements can be imported and shown, nothing can be paid');
  }
  const reporter = reporterFromEnv(env, db);
  if (!reporter.backendUrl || !reporter.token) log('grainhack: GRAINHACK_BACKEND_URL or GRAINHACK_STATEMENT_TOKEN not set; statements are not fetched and winners will NOT be told they were paid');
  for (const old of ['GRAINHACK_REPORT_TOKEN', 'GRAINHACK_REPORT_PATH']) {
    if (env[old]) log(`grainhack: ${old} is no longer read; reports use GRAINHACK_STATEMENT_TOKEN and the backend's /grainhack routes`);
  }
  return { cfg, service: new GrainhackService({ db, cfg, signer }), reporter, statements: statementsFromEnv(env) };
}

/** How often the poll asks the backend for new statements: every tenth tick by default (5 minutes). */
export const DISCOVER_EVERY_TICKS = 10;

/**
 * The poll: imports statements the backend has issued since the last look
 * (every DISCOVER_EVERY_TICKS ticks, and on the first), reconciles in-flight
 * rows with the signer's journal, moves winners who have since linked a
 * wallet to awaiting approval, and delivers reports. It never sends money:
 * an approval is always a person's.
 */
export function startGrainhackPoll(w: GrainhackWiring, ms = Number(process.env.GRAINHACK_POLL_MS ?? REPORT_TICK_MS), log: (l: string) => void = console.log) {
  let running = false;
  let ticks = 0;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      if (w.statements && ticks++ % DISCOVER_EVERY_TICKS === 0) {
        await discoverStatements({ db: w.reporter.db, source: w.statements, service: w.service, log });
      }
      await w.service.reconcile();
      await w.service.refreshWallets();
      const n = await deliverReports(w.reporter);
      if (n) log(`grainhack: delivered ${n} report(s) to the backend`);
    } catch (e) {
      log(`grainhack poll failed, will retry: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), ms);
  timer.unref?.();
  void tick();
  return { stop: () => clearInterval(timer) };
}
