// grainhack-signer configuration, read from its own environment. Shared by the
// server and the resolve tool so both refuse the same mistakes.

import { isSolanaAddress } from '../../../../packages/gate/src/ed25519.ts';
import { isResultsPubkey } from '../../../../packages/gate/src/grainhack-statement.ts';
import { parseGrainhackCaps } from './caps.ts';

export const GRAINHACK_NETWORKS = ['solana-devnet', 'solana-mainnet', 'localnet'];

/**
 * Keys that belong to other processes. A grainhack-signer that can see one of
 * them is misconfigured: keys stay separate per process, so it refuses to start.
 */
export const FOREIGN_KEY_VARS = [
  'PAYOUT_KEYPAIR_JSON', 'PAYOUT_KEYPAIR_PATH', 'SIGNER_KEYPAIR_JSON', 'SIGNER_KEYPAIR_PATH', 'ESCROW_ATTESTOR_KEYPAIR_JSON', 'ESCROW_ATTESTOR_KEYPAIR_PATH',
];

export function grainhackNetwork(env: NodeJS.ProcessEnv): string {
  const network = env.GRAINHACK_PAYOUT_NETWORK?.trim();
  if (!network) throw new Error('GRAINHACK_PAYOUT_NETWORK is required');
  if (!GRAINHACK_NETWORKS.includes(network)) throw new Error(`GRAINHACK_PAYOUT_NETWORK=${network} is not one of ${GRAINHACK_NETWORKS.join(', ')}`);
  if (network === 'solana-mainnet' && env.GRAINHACK_ALLOW_MAINNET !== 'yes') {
    throw new Error('GRAINHACK_PAYOUT_NETWORK=solana-mainnet needs GRAINHACK_ALLOW_MAINNET=yes, set deliberately');
  }
  return network;
}

export function grainhackSignerConfig(env: NodeJS.ProcessEnv) {
  const need = (k: string) => {
    const v = env[k]?.trim();
    if (!v) throw new Error(`${k} is required`);
    return v;
  };
  const foreign = FOREIGN_KEY_VARS.filter((k) => env[k]);
  if (foreign.length) throw new Error(`grainhack-signer must not see another process's key: unset ${foreign.join(', ')}`);
  const network = grainhackNetwork(env);
  const mints = JSON.parse(need('GRAINHACK_PAYOUT_MINTS')) as Record<string, { mint: string; decimals: number }>;
  for (const [c, m] of Object.entries(mints)) {
    if (!isSolanaAddress(m?.mint) || !Number.isInteger(m?.decimals)) throw new Error(`GRAINHACK_PAYOUT_MINTS.${c} must be {mint, decimals}`);
  }
  const resultsPubkey = need('GRAINHACK_RESULTS_PUBKEY');
  if (!isResultsPubkey(resultsPubkey)) throw new Error('GRAINHACK_RESULTS_PUBKEY must be base64 of a 32-byte Ed25519 public key');
  const trustedApprovers = need('APPROVER_PUBKEYS').split(',').map((s) => s.trim()).filter(Boolean);
  if (!trustedApprovers.every(isSolanaAddress)) throw new Error('APPROVER_PUBKEYS must be Solana addresses');
  return {
    network,
    mints,
    caps: parseGrainhackCaps(env.GRAINHACK_CAPS),
    trustedApprovers,
    resultsPubkey,
    journalPath: env.GRAINHACK_JOURNAL_PATH?.trim() || 'data/grainhack-journal.sqlite',
    rpcUrl: need('GRAINHACK_PAYOUT_RPC_URL'),
  };
}
