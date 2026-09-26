// ANSEM is a real payout currency now, so the fail-closed behaviour is pinned
// deliberately: a currency nobody sized caps for must never pay, and ANSEM must
// not quietly inherit USDC's far larger ceilings.
import { describe, expect, it } from 'vitest';
import { evaluateGate, type GateFacts, type GatePolicy } from '../src/gate.ts';

const now = new Date('2026-09-25T12:00:00Z');
const USDC = { perBountyMaxMinor: 50_000_000n, dailyMaxMinor: 150_000_000n };
const ANSEM = { perBountyMaxMinor: 6_000_000n, dailyMaxMinor: 10_000_000n };
const policy: GatePolicy = {
  caps: { USDC, ANSEM },
  minAccountAgeDays: 30,
  allowedNetworks: ['solana-mainnet'],
};

function facts(over: Partial<GateFacts['bounty']> = {}, paidTodayMinor = 0n): GateFacts {
  return {
    repo: { fullName: 'Grainlify/grainlify-bounty-agent', allowlisted: true, enabled: true },
    // ~5.21 ANSEM is about $1 at roughly $0.19 a token.
    bounty: { id: 'b1', status: 'in_review', issueNumber: 3, amountMinor: 5_210_000n, currency: 'ANSEM', network: 'solana-mainnet', ...over },
    pr: { number: 7, merged: true, mergedByLogin: 'maintainer', mergedByPermission: 'admin', authorId: 42, authorLogin: 'contributor', authorType: 'User', closesIssues: [3] },
    author: { createdAt: new Date('2020-01-01T00:00:00Z') },
    wallet: { address: 'Wa11et1111111111111111111111111111111111111' },
    bountyAlreadyHasPayout: false,
    paidTodayMinor,
  } as GateFacts;
}

const failed = (f: GateFacts, p = policy) => evaluateGate(f, p, now).checks.filter((c) => !c.pass).map((c) => c.name);

describe('ANSEM payout caps', () => {
  it('passes a $1-sized ANSEM bounty end to end', () => {
    expect(evaluateGate(facts(), policy, now).pass).toBe(true);
  });

  it('refuses an ANSEM bounty above the per-bounty cap', () => {
    expect(failed(facts({ amountMinor: 6_000_001n }))).toContain('within_per_bounty_cap');
  });

  it('refuses once the day would exceed what the float actually holds', () => {
    // The daily ceiling is the float itself: never promise ANSEM that does not exist.
    expect(failed(facts({ amountMinor: 5_000_000n }, 5_000_001n))).toContain('within_daily_cap');
  });

  it('does not let ANSEM inherit the far larger USDC ceilings', () => {
    // 20 ANSEM would sail through a USDC-sized cap.
    expect(failed(facts({ amountMinor: 20_000_000n }))).toContain('within_per_bounty_cap');
  });

  it('fails closed for a currency with no caps configured', () => {
    const bad = failed(facts({ currency: 'DOGE' }));
    expect(bad).toContain('within_per_bounty_cap');
    expect(bad).toContain('within_daily_cap');
  });

  it('fails closed for ANSEM itself if its caps are removed', () => {
    const bad = failed(facts(), { ...policy, caps: { USDC } });
    expect(bad).toContain('within_per_bounty_cap');
    expect(bad).toContain('within_daily_cap');
  });
});
