// Builds the agent from environment variables. Shared by the server and the CLI.

import { readFileSync } from 'node:fs';
import pg from 'pg';
import { budgetConfig, PHASES, type Phase } from '../../../packages/budget/src/governor.ts';
import { bindLedgerMode, migrate, PgReceiptStore, PgSpendLedger } from '../../../packages/db/src/pg.ts';
import { importDevnetRun } from '../../../packages/db/src/devnet-import.ts';
import { X402Client } from '../../../packages/x402/src/client.ts';
import { SignerClient } from '../../../services/signer/src/client.ts';
import { allowedPayoutNetworks, p2Config } from './config.ts';
import { GitHubAppClient } from './github.ts';
import { PayoutSignerClient } from './payout-client.ts';
import { BountyService } from './service.ts';
import { PublicApi, publicOrigins } from './public.ts';

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};

export async function wire() {
  const env = process.env;
  const usepod = need('USEPOD_BASE_URL');
  const live = usepod.includes('api.usepod.ai');
  // P2 rule: inference goes to the mock until the P1 report is in.
  if (live && env.ALLOW_LIVE_INFERENCE !== 'yes') throw new Error('USEPOD_BASE_URL points at the real gateway; set ALLOW_LIVE_INFERENCE=yes deliberately (not in P2)');

  const db = new pg.Pool({ connectionString: need('DATABASE_URL') });
  await migrate(db);
  await bindLedgerMode(db, live ? 'live' : 'mock');
  // Optional and one-shot: a failed import is logged, never allowed to stop the agent.
  await importDevnetRun(db, env.DEVNET_IMPORT_B64).catch((e) => console.error('devnet import failed, continuing:', e instanceof Error ? e.message : e));
  // Hosted: individual secret variables. Local: the files the manifest flow wrote.
  const app = env.GITHUB_APP_ID
    ? { id: Number(env.GITHUB_APP_ID), webhook_secret: need('GITHUB_WEBHOOK_SECRET') }
    : (JSON.parse(readFileSync(need('GITHUB_APP_CONFIG'), 'utf8')) as { id: number; webhook_secret: string });
  const pem = env.GITHUB_APP_PRIVATE_KEY_PEM ?? readFileSync(need('GITHUB_APP_PRIVATE_KEY'), 'utf8');
  if (!app.webhook_secret || app.webhook_secret.length < 32) throw new Error('webhook secret missing or too short');
  const gh = new GitHubAppClient(app.id, pem);
  const phase = (env.INFERENCE_PHASE ?? 'P2P3') as Phase;
  if (!PHASES.includes(phase)) throw new Error(`bad INFERENCE_PHASE ${phase}`);

  const x402 = new X402Client({
    baseUrl: usepod,
    payer: new SignerClient(need('SIGNER_URL'), need('SIGNER_TOKEN')),
    ledger: new PgSpendLedger(db, budgetConfig({ lifetimeCeilingMicro: env.INFERENCE_LIFETIME_CEILING_MICRO ? Number(env.INFERENCE_LIFETIME_CEILING_MICRO) : undefined })),
    receipts: new PgReceiptStore(db),
  });
  const network = env.PAYOUT_NETWORK ?? 'solana-devnet';
  const allowedNetworks = allowedPayoutNetworks(env);
  if (!allowedNetworks.includes(network)) throw new Error(`PAYOUT_NETWORK=${network} is not allowed (mainnet needs GATE_ALLOW_MAINNET=yes)`);
  const base = p2Config({ mints: {}, trustedApprovers: [] });
  const cfg = p2Config({
    gate: { ...base.gate, allowedNetworks },
    network,
    mints: JSON.parse(need('PAYOUT_MINTS')) as Record<string, { mint: string; decimals: number }>,
    trustedApprovers: need('APPROVER_PUBKEYS').split(',').map((s) => s.trim()).filter(Boolean),
    inferencePhase: phase,
    inferenceMode: live ? 'live' : 'mock',
    ...(env.LINK_PAGE_URL ? { linkPageUrl: env.LINK_PAGE_URL } : {}),
  });
  // Public key only (base64): Grainlify-Backend holds the private half. Unset leaves /link/session answering 503.
  const linkCountersignKey = env.BOUNTY_LINK_COUNTERSIGN_PUBKEY?.trim() || undefined;
  if (linkCountersignKey && Buffer.from(linkCountersignKey, 'base64').length !== 32) throw new Error('BOUNTY_LINK_COUNTERSIGN_PUBKEY must be base64 of a 32-byte ed25519 public key');
  const service = new BountyService({ db, gh, x402, payoutSigner: new PayoutSignerClient(need('PAYOUT_SIGNER_URL'), need('PAYOUT_SIGNER_TOKEN')), cfg, linkCountersignKey });
  return { db, gh, service, cfg, webhookSecret: app.webhook_secret, publicApi: new PublicApi(db, cfg), publicOrigins: publicOrigins(env) };
}
