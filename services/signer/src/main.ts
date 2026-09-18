// Starts the signer. Only this process reads the keypair file.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Journal } from './journal.ts';
import { keypairFromEnv, MockRail, type PaymentRail } from './rails.ts';
import { Signer, signerConfig } from './signer.ts';
import { SolanaRail } from './solana-rail.ts';
import { createSignerServer } from './server.ts';

const env = process.env;
const token = env.SIGNER_TOKEN ?? '';
const journalPath = env.SIGNER_JOURNAL_PATH ?? 'data/signer-journal.sqlite';
const railKind = env.SIGNER_RAIL ?? 'mock';
const port = Number(env.SIGNER_PORT ?? env.PORT ?? 8787);
// Loopback locally; '::' on Railway, where only the private network can reach it (no public domain).
const host = env.SIGNER_HOST ?? '127.0.0.1';

mkdirSync(dirname(journalPath), { recursive: true });

let rail: PaymentRail;
if (railKind === 'solana') {
  const kp = keypairFromEnv(env, 'SIGNER_KEYPAIR');
  if (!kp) throw new Error('SIGNER_RAIL=solana needs SIGNER_KEYPAIR_JSON or SIGNER_KEYPAIR_PATH');
  const rpc = env.SOLANA_RPC_URL;
  if (!rpc) throw new Error('SIGNER_RAIL=solana needs SOLANA_RPC_URL');
  rail = new SolanaRail(kp.secret, rpc);
} else if (railKind === 'mock') {
  rail = new MockRail(env.USEPOD_BASE_URL ?? 'http://127.0.0.1:8402', keypairFromEnv(env, 'SIGNER_KEYPAIR') ?? undefined);
} else {
  throw new Error(`unknown SIGNER_RAIL ${railKind}`);
}

const cfg = signerConfig(env);
const signer = new Signer(cfg, new Journal(journalPath, rail.kind), rail);
createSignerServer(signer, token).listen(port, host, () => {
  console.log(`signer (${rail.kind}) ${signer.address()} on ${host}:${port}; ceiling ${cfg.lifetimeCeilingMicro} micro-USD, per-call max ${cfg.maxPerCallMicro}`);
});
