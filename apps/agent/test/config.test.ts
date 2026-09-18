import { describe, expect, it } from 'vitest';
import { evaluateGate } from '../../../packages/gate/src/gate.ts';
import { allowedPayoutNetworks, p2Config } from '../src/config.ts';

describe('mainnet payout switch', () => {
  it('keeps mainnet off unless GATE_ALLOW_MAINNET=yes, and then allows only mainnet', () => {
    expect(allowedPayoutNetworks({})).toEqual(['solana-devnet', 'localnet']);
    expect(allowedPayoutNetworks({ GATE_ALLOW_MAINNET: 'true' })).not.toContain('solana-mainnet');
    expect(allowedPayoutNetworks({ GATE_ALLOW_MAINNET: 'yes' })).toEqual(['solana-mainnet']);
  });

  it('makes the gate refuse a mainnet bounty while the switch is off', () => {
    const cfg = p2Config({ mints: {}, trustedApprovers: [] });
    const r = evaluateGate(
      {
        repo: { fullName: 'a/b', allowlisted: true, enabled: true },
        bounty: { id: 'b', status: 'in_review', issueNumber: 1, amountMinor: 1_000_000n, currency: 'USDC', network: 'solana-mainnet' },
        pr: { number: 2, merged: true, mergedByLogin: 'm', mergedByPermission: 'admin', authorId: 1, authorLogin: 'c', authorType: 'User', closesIssues: [1] },
        author: { createdAt: new Date('2020-01-01') }, wallet: { address: 'w' }, bountyAlreadyHasPayout: false, paidTodayMinor: 0n,
      },
      { ...cfg.gate, allowedNetworks: allowedPayoutNetworks({}) },
      new Date(),
    );
    expect(r.checks.find((c) => c.name === 'network_allowed')?.pass).toBe(false);
  });
});
