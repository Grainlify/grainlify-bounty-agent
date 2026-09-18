// Starts the payout signer. Only this process reads the payout float keypair.
// It is a different process, key and journal from the inference signer.

import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadSolanaKeypair } from '../rails.ts';
import { PayoutJournal } from './journal.ts';
import { PayoutSigner } from './payout-signer.ts';
import { SplPayoutRail } from './rail.ts';
import { createPayoutServer } from './server.ts';

const env = process.env;
const need = (k: string) => {
  const v = env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};

const network = need('PAYOUT_NETWORK');
if (network === 'solana-mainnet' && env.PAYOUT_ALLOW_MAINNET !== 'yes') {
  throw new Error('mainnet payouts are disabled until P3 (set PAYOUT_ALLOW_MAINNET=yes deliberately)');
}
const keyPath = need('PAYOUT_KEYPAIR_PATH');
if (!existsSync(keyPath)) throw new Error(`${keyPath} does not exist`);
const journalPath = env.PAYOUT_JOURNAL_PATH ?? 'data/payout-journal.sqlite';
mkdirSync(dirname(journalPath), { recursive: true });

const journal = new PayoutJournal(journalPath);
const signer = new PayoutSigner(
  {
    network,
    mints: JSON.parse(need('PAYOUT_MINTS')) as Record<string, { mint: string; decimals: number }>,
    caps: {}, // hard caps apply; lower them here if needed
    allowedRepos: need('PAYOUT_ALLOWED_REPOS').split(',').map((s) => s.trim()).filter(Boolean),
    trustedApprovers: need('APPROVER_PUBKEYS').split(',').map((s) => s.trim()).filter(Boolean),
  },
  journal,
  new SplPayoutRail(loadSolanaKeypair(keyPath).secret, need('PAYOUT_RPC_URL')),
);

const port = Number(env.PAYOUT_SIGNER_PORT ?? 8788);
createPayoutServer(signer, journal, need('PAYOUT_SIGNER_TOKEN')).listen(port, '127.0.0.1', () => {
  console.log(`payout signer (${network}) ${signer.address()} on 127.0.0.1:${port}`);
});
