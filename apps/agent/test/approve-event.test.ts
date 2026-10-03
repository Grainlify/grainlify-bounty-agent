// approve-event on the approver's machine does not take the agent's word: the
// statement must verify against the backend's key there, and every row's
// terms must match a payable line of it, or nothing is signed for that row.

import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import type { GrainhackTerms } from '../../../packages/gate/src/grainhack-approval.ts';
import { statementSha256, type ResultsStatement } from '../../../packages/gate/src/grainhack-statement.ts';
import { resultsKey, signed, statement } from '../../../packages/gate/test/grainhack-support.ts';
import { approveEvent } from '../src/grainhack/approve-event.ts';

const key = resultsKey(Buffer.alloc(32, 11));
const approver = Keypair.generate();
const HACK = '0d6e8a3c-7b1f-4c5e-9a2d-4e5f6a7b8c9d';
const st = signed(key, statement());
const s = JSON.parse(st.statement) as ResultsStatement;

function terms(over: Partial<GrainhackTerms> = {}): GrainhackTerms {
  return {
    payout_id: '11111111-2222-4333-8444-555555555555', statement_id: s.statement_id, statement_sha256: statementSha256(st.statement), hackathon_id: s.hackathon_id,
    pool: 'contributor', github_user_id: 101, login: 'alice', recipient: Keypair.generate().publicKey.toBase58(), amount_minor: '4000000', currency: 'USDC',
    mint: Keypair.generate().publicKey.toBase58(), network: 'solana-devnet', ...over,
  };
}

function agent(view: { statement: string; signature: string }, rowTerms: GrainhackTerms[], posted: unknown[]) {
  return (async (url: string, init?: RequestInit) => {
    if (url.endsWith('/refresh')) return new Response('{}', { status: 200 });
    if (url.endsWith('/approve')) {
      posted.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ signature: 'sig', txUrl: 'https://solscan.io/tx/sig?cluster=devnet' }), { status: 200 });
    }
    return new Response(JSON.stringify({
      hackathonId: HACK, network: 'solana-devnet',
      statement: { statementId: s.statement_id, hackathonName: s.hackathon_name, poolMinor: s.pool_minor, currency: 'USDC', network: s.network, statement: view.statement, signature: view.signature },
      rows: rowTerms.map((t) => ({ payoutId: t.payout_id, githubUserId: t.github_user_id, login: t.login, amountMinor: t.amount_minor, currency: 'USDC', network: 'solana-devnet', status: 'awaiting_approval', recipient: t.recipient, walletChanged: false, txUrl: null, lastError: null, terms: t })),
      totals: { paidMinor: '0', awaitingApprovalMinor: '0', heldMinor: '0', awaitingWalletMinor: '0', inFlightMinor: '0' },
    }), { status: 200 });
  }) as typeof fetch;
}

const deps = (f: typeof fetch, log: string[]) => ({ agentUrl: 'http://agent', token: 't', approverSecret: approver.secretKey, resultsPubkey: key.pubkeyB64, ask: async (q: string) => /\(([^)]+)\) exactly/.exec(q)![1]!, log: (l: string) => log.push(l), f });

describe('approve-event checks what it signs', () => {
  it('signs a row whose terms match the verified statement, one approval per row', async () => {
    const posted: { approval: { terms: GrainhackTerms; approver: string } }[] = [];
    const t = terms();
    const r = await approveEvent(HACK, deps(agent(st, [t, terms({ payout_id: '22222222-2222-4333-8444-555555555555', github_user_id: 303, login: 'carol', amount_minor: '2500000' })], posted), []));
    expect(r).toEqual({ paid: 2, skipped: 0, failed: 0 });
    expect(posted).toHaveLength(2);
    expect(posted[0]!.approval).toMatchObject({ terms: t, approver: approver.publicKey.toBase58() });
  });

  it('refuses to sign anything when the served statement does not verify', async () => {
    const posted: unknown[] = [];
    const forged = signed(resultsKey(Buffer.alloc(32, 12)), statement());
    await expect(approveEvent(HACK, deps(agent(forged, [terms()], posted), []))).rejects.toThrow(/does not verify/);
    expect(posted).toHaveLength(0);
  });

  it('skips rows whose terms disagree with the statement: held, other amount, other login, other statement', async () => {
    const posted: unknown[] = [];
    const log: string[] = [];
    const bad = [
      terms({ payout_id: '00000000-0000-4000-8000-000000000001', github_user_id: 202, login: 'bob', amount_minor: '3500000' }),
      terms({ payout_id: '00000000-0000-4000-8000-000000000002', amount_minor: '4000001' }),
      terms({ payout_id: '00000000-0000-4000-8000-000000000003', login: 'mallory' }),
      terms({ payout_id: '00000000-0000-4000-8000-000000000004', statement_sha256: 'f'.repeat(64) }),
    ];
    expect(await approveEvent(HACK, deps(agent(st, bad, posted), log))).toEqual({ paid: 0, skipped: 4, failed: 0 });
    expect(posted).toHaveLength(0);
    expect(log.filter((l) => l.includes('SKIPPED'))).toHaveLength(4);
  });
});
