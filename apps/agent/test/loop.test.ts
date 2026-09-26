// The whole P2 loop at $0: signed webhooks -> agent -> mock UsePod (x402, via
// the real inference signer) -> fake GitHub -> gate -> human approval -> real
// payout signer (fake rail). Needs TEST_DATABASE_URL.

import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { budgetConfig } from '../../../packages/budget/src/governor.ts';
import { PgReceiptStore, PgSpendLedger } from '../../../packages/db/src/pg.ts';
import { freshDatabase } from '../../../packages/db/src/testing.ts';
import { signApproval } from '../../../packages/gate/src/approval.ts';
import { signDetached } from '../../../packages/gate/src/ed25519.ts';
import { linkMessage } from '../../../packages/gate/src/link.ts';
import { createMockGateway } from '../../../packages/mock-gateway/src/gateway.ts';
import { bountyResponder } from '../../../packages/mock-gateway/src/responder.ts';
import { X402Client } from '../../../packages/x402/src/client.ts';
import { SignerClient } from '../../../services/signer/src/client.ts';
import { Journal } from '../../../services/signer/src/journal.ts';
import { PayoutJournal } from '../../../services/signer/src/payout/journal.ts';
import { PayoutSigner } from '../../../services/signer/src/payout/payout-signer.ts';
import type { PayoutRail } from '../../../services/signer/src/payout/rail.ts';
import { createPayoutServer } from '../../../services/signer/src/payout/server.ts';
import { MockRail } from '../../../services/signer/src/rails.ts';
import { createSignerServer } from '../../../services/signer/src/server.ts';
import { Signer, signerConfig } from '../../../services/signer/src/signer.ts';
import { p2Config } from '../src/config.ts';
import { PayoutSignerClient } from '../src/payout-client.ts';
import { createAgentServer } from '../src/server.ts';
import { BountyService } from '../src/service.ts';
import { PublicApi } from '../src/public.ts';
import { FakeGitHub } from './fake-github.ts';

const dbUrl = process.env.TEST_DATABASE_URL;
const REPO = 'Grainlify/grainlify-agent-sandbox';
const MINT = 'TestUsdcMint11111111111111111111111111111111';
const SECRET = 'webhook-secret-for-tests';
const TOKEN = 'test-token-0123456789abcdefghij';
const PAYOUTS_TOKEN = 'payouts-token-0123456789abcdefghijkl';

class RecordingRail implements PayoutRail {
  sent: { to: string; amountMinor: bigint; mint: string }[] = [];
  address() {
    return 'PayoutFloat1111111111111111111111111111111';
  }
  async prepareTransfer(a: { mint: string; to: string; amountMinor: bigint }) {
    return { signature: `devnet-sig-${this.sent.length + 1}`, broadcast: async () => void this.sent.push({ to: a.to, amountMinor: a.amountMinor, mint: a.mint }) };
  }
}

