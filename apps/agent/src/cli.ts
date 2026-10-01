// Maintainer and approver commands.
//
//   repo add <owner/name>                 allowlist a repo the App is installed on
//   bounty propose <owner/name> <issue>   price an issue (one inference call) and post the bounty
//   bounty seed <owner/name> <issue> <usd> [--test] [--newcomers] [--waive rule] [--title t]
//                                         create a bounty at a chosen amount, with no
//                                         inference call and no GitHub comment
//   approve <payout-id>                   show a payout, confirm, sign with the approver key, submit
//   bounty close <bounty-id> --actor <login> --reason <text>
//                                         cancel an open bounty and release its holder as our
//                                         decision (no abandon); they are told the reason
//   bounty tell-closed <assignment-id> --actor <login> --reason <text>
//                                         tell a holder released earlier that the round closed
//
// `approve` talks to the agent over HTTP and signs locally: the approver key
// never leaves this machine and never reaches the agent.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { signApproval, type PayoutTerms } from '../../../packages/gate/src/approval.ts';
import { publicKeyOf } from '../../../packages/gate/src/ed25519.ts';
import type { GateResult } from '../../../packages/gate/src/gate.ts';
import { formatAmount } from './config.ts';

const [cmd, sub, ...rest] = process.argv.slice(2);

