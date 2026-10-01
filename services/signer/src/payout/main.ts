// Starts the payout signer. Only this process reads the payout float keypair.
// It is a different process, key and journal from the inference signer.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { keypairFromEnv } from '../rails.ts';
import { PayoutJournal } from './journal.ts';
import { EscrowAttestor, SolanaEscrowChain } from './escrow-attestor.ts';
import { fetchPullFromGitHub, PayoutSigner } from './payout-signer.ts';
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
const kp = keypairFromEnv(env, 'PAYOUT_KEYPAIR');
if (!kp) throw new Error('PAYOUT_KEYPAIR_JSON or PAYOUT_KEYPAIR_PATH is required');
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
  new SplPayoutRail(kp.secret, need('PAYOUT_RPC_URL')),
);

// The escrow attestor: optional, and its own key. Without it funded bounties
// cannot be drawn or released, and say so; nothing else changes.
let attestor: EscrowAttestor | undefined;
const attestorKp = keypairFromEnv(env, 'ESCROW_ATTESTOR_KEYPAIR');
if (attestorKp) {
  const escrowNetwork = need('ESCROW_NETWORK');
  if (escrowNetwork === 'solana-mainnet' && env.ESCROW_ALLOW_MAINNET !== 'yes') {
    throw new Error('mainnet escrows are disabled (set ESCROW_ALLOW_MAINNET=yes deliberately)');
  }
  const chain = new SolanaEscrowChain(attestorKp.secret, need('ESCROW_RPC_URL'));
  attestor = new EscrowAttestor(
    {
      network: escrowNetwork,
      attestor: chain.address(),
      // The same allowlist and approvers as payouts: one list, edited by hand.
      allowedRepos: need('PAYOUT_ALLOWED_REPOS').split(',').map((s) => s.trim()).filter(Boolean),
      trustedApprovers: need('APPROVER_PUBKEYS').split(',').map((s) => s.trim()).filter(Boolean),
      caps: {},
    },
    journal,
    chain,
    fetchPullFromGitHub,
  );
}

const port = Number(env.PAYOUT_SIGNER_PORT ?? env.PORT ?? 8788);
const host = env.PAYOUT_SIGNER_HOST ?? '127.0.0.1';
createPayoutServer(signer, journal, need('PAYOUT_SIGNER_TOKEN'), attestor).listen(port, host, () => {
  console.log(`payout signer (${network}) ${signer.address()} on ${host}:${port}${attestor ? `; escrow attestor (${attestor.network()}) ${attestor.address()}` : '; no escrow attestor'}`);
});
