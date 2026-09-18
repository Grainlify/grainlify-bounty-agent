import type { Phase } from '../../../packages/budget/src/governor.ts';
import type { GatePolicy } from '../../../packages/gate/src/gate.ts';

export interface AgentConfig {
  /** Where payouts happen in this phase. P2: 'solana-devnet' (or 'localnet' in tests). */
  network: string;
  /** Bounty currency -> SPL mint on `network`. */
  mints: Record<string, { mint: string; decimals: number }>;
  defaultCurrency: string;
  gate: GatePolicy;
  priceRangeUsd: { min: number; max: number };
  routing: {
    price: { model: string; max_tokens: number };
    review: { model: string; max_tokens: number };
  };
  inferencePhase: Phase;
  /** 'mock' while inference goes to the local mock gateway: receipts must not look like real payments. */
  inferenceMode: 'mock' | 'live';
  trustedApprovers: string[];
  linkPageUrl: string;
  maxDiffChars: number;
}

export function explorerTx(network: string, sig: string): string {
  if (network === 'solana-mainnet') return `https://solscan.io/tx/${sig}`;
  if (network === 'solana-devnet') return `https://solscan.io/tx/${sig}?cluster=devnet`;
  return `(${network}) ${sig}`;
}

export function formatAmount(minor: bigint, decimals: number, currency: string): string {
  const whole = minor / 10n ** BigInt(decimals);
  const frac = (minor % 10n ** BigInt(decimals)).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole}${frac ? `.${frac}` : ''} ${currency}`;
}

/**
 * Networks the gate lets payouts use. Mainnet is off unless explicitly switched
 * on; the payout signer has its own, separate switch (PAYOUT_ALLOW_MAINNET).
 */
export function allowedPayoutNetworks(env: { GATE_ALLOW_MAINNET?: string }): string[] {
  return env.GATE_ALLOW_MAINNET === 'yes' ? ['solana-mainnet'] : ['solana-devnet', 'localnet'];
}

/** P2 defaults: devnet only, hackathon caps, manual approval for every payout. */
export function p2Config(over: Partial<AgentConfig> & Pick<AgentConfig, 'mints' | 'trustedApprovers'>): AgentConfig {
  return {
    network: 'solana-devnet',
    defaultCurrency: 'USDC',
    gate: {
      caps: { USDC: { perBountyMaxMinor: 50_000_000n, dailyMaxMinor: 150_000_000n } },
      minAccountAgeDays: 30,
      allowedNetworks: ['solana-devnet', 'localnet'],
    },
    priceRangeUsd: { min: 5, max: 50 },
    routing: {
      price: { model: 'gpt-oss-120b', max_tokens: 300 },
      review: { model: 'claude-sonnet-4-6', max_tokens: 700 },
    },
    inferencePhase: 'P2P3',
    inferenceMode: 'mock',
    linkPageUrl: 'https://grainlify.github.io/grainlify-bounty-agent/link/',
    maxDiffChars: 20_000,
    ...over,
  };
}
