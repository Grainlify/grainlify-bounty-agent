// Runs the real gate against real PR facts. Read-only: it decides nothing and
// pays nothing, it just prints every check the way the agent would see it.
import { evaluateGate, type GateFacts, type GatePolicy } from '../packages/gate/src/gate.ts';

const policy: GatePolicy = {
  caps: { USDC: { perBountyMaxMinor: 50_000_000n, dailyMaxMinor: 150_000_000n }, ANSEM: { perBountyMaxMinor: 6_000_000n, dailyMaxMinor: 10_000_000n } },
  minAccountAgeDays: 30,
  allowedNetworks: ['solana-mainnet'],
};
const f = JSON.parse(process.argv[2]!) as Record<string, unknown>;
const facts: GateFacts = {
  repo: { fullName: 'Grainlify/grainlify-bounty-agent', allowlisted: true, enabled: true },
  bounty: { id: 'b1', status: 'in_review', issueNumber: f.issue as number, amountMinor: BigInt(f.amountMinor as string), currency: f.currency as string, network: 'solana-mainnet' },
  pr: { number: f.pr as number, merged: f.merged as boolean, mergedByLogin: (f.mergedBy as string) ?? null, mergedByPermission: (f.mergedByPermission as string) ?? null, authorId: f.authorId as number, authorLogin: f.author as string, authorType: 'User', closesIssues: f.closes as number[] },
  author: { createdAt: new Date(f.authorCreatedAt as string) },
  wallet: f.wallet ? { address: f.wallet as string } : null,
  bountyAlreadyHasPayout: false,
  paidTodayMinor: 0n,
} as GateFacts;
const r = evaluateGate(facts, policy, new Date());
console.log(`PR #${f.pr} by ${f.author} -> ${r.pass ? 'PASS' : 'REFUSED'}`);
for (const c of r.checks) console.log(`  ${c.pass ? 'ok  ' : 'FAIL'} ${c.name.padEnd(26)} ${c.detail ?? ''}`);
