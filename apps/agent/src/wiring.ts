// Builds the agent from environment variables. Shared by the server and the CLI.

import { readFileSync } from 'node:fs';
import { Connection, PublicKey } from '@solana/web3.js';
import pg from 'pg';
import { budgetConfig, PHASES, type Phase } from '../../../packages/budget/src/governor.ts';
import { bindLedgerMode, migrate, PgReceiptStore, PgSpendLedger } from '../../../packages/db/src/pg.ts';
import { importDevnetRun } from '../../../packages/db/src/devnet-import.ts';
import { X402Client } from '../../../packages/x402/src/client.ts';
import { SignerClient } from '../../../services/signer/src/client.ts';
import { allowedPayoutNetworks, p2Config } from './config.ts';
import { GitHubAppClient } from './github.ts';
import { PayoutSignerClient } from './payout-client.ts';
import { DrawService } from './draw-service.ts';
import { EscrowService } from './escrow-service.ts';
import { FundedService } from './funded-service.ts';
import { FitService } from './fit-service.ts';
import { assertMintsAgree } from './mint-check.ts';
import { BountyService } from './service.ts';
import { PublicApi, publicOrigins } from './public.ts';
import { wireGrainhack } from './grainhack/wiring.ts';

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
  const payoutSigner = new PayoutSignerClient(need('PAYOUT_SIGNER_URL'), need('PAYOUT_SIGNER_TOKEN'));
  // Funded escrows: their own network and mints, so they can run on devnet
  // with test tokens while the agent's own payouts stay on mainnet.
  const escrowNetwork = env.ESCROW_NETWORK?.trim() || undefined;
  if (escrowNetwork === 'solana-mainnet' && env.ESCROW_ALLOW_MAINNET !== 'yes') {
    throw new Error('ESCROW_NETWORK=solana-mainnet needs ESCROW_ALLOW_MAINNET=yes, set deliberately');
  }
  cfg.gate = { ...cfg.gate, fundedNetworks: escrowNetwork ? [escrowNetwork] : [] };
  const service = new BountyService({ db, gh, x402, payoutSigner, cfg, linkCountersignKey });
  // Long enough that guessing is not a strategy; short tokens have a way of
  // becoming "temporary" and permanent.
  const payoutsApiToken = env.PAYOUTS_API_TOKEN?.trim() || undefined;
  if (payoutsApiToken && payoutsApiToken.length < 32) throw new Error('PAYOUTS_API_TOKEN must be at least 32 characters');
  // Before anything can create a bounty: does the service that will sign the
  // transfer agree with us about what we are paying? A bounty keeps its mint
  // forever, so this has to happen at boot, not at payout.
  await assertMintsAgree({ network: cfg.network, mints: cfg.mints }, env);

  const fit = new FitService({ db, gh, x402, cfg, now: () => new Date() });
  const draw = new DrawService({ db, gh, fit, now: () => new Date() });

  // All or nothing: a half-configured escrow would quote fees for escrows
  // nobody can create. Unset leaves every funded route answering 503.
  let escrow: EscrowService | undefined;
  let funded: FundedService | undefined;
  if (escrowNetwork) {
    const escrowMints = JSON.parse(need('ESCROW_MINTS')) as Record<string, { mint: string; decimals: number }>;
    const attestorKey = new PublicKey(need('ESCROW_ATTESTOR_PUBKEY'));
    escrow = new EscrowService({
      db,
      connection: new Connection(need('ESCROW_RPC_URL'), 'confirmed'),
      attestor: attestorKey,
      feeDestination: new PublicKey(need('ESCROW_FEE_DESTINATION')),
      network: escrowNetwork,
      mints: escrowMints,
      testers: (env.FUNDED_BOUNTIES_TESTERS ?? '').split(',').map((x) => x.trim()).filter(Boolean),
      now: () => new Date(),
    });
    // The attestor signs only if the payout signer holds the SAME key the
    // escrows are being created to trust. A mismatch would create escrows
    // nobody can release, so it switches draw mode off and says so.
    const signerEscrow = await fetch(`${need('PAYOUT_SIGNER_URL').replace(/\/+$/, '')}/v1/config`, { headers: { authorization: `Bearer ${need('PAYOUT_SIGNER_TOKEN')}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => (j as { escrow?: { network: string; attestor: string } | null } | null)?.escrow ?? null)
      .catch(() => null);
    const attestorAgrees = signerEscrow?.attestor === attestorKey.toBase58() && signerEscrow?.network === escrowNetwork;
    if (!attestorAgrees) {
      console.error(`ESCROW ATTESTOR MISMATCH: agent expects ${attestorKey.toBase58()} on ${escrowNetwork}, payout signer has ${signerEscrow ? `${signerEscrow.attestor} on ${signerEscrow.network}` : 'none'}; draws and releases on funded bounties are off`);
    }
    funded = new FundedService({
      db, gh, draw, escrow,
      attestor: attestorAgrees ? payoutSigner : undefined,
      caps: cfg.gate.caps,
      bountyPageUrl: (id) => `${env.BOUNTY_PAGE_URL?.trim() || 'https://grainlify.com/bounties'}?bounty=${id}`,
      now: () => new Date(),
    });
  }
  // Where contributor notifications go. Unset switches delivery off, loudly.
  const events = {
    db,
    backendUrl: env.BOUNTY_EVENTS_URL?.trim() || undefined,
    secret: env.BOUNTY_EVENTS_SECRET?.trim() || undefined,
  };
  if (events.secret && events.secret.length < 32) throw new Error('BOUNTY_EVENTS_SECRET must be at least 32 characters');
  // GrainHack payouts: their own network, signer and settings, off unless
  // GRAINHACK_NETWORK is set. Nothing above reads them.
  const grainhack = await wireGrainhack(env, db);
  return {
    db, gh, service, cfg, draw, linkCountersignKey, events,
    webhookSecret: app.webhook_secret,
    escrow, funded, grainhack,
    publicApi: new PublicApi(db, cfg, { escrowMints: escrow?.mints(), funded, grainhackMints: grainhack?.cfg.mints }),
    publicOrigins: publicOrigins(env),
    payoutsApiToken,
  };
}
