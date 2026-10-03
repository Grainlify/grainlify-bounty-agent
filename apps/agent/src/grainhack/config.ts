// The agent's GrainHack settings. Independent of the bounty settings on
// purpose: GRAINHACK_NETWORK can be devnet while PAYOUT_NETWORK is mainnet,
// and nothing here reads PAYOUT_* or PAYOUT_ALLOWED_REPOS.

import { isSolanaAddress } from '../../../../packages/gate/src/ed25519.ts';
import { isResultsPubkey } from '../../../../packages/gate/src/grainhack-statement.ts';

export interface GrainhackConfig {
  network: string;
  mints: Record<string, { mint: string; decimals: number }>;
  /** Base64 Ed25519 public key of the backend's results statements. */
  resultsPubkey: string;
  trustedApprovers: string[];
  /** The grainhack-signer's float (public address). Deposits must land in its token account. */
  floatAddress?: string;
}

export const GRAINHACK_AGENT_NETWORKS = ['solana-devnet', 'solana-mainnet', 'localnet'];

/** null when GrainHack payouts are not configured on this agent (GRAINHACK_NETWORK unset). */
export function grainhackConfigFromEnv(env: NodeJS.ProcessEnv): GrainhackConfig | null {
  const network = env.GRAINHACK_NETWORK?.trim();
  if (!network) return null;
  const need = (k: string) => {
    const v = env[k]?.trim();
    if (!v) throw new Error(`${k} is required when GRAINHACK_NETWORK is set`);
    return v;
  };
  if (!GRAINHACK_AGENT_NETWORKS.includes(network)) throw new Error(`GRAINHACK_NETWORK=${network} is not one of ${GRAINHACK_AGENT_NETWORKS.join(', ')}`);
  if (network === 'solana-mainnet' && env.GRAINHACK_ALLOW_MAINNET !== 'yes') throw new Error('GRAINHACK_NETWORK=solana-mainnet needs GRAINHACK_ALLOW_MAINNET=yes, set deliberately');
  const mints = JSON.parse(need('GRAINHACK_MINTS')) as Record<string, { mint: string; decimals: number }>;
  for (const [c, m] of Object.entries(mints)) if (!isSolanaAddress(m?.mint) || !Number.isInteger(m?.decimals)) throw new Error(`GRAINHACK_MINTS.${c} must be {mint, decimals}`);
  const resultsPubkey = need('GRAINHACK_RESULTS_PUBKEY');
  if (!isResultsPubkey(resultsPubkey)) throw new Error('GRAINHACK_RESULTS_PUBKEY must be base64 of a 32-byte Ed25519 public key');
  const floatAddress = env.GRAINHACK_FLOAT_ADDRESS?.trim() || undefined;
  if (floatAddress && !isSolanaAddress(floatAddress)) throw new Error('GRAINHACK_FLOAT_ADDRESS must be a Solana address');
  return {
    network,
    mints,
    resultsPubkey,
    trustedApprovers: need('APPROVER_PUBKEYS').split(',').map((s) => s.trim()).filter(Boolean),
    floatAddress,
  };
}