describe.skipIf(!dbUrl)('bounty loop end to end (mock inference, fake GitHub, fake rail)', () => {
  const servers: Server[] = [];
  const listen = async (s: Server) => {
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  };

  let db: pg.Pool;
  let gh: FakeGitHub;
  let rail: RecordingRail;
  let agentUrl: string;
  let agent: ReturnType<typeof createAgentServer>;
  let service: BountyService;
  let inferenceJournal: Journal;
  const approver = Keypair.generate();
  const contributorWallet = Keypair.generate();
  let delivery = 0;

  async function webhook(event: string, payload: Record<string, unknown>, id = `d-${++delivery}`) {
    const raw = JSON.stringify(payload);
    const r = await fetch(`${agentUrl}/github/webhook`, {
      method: 'POST',
      headers: { 'x-github-event': event, 'x-github-delivery': id, 'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`, 'content-type': 'application/json' },
      body: raw,
    });
    await agent.idle();
    return r;
  }

  beforeAll(async () => {
    db = await freshDatabase(dbUrl!, 'test_agent_loop');
    const gw = createMockGateway({ responder: bountyResponder });
    const gatewayUrl = await listen(gw.server);
    inferenceJournal = new Journal(join(mkdtempSync(join(tmpdir(), 'loop-')), 'inference.sqlite'), 'mock');
    const inferenceSigner = new Signer(signerConfig({ SIGNER_SOL_USD_CEILING_PRICE: '400' }), inferenceJournal, new MockRail(gatewayUrl));
    const inferenceSignerUrl = await listen(createSignerServer(inferenceSigner, TOKEN));

    gh = new FakeGitHub();
    rail = new RecordingRail();
    const payoutJournal = new PayoutJournal(join(mkdtempSync(join(tmpdir(), 'loop-')), 'payout.sqlite'));
    const payoutSigner = new PayoutSigner(
      { network: 'solana-devnet', mints: { USDC: { mint: MINT, decimals: 6 } }, caps: {}, allowedRepos: [REPO], trustedApprovers: [approver.publicKey.toBase58()] },
      payoutJournal,
      rail,
      async (repo, n) => {
        const p = await gh.getPull(repo, n);
        return { merged: p.merged, authorLogin: p.authorLogin, mergedByLogin: p.mergedByLogin };
      },
    );
    const payoutUrl = await listen(createPayoutServer(payoutSigner, payoutJournal, TOKEN));

    const x402 = new X402Client({
      baseUrl: gatewayUrl,
      payer: new SignerClient(inferenceSignerUrl, TOKEN),
      ledger: new PgSpendLedger(db, budgetConfig()),
      receipts: new PgReceiptStore(db),
      sleep: async () => {},
    });
    const cfg = p2Config({ mints: { USDC: { mint: MINT, decimals: 6 } }, trustedApprovers: [approver.publicKey.toBase58()] });
    service = new BountyService({ db, gh, x402, payoutSigner: new PayoutSignerClient(payoutUrl, TOKEN), cfg });
    agent = createAgentServer({ db, service, payoutsApiToken: PAYOUTS_TOKEN, webhookSecret: SECRET, publicApi: new PublicApi(db, cfg), publicOrigins: ['https://grainlify.com'], onError: (e) => console.error(e) });
    agentUrl = await listen(agent);

    gh.addUser('maintainer', 1, '2015-01-01T00:00:00Z');
    gh.addUser('contributor', 2, '2019-06-01T00:00:00Z');
    gh.addUser('newbie', 3, '2026-09-15T00:00:00Z');
    gh.permissions.set(`${REPO.toLowerCase()}:maintainer`, 'admin');
    gh.permissions.set(`${REPO.toLowerCase()}:contributor`, 'read');
    await service.addRepo(REPO, true);
  });

  afterAll(async () => {
    for (const s of servers) s.close();
    await db?.end();
  });

  beforeEach(() => {
    gh.comments.length = 0;
  });

  const pr = (n: number, over: Partial<Parameters<FakeGitHub['pulls']['set']>[1]> = {}) => {
    gh.pulls.set(gh.key(REPO, n), {
      number: n, state: 'open', merged: false, mergedByLogin: null, mergedAt: null, authorId: 2, authorLogin: 'contributor', authorType: 'User',
      headSha: `sha-${n}`, title: `Fix #${n - 100}`, body: `Closes #${n - 100}`, closes: [n - 100], diff: 'diff --git a/x b/x\n+fix', ...over,
    });
  };
  const merge = (n: number, by = 'maintainer') => Object.assign(gh.pulls.get(gh.key(REPO, n))!, { state: 'closed', merged: true, mergedByLogin: by, mergedAt: new Date().toISOString() });
  const linkComment = (login: string, id: number, kp: Keypair, issue = 1) => {
    const issuedAt = new Date().toISOString();
    const body = `/grainlify link ${kp.publicKey.toBase58()} ${signDetached(kp.secretKey, linkMessage({ githubLogin: login, wallet: kp.publicKey.toBase58(), issuedAt }))} ${issuedAt}`;
    return { action: 'created', repository: { full_name: REPO }, issue: { number: issue }, comment: { body, html_url: `https://github.com/${REPO}/issues/${issue}#c`, user: { id, login, type: 'User' } } };
  };

  it('pays one bounty end to end, with the pricing and review receipts linked to it', async () => {
    gh.issues.set(gh.key(REPO, 1), { number: 1, title: 'Typo in README', body: 'The word "recieve" is misspelled.', state: 'open', authorLogin: 'maintainer' });

    // 1. A maintainer picks the issue; one x402 call prices it; the bounty is posted.
    const proposed = await service.proposeBounty(REPO, 1, 'maintainer');
    expect(proposed.amount).toBe(20_000_000n); // mock suggests $20, inside the $5-$50 range
    expect(gh.comments.at(-1)!.body).toMatch(/### Bounty: 20 test USDC/);
    expect(gh.comments.at(-1)!.body).toMatch(/mock gateway \(test run, no real payment\)/);

    // 2. The contributor links a wallet by signed comment.
    expect((await webhook('issue_comment', linkComment('contributor', 2, contributorWallet))).status).toBe(202);
    expect(gh.comments.at(-1)!.body).toMatch(/linked wallet/);

    // 3. A PR that closes the issue gets one advisory review, paid over x402.
    pr(101);
    await webhook('pull_request', { action: 'opened', repository: { full_name: REPO }, pull_request: { number: 101 } });
    expect(gh.reviews).toHaveLength(1);
    expect(gh.reviews[0]!.body).toMatch(/does not approve the PR or trigger payment/);

    // 4. The maintainer merges; the gate passes; the payout waits for a human.
    merge(101);
    await webhook('pull_request', { action: 'closed', repository: { full_name: REPO }, pull_request: { number: 101 } });
    const payout = (await db.query(`SELECT * FROM payouts WHERE bounty_id = $1`, [proposed.bountyId])).rows[0];
    expect(payout.status).toBe('awaiting_approval');
    expect(rail.sent).toHaveLength(0);

    // 5. The approver signs; the payout signer re-checks and pays.
    const view = (await (await fetch(`${agentUrl}/api/payouts/${payout.id}`, { headers: { authorization: `Bearer ${PAYOUTS_TOKEN}` } })).json()) as { terms: Parameters<typeof signApproval>[0] };
    const approval = signApproval(view.terms, approver.secretKey, approver.publicKey.toBase58(), new Date());
    const res = await fetch(`${agentUrl}/api/payouts/${payout.id}/approve`, { method: 'POST', body: JSON.stringify({ approval }) });
    expect(res.status).toBe(200);
    expect(rail.sent).toEqual([{ to: contributorWallet.publicKey.toBase58(), amountMinor: 20_000_000n, mint: MINT }]);

    const bounty = (await db.query(`SELECT status FROM bounties WHERE id = $1`, [proposed.bountyId])).rows[0];
    expect(bounty.status).toBe('paid');
    // Exit criterion: at least two inference receipts linked to the bounty.
    const calls = (await db.query(`SELECT purpose, status FROM inference_calls WHERE links->>'bountyId' = $1 ORDER BY created_at`, [proposed.bountyId])).rows;
    expect(calls).toEqual([{ purpose: 'price', status: 'served' }, { purpose: 'review', status: 'served' }]);
    expect(gh.comments.at(-1)!.body).toMatch(/### Paid/);
  });

  it('ignores a redelivered webhook', async () => {
    const payload = linkComment('contributor', 2, contributorWallet);
    await webhook('issue_comment', payload, 'same-delivery');
    const before = gh.comments.length;
    const again = await webhook('issue_comment', payload, 'same-delivery');
    expect(await again.json()).toEqual({ duplicate: true });
    expect(gh.comments.length).toBe(before);
  });

  it('rejects a webhook with a bad signature', async () => {
    const r = await fetch(`${agentUrl}/github/webhook`, { method: 'POST', headers: { 'x-github-event': 'ping', 'x-github-delivery': 'x', 'x-hub-signature-256': 'sha256=00' }, body: '{}' });
    expect(r.status).toBe(401);
  });

  it('refuses a self-merged PR and pays nothing', async () => {
    gh.issues.set(gh.key(REPO, 2), { number: 2, title: 'Add docs', body: 'Document the API.', state: 'open', authorLogin: 'maintainer' });
    const b = await service.proposeBounty(REPO, 2, 'maintainer');
    pr(102);
    merge(102, 'contributor');
    await webhook('pull_request', { action: 'closed', repository: { full_name: REPO }, pull_request: { number: 102 } });
    const p = (await db.query(`SELECT status, gate_result FROM payouts WHERE bounty_id = $1`, [b.bountyId])).rows[0];
    expect(p.status).toBe('refused');
    expect(p.gate_result.checks.find((c: { name: string }) => c.name === 'not_self_merged').pass).toBe(false);
    expect(gh.comments.at(-1)!.body).toMatch(/Payout refused by the gate/);
  });

  it('refuses a young account without a wallet, and fails closed when GitHub user lookup fails', async () => {
    gh.issues.set(gh.key(REPO, 3), { number: 3, title: 'Bug', body: 'Crash on start.', state: 'open', authorLogin: 'maintainer' });
    const b = await service.proposeBounty(REPO, 3, 'maintainer');
    pr(103, { authorId: 3, authorLogin: 'newbie' });
    merge(103);
    await webhook('pull_request', { action: 'closed', repository: { full_name: REPO }, pull_request: { number: 103 } });
    const p = (await db.query(`SELECT status, gate_result FROM payouts WHERE bounty_id = $1`, [b.bountyId])).rows[0];
    const failedChecks = p.gate_result.checks.filter((c: { pass: boolean }) => !c.pass).map((c: { name: string }) => c.name);
    expect(failedChecks).toEqual(['author_account_age', 'wallet_linked']);

    gh.issues.set(gh.key(REPO, 4), { number: 4, title: 'Bug 2', body: 'Another.', state: 'open', authorLogin: 'maintainer' });
    const b2 = await service.proposeBounty(REPO, 4, 'maintainer');
    pr(104);
    merge(104);
    gh.failUserLookup = true;
    await webhook('pull_request', { action: 'closed', repository: { full_name: REPO }, pull_request: { number: 104 } });
    gh.failUserLookup = false;
    const p2 = (await db.query(`SELECT status, gate_result FROM payouts WHERE bounty_id = $1`, [b2.bountyId])).rows[0];
    expect(p2.status).toBe('refused');
    expect(p2.gate_result.checks.find((c: { name: string }) => c.name === 'author_account_age').detail).toMatch(/failing closed/);
  });

  it('will not link one wallet to two GitHub accounts', async () => {
    gh.addUser('other', 5, '2018-01-01T00:00:00Z');
    await webhook('issue_comment', linkComment('other', 5, contributorWallet));
    expect(gh.comments.at(-1)!.body).toMatch(/already linked to another GitHub account/);
  });

  it('refuses a forged or mismatched approval and pays nothing', async () => {
    gh.issues.set(gh.key(REPO, 5), { number: 5, title: 'Feature', body: 'Add a flag.', state: 'open', authorLogin: 'maintainer' });
    const b = await service.proposeBounty(REPO, 5, 'maintainer');
    pr(105);
    merge(105);
    await webhook('pull_request', { action: 'closed', repository: { full_name: REPO }, pull_request: { number: 105 } });
    const payout = (await db.query(`SELECT id FROM payouts WHERE bounty_id = $1`, [b.bountyId])).rows[0];
    const view = (await (await fetch(`${agentUrl}/api/payouts/${payout.id}`, { headers: { authorization: `Bearer ${PAYOUTS_TOKEN}` } })).json()) as { terms: Parameters<typeof signApproval>[0] };
    const sentBefore = rail.sent.length;

    const attacker = Keypair.generate();
    const forged = signApproval(view.terms, attacker.secretKey, attacker.publicKey.toBase58(), new Date());
    expect((await fetch(`${agentUrl}/api/payouts/${payout.id}/approve`, { method: 'POST', body: JSON.stringify({ approval: forged }) })).status).toBe(409);

    const redirected = signApproval({ ...view.terms, recipient: attacker.publicKey.toBase58() }, approver.secretKey, approver.publicKey.toBase58(), new Date());
    const r = await fetch(`${agentUrl}/api/payouts/${payout.id}/approve`, { method: 'POST', body: JSON.stringify({ approval: redirected }) });
    expect(await r.json()).toMatchObject({ error: expect.stringMatching(/do not match/) });
    expect(rail.sent.length).toBe(sentBefore);
  });

  it('keeps the agent ledger and the inference signer journal in agreement', async () => {
    const t = await new PgSpendLedger(db, budgetConfig()).totals();
    expect(t.lifetimeMicro).toBe(inferenceJournal.committedMicro());
    expect(t.byPhase.P2P3).toBe(t.lifetimeMicro);
  });

  it('publishes the paid bounty, its receipts and an honest status on the public API', async () => {
    const r = await fetch(`${agentUrl}/public/ledger`, { headers: { origin: 'https://grainlify.com' } });
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBe('https://grainlify.com');
    const body = (await r.json()) as { status: { mainnetLive: boolean; statusLine: string }; totals: { bountiesPaidTest: number; bountiesPaidMainnet: number; inferenceSpendMicro: number | null }; events: { kind: string; test: boolean; amount: string | null }[] };
    expect(body.status.mainnetLive).toBe(false);
    expect(body.status.statusLine).toMatch(/Devnet test run so far/);
    expect(body.totals.bountiesPaidTest).toBeGreaterThanOrEqual(1);
    expect(body.totals.bountiesPaidMainnet).toBe(0);
    // Mock inference is never reported as spend.
    expect(body.totals.inferenceSpendMicro).toBeNull();
    const kinds = new Set(body.events.map((e) => e.kind));
    for (const k of ['bounty_posted', 'inference', 'gate_passed', 'gate_refused', 'payout']) expect(kinds.has(k)).toBe(true);
    expect(body.events.every((e) => e.test)).toBe(true);
    expect(body.events.filter((e) => e.kind === 'inference').every((e) => e.amount === null)).toBe(true);
    const payout = body.events.find((e) => e.kind === 'payout')!;
    // Every step of the paid bounty's chain carries its id: posted, priced, reviewed, gated, paid.
    const chain = body.events.filter((e) => (e as { bountyId?: string }).bountyId === (payout as { bountyId?: string }).bountyId).map((e) => e.kind).sort();
    expect(chain).toEqual(['bounty_posted', 'gate_passed', 'inference', 'inference', 'payout']);
    expect(payout.amount).toBe('20.00 test USDC');
  });

  it('serves one bounty for the wallet-link page, and 404s an unknown one', async () => {
    const list = (await (await fetch(`${agentUrl}/public/bounties`)).json()) as { bounties: { id: string; issueTitle: string }[] };
    const one = list.bounties.find((b) => b.issueTitle === 'Typo in README')!;
    const r = await fetch(`${agentUrl}/public/bounties/${one.id}`);
    expect(((await r.json()) as { bounty: { issueUrl: string } }).bounty.issueUrl).toBe(`https://github.com/${REPO}/issues/1`);
    expect((await fetch(`${agentUrl}/public/bounties/00000000-0000-4000-8000-000000000000`)).status).toBe(404);
  });

  it('answers any origin readably, and still refuses writes', async () => {
    // Origin is not an authorisation boundary here: /public/* is public, and
    // the write routes are gated by signatures. What CORS decides is whether a
    // browser may READ a reply, and withholding it hid correct replies from
    // extensions that rewrite Origin.
    const other = await fetch(`${agentUrl}/public/status`, { headers: { origin: 'https://evil.example' } });
    expect(other.headers.get('access-control-allow-origin')).toBe('*');
    const pre = await fetch(`${agentUrl}/public/status`, { method: 'OPTIONS', headers: { origin: 'https://grainlify.com' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS');
    expect((await fetch(`${agentUrl}/public/ledger`, { method: 'POST', body: '{}' })).status).toBe(405);
  });
});