async function approve(payoutId: string) {
  const agent = process.env.AGENT_URL ?? 'http://127.0.0.1:3000';
  const keyPath = process.env.APPROVER_KEYPAIR ?? join(homedir(), '.config', 'grainlify-bounty-agent', 'approver.keypair.json');
  const secret = Uint8Array.from(JSON.parse(readFileSync(keyPath, 'utf8')) as number[]);

  const token = process.env.PAYOUTS_API_TOKEN?.trim();
  if (!token) throw new Error('PAYOUTS_API_TOKEN is required to read a payout (the same value the agent has)');
  const r = await fetch(`${agent}/api/payouts/${payoutId}`, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`agent: ${r.status} ${await r.text()}`);
  const v = (await r.json()) as { terms: PayoutTerms; status: string; gate: GateResult };
  const t = v.terms;
  console.log(`\nPayout ${t.payout_id}  (status: ${v.status})`);
  console.log(`  ${formatAmount(BigInt(t.amount_minor), 6, t.currency)} on ${t.network} (mint ${t.mint})`);
  console.log(`  to ${t.recipient} (GitHub ${t.author_login})`);
  console.log(`  for ${t.repo}#${t.issue_number}, PR #${t.pr_number}`);
  console.log('  gate:');
  for (const c of v.gate.checks) console.log(`    ${c.pass ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`);
  if (v.status !== 'awaiting_approval') throw new Error('this payout is not awaiting approval');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`\nType the amount (${formatAmount(BigInt(t.amount_minor), 6, t.currency)}) exactly to approve, anything else to cancel: `);
  rl.close();
  if (answer.trim() !== formatAmount(BigInt(t.amount_minor), 6, t.currency)) {
    console.log('Cancelled. Nothing was signed.');
    return;
  }
  const approval = signApproval(t, secret, publicKeyOf(secret), new Date());
  const res = await fetch(`${agent}/api/payouts/${payoutId}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approval }) });
  const body = await res.text();
  if (!res.ok) throw new Error(`payout failed: ${body}`);
  console.log(`Paid: ${body}`);
}

async function main() {
  if (cmd === 'approve' && sub) return approve(sub);
  const { service, db } = await (await import('./wiring.ts')).wire();
  try {
    if (cmd === 'repo' && sub === 'add' && rest[0]) {
      await service.addRepo(rest[0], true);
      console.log(`allowlisted ${rest[0]}`);
    } else if (cmd === 'bounty' && sub === 'close' && rest[0]) {
      const flag = (name: string) => {
        const i = rest.indexOf(`--${name}`);
        return i >= 0 ? rest[i + 1] : undefined;
      };
      const actor = flag('actor'); const reason = flag('reason');
      if (!actor || !reason) throw new Error('bounty close needs --actor <login> and --reason <text>');
      const { draw } = await (await import('./wiring.ts')).wire();
      const r = await draw.closeByDecision({ bountyId: rest[0], actor, reason });
      if (!r.ok) throw new Error(`not closed: ${r.error}${'detail' in r && r.detail ? ` - ${r.detail}` : ''}`);
      console.log(`closed ${rest[0]}${r.contributor ? `; released ${r.contributor} (no abandon); notification ${r.notified ? 'queued' : 'NOT queued'}` : '; nobody held it'}`);
    } else if (cmd === 'bounty' && sub === 'tell-closed' && rest[0]) {
      const flag = (name: string) => {
        const i = rest.indexOf(`--${name}`);
        return i >= 0 ? rest[i + 1] : undefined;
      };
      const actor = flag('actor'); const reason = flag('reason');
      if (!actor || !reason) throw new Error('bounty tell-closed needs --actor <login> and --reason <text>');
      const { draw } = await (await import('./wiring.ts')).wire();
      const r = await draw.tellRoundClosed({ assignmentId: rest[0], actor, reason });
      if (!r.ok) throw new Error(`not sent: ${r.error}`);
      console.log(`told ${r.contributor} the round closed; notification ${r.queued ? 'queued' : 'NOT queued (already sent?)'}`);
    } else if (cmd === 'bounty' && sub === 'seed' && rest[0] && rest[1] && rest[2]) {
      const flag = (name: string) => {
        const i = rest.indexOf(`--${name}`);
        return i >= 0 ? (rest[i + 1] ?? '') : undefined;
      };
      const usd = Number(rest[2]);
      if (!Number.isFinite(usd) || usd <= 0) throw new Error(`bad amount ${rest[2]}`);
      const { draw } = await (await import('./wiring.ts')).wire();
      const r = await service.seedBounty({
        repo: rest[0],
        issueNumber: Number(rest[1]),
        // Six decimals: USDC and ANSEM both use them. Computed in integers to
        // keep a cent from arriving as 0.009999999.
        amountMinor: BigInt(Math.round(usd * 1_000_000)),
        currency: flag('currency'),
        createdBy: process.env.MAINTAINER ?? 'maintainer',
        isTest: rest.includes('--test'),
        waivedRules: flag('waive') ? [flag('waive')!] : [],
        reservedForNewcomers: rest.includes('--newcomers'),
        title: flag('title'),
      });
      const w = await draw.openApplications(r.bountyId);
      console.log(`seeded ${rest.includes('--test') ? 'TEST ' : ''}bounty ${r.bountyId}`);
      console.log(`  ${rest[0]} #${rest[1]} — ${r.title}`);
      console.log(`  applications open until ${w.closesAt}`);
      if (flag('waive')) console.log(`  waives: ${flag('waive')}`);
      if (rest.includes('--newcomers')) console.log('  reserved for newcomers (nobody with a completed bounty can win it)');
    } else if (cmd === 'bounty' && sub === 'propose' && rest[0] && rest[1]) {
      const r = await service.proposeBounty(rest[0], Number(rest[1]), process.env.MAINTAINER ?? 'maintainer', rest[2]);
      console.log(`posted bounty ${r.bountyId}: ${r.amount} minor units; ${r.commentUrl}`);
    } else {
      console.error(
        'usage: agent repo add <owner/name>\n' +
          '     | bounty propose <owner/name> <issue> [currency]\n' +
          '     | bounty seed <owner/name> <issue> <usd> [--test] [--newcomers] [--waive <rule>] [--title <t>] [--currency <c>]\n' +
          '     | approve <payout-id>',
      );
      process.exitCode = 2;
    }
  } finally {
    await db.end();
  }
}

await main();
