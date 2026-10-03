// Starts the grainhack-signer (SERVICE=grainhack-signer). Only this process
// reads the GrainHack float keypair; it has its own journal, caps and config,
// and shares nothing at runtime with the bounty payout signer.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { keypairFromEnv } from '../rails.ts';
import { SplPayoutRail } from '../payout/rail.ts';
import { grainhackSignerConfig } from './config.ts';
import { GrainhackSigner } from './grainhack-signer.ts';
import { GrainhackJournal } from './journal.ts';
import { createGrainhackServer } from './server.ts';

const env = process.env;
const cfg = grainhackSignerConfig(env);
const kp = keypairFromEnv(env, 'GRAINHACK_PAYOUT_KEYPAIR');
if (!kp) throw new Error('GRAINHACK_PAYOUT_KEYPAIR_JSON or GRAINHACK_PAYOUT_KEYPAIR_PATH is required');
const token = env.GRAINHACK_SIGNER_TOKEN?.trim();
if (!token) throw new Error('GRAINHACK_SIGNER_TOKEN is required');
mkdirSync(dirname(cfg.journalPath), { recursive: true });

const journal = new GrainhackJournal(cfg.journalPath);
const signer = new GrainhackSigner(cfg, journal, new SplPayoutRail(kp.secret, cfg.rpcUrl));
const port = Number(env.GRAINHACK_SIGNER_PORT ?? env.PORT ?? 8789);
// Loopback locally; '::' on Railway, where only the private network can reach it.
const host = env.GRAINHACK_SIGNER_HOST ?? '127.0.0.1';
createGrainhackServer(signer, journal, token).listen(port, host, () => {
  console.log(`grainhack-signer (${cfg.network}) ${signer.address()} on ${host}:${port}; caps ${JSON.stringify(signer.caps())}; journal ${cfg.journalPath}`);
});
