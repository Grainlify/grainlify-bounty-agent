// Starts the signer. Only this process reads the keypair file.

import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Journal } from './journal.ts';
import { loadSolanaKeypair, MockRail, type PaymentRail } from './rails.ts';
import { Signer, signerConfig } from './signer.ts';
import { SolanaRail } from './solana-rail.ts';
import { createSignerServer } from './server.ts';

const env = process.env;
const token = env.SIGNER_TOKEN ?? '';
const journalPath = env.SIGNER_JOURNAL_PATH ?? 'data/signer-journal.sqlite';
const railKind = env.SIGNER_RAIL ?? 'mock';
const port = Number(env.SIGNER_PORT ?? 8787);

mkdirSync(dirname(journalPath), { recursive: true });

let rail: PaymentRail;
if (railKind === 'solana') {
  const path = env.SIGNER_KEYPAIR_PATH;
  if (!path || !existsSync(path)) throw new Error('SIGNER_RAIL=solana needs SIGNER_KEYPAIR_PATH pointing at a keypair file');
  const rpc = env.SOLANA_RPC_URL;
  if (!rpc) throw new Error('SIGNER_RAIL=solana needs SOLANA_RPC_URL');
  rail = new SolanaRail(loadSolanaKeypair(path).secret, rpc);
} else if (railKind === 'mock') {
  const kp = env.SIGNER_KEYPAIR_PATH && existsSync(env.SIGNER_KEYPAIR_PATH) ? loadSolanaKeypair(env.SIGNER_KEYPAIR_PATH) : undefined;
  rail = new MockRail(env.USEPOD_BASE_URL ?? 'http://127.0.0.1:8402', kp);
} else {
  throw new Error(`unknown SIGNER_RAIL ${railKind}`);
}

const cfg = signerConfig(env);
const signer = new Signer(cfg, new Journal(journalPath), rail);
createSignerServer(signer, token).listen(port, '127.0.0.1', () => {
  console.log(`signer (${rail.kind}) ${signer.address()} on 127.0.0.1:${port}; ceiling ${cfg.lifetimeCeilingMicro} micro-USD, per-call max ${cfg.maxPerCallMicro}`);
});
