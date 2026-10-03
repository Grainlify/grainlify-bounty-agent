// GrainHack payouts on the agent, end to end against a real grainhack-signer
// over HTTP (with a fake rail): import, the approval table, one approval per
// row, the ledger, the public view, reports, and reconciling unknowns.

import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase } from '../../../packages/db/src/testing.ts';
import { signGrainhackApproval, type GrainhackTerms } from '../../../packages/gate/src/grainhack-approval.ts';
import type { ResultsStatement, StatementLine } from '../../../packages/gate/src/grainhack-statement.ts';
import { resultsKey, signed, statement } from '../../../packages/gate/test/grainhack-support.ts';
import { GrainhackSigner } from '../../../services/signer/src/grainhack/grainhack-signer.ts';
import { GrainhackJournal } from '../../../services/signer/src/grainhack/journal.ts';
import { createGrainhackServer } from '../../../services/signer/src/grainhack/server.ts';
import type { PayoutRail } from '../../../services/signer/src/payout/rail.ts';
import { explorerTx, p2Config } from '../src/config.ts';
import { approveEvent } from '../src/grainhack/approve-event.ts';
import { BackendStatementSource, deliverReports } from '../src/grainhack/backend.ts';
import { grainhackConfigFromEnv, type GrainhackConfig } from '../src/grainhack/config.ts';
import { parseAmount } from '../src/grainhack/cli.ts';
import { EVENT1_KEEPERHUB_HISTORY, publicStatus, recordEvent1History, recordPoolFunding, type DepositFacts } from '../src/grainhack/ledger.ts';
import { GrainhackService } from '../src/grainhack/service.ts';
import { GrainhackSignerClient } from '../src/grainhack/signer-client.ts';
import { PublicApi } from '../src/public.ts';
import { createAgentServer } from '../src/server.ts';
import { BountyService } from '../src/service.ts';
import { FakeGitHub } from './fake-github.ts';

const dbUrl = process.env.TEST_DATABASE_URL;
const TOKEN = 'payouts-token-0123456789abcdefghijklmn';
const SIGNER_TOKEN = 'grainhack-signer-token-0123456789';
const approver = Keypair.generate();
const approverAddr = approver.publicKey.toBase58();
const key = resultsKey(Buffer.alloc(32, 5));
const MINT = Keypair.generate().publicKey.toBase58();
const FLOAT_KP = Keypair.generate();
const FLOAT = FLOAT_KP.publicKey.toBase58();
const HACK = '0d6e8a3c-7b1f-4c5e-9a2d-4e5f6a7b8c9d';
const COMPUTATION = '9b2f4e6a-1c3d-4e5f-8a7b-6c5d4e3f2a1b';
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

const cfg: GrainhackConfig = { network: 'solana-devnet', mints: { USDC: { mint: MINT, decimals: 6 } }, resultsPubkey: key.pubkeyB64, trustedApprovers: [approverAddr], floatAddress: FLOAT };

class FakeRail implements PayoutRail {
  sent: { to: string; amountMinor: bigint }[] = [];
  failBroadcast = false;
  address() {
    return FLOAT;
  }
  async prepareTransfer(a: { to: string; amountMinor: bigint }) {
    const signature = bs58ish(++n);
    return {
      signature, lastValidBlockHeight: 50,
      broadcast: async () => {
        if (this.failBroadcast) throw new Error('confirmation timed out');
        this.sent.push({ to: a.to, amountMinor: a.amountMinor });
      },
    };
  }
}
const bs58ish = (i: number) => `5ig${String(i).padStart(10, '1')}NaTuRe`;

function lines(...ls: [number, string, number, ('payable' | 'held_kyc')?][]): StatementLine[] {
  return ls.map(([id, login, usd, status]) => ({ github_user_id: id, login, amount_minor: String(Math.round(usd * 1e6)), status: status ?? 'payable' }));
}
function makeStatement(ls: StatementLine[], over: Partial<ResultsStatement> = {}) {
  const pool = ls.reduce((a, l) => a + BigInt(l.amount_minor), 0n);
  return signed(key, statement({ statement_id: uuid(), hackathon_id: HACK, computation_id: COMPUTATION, hackathon_name: 'GrainHack Devnet Event', lines: ls, pool_minor: String(pool), ...over }));
}
const idOf = (st: { statement: string }) => (JSON.parse(st.statement) as ResultsStatement).statement_id;

describe.skipIf(!dbUrl)('GrainHack payouts on the agent', () => {
  let db: pg.Pool;
  let rail: FakeRail;
  let journal: GrainhackJournal;
  let service: GrainhackService;
  let agentUrl: string;
  let signerUrl: string;
  const servers: Server[] = [];
  const wallets = new Map<number, string>();

  async function link(id: number, login: string) {
    const address = Keypair.generate().publicKey.toBase58();
    await db.query('INSERT INTO contributors (github_user_id, login) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, login]);
    await db.query(`UPDATE wallet_links SET revoked_at = now() WHERE github_user_id = $1 AND revoked_at IS NULL`, [id]);
    await db.query(`INSERT INTO wallet_links (github_user_id, address, message, signature, source) VALUES ($1,$2,'m','s','test')`, [id, address]);
    wallets.set(id, address);
    return address;
  }
  const listen = async (s: Server) => {
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  };
  const rows = async () =>
    new Map((await db.query<{ github_user_id: string; status: string; recipient: string | null; statement_id: string; amount_minor: string; id: string; tx_signature: string | null }>(
      `SELECT github_user_id::text, status, recipient, statement_id, amount_minor::text, id, tx_signature FROM grainhack_payouts WHERE hackathon_id = $1`, [HACK])).rows.map((r) => [Number(r.github_user_id), r]));
  const ask = (answers: Record<string, string> | ((q: string) => string)) => async (q: string) => {
    if (typeof answers === 'function') return answers(q);
    const m = /\(([^)]+)\) exactly/.exec(q);
    return answers[m?.[1] ?? ''] ?? 's';
  };
  const run = (answer: (q: string) => string, log: string[] = []) =>
    approveEvent(HACK, { agentUrl, token: TOKEN, approverSecret: approver.secretKey, resultsPubkey: key.pubkeyB64, ask: ask(answer), log: (l) => log.push(l) });

  beforeAll(async () => {
    db = await freshDatabase(dbUrl!, 'test_grainhack');
  });
  beforeEach(async () => {
    // A fresh event for every test: no statements, rows or ledger rows carry over.
    await db.query(`ALTER TABLE grainhack_ledger DISABLE TRIGGER grainhack_ledger_append_only`);
    await db.query(`ALTER TABLE grainhack_statements DISABLE TRIGGER grainhack_statements_immutable`);
    await db.query(`TRUNCATE grainhack_ledger, grainhack_reports, grainhack_payouts, grainhack_statements, audit_log, wallet_links`);
    await db.query(`ALTER TABLE grainhack_ledger ENABLE TRIGGER grainhack_ledger_append_only`);
    await db.query(`ALTER TABLE grainhack_statements ENABLE TRIGGER grainhack_statements_immutable`);
    rail = new FakeRail();
    journal = new GrainhackJournal(join(mkdtempSync(join(tmpdir(), 'ghj-')), 'j.sqlite'));
    const signer = new GrainhackSigner({ network: 'solana-devnet', mints: cfg.mints, caps: {}, trustedApprovers: [approverAddr], resultsPubkey: key.pubkeyB64 }, journal, rail);
    signerUrl = await listen(createGrainhackServer(signer, journal, SIGNER_TOKEN));
    service = new GrainhackService({ db, cfg, signer: new GrainhackSignerClient(signerUrl, SIGNER_TOKEN), orphanAfterMs: 0 });
    const p2 = p2Config({ mints: {}, trustedApprovers: [] });
    const bounty = new BountyService({ db, gh: new FakeGitHub(), x402: {} as never, payoutSigner: {} as never, cfg: p2 });
    agentUrl = await listen(createAgentServer({ db, service: bounty, webhookSecret: 'x'.repeat(32), payoutsApiToken: TOKEN, grainhack: service, publicApi: new PublicApi(db, p2), log: () => {} }));
  });
  afterAll(async () => {
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
    await db.end();
  });

  it('imports a verified statement into one row per winner: held, awaiting a wallet, or awaiting approval with the wallet frozen', async () => {
    const alice = await link(101, 'alice');
    const st = makeStatement(lines([101, 'alice', 4], [202, 'bob', 3.5, 'held_kyc'], [303, 'carol', 2.5]));
    const r = await service.importStatement(st, 'tester');
    expect(r).toMatchObject({ ok: true, alreadyImported: false, created: 3, byStatus: { awaiting_approval: 1, held_kyc: 1, awaiting_wallet: 1 } });
    const m = await rows();
    expect(m.get(101)).toMatchObject({ status: 'awaiting_approval', recipient: alice, amount_minor: '4000000' });
    expect(m.get(202)).toMatchObject({ status: 'held_kyc', recipient: null });
    expect(m.get(303)).toMatchObject({ status: 'awaiting_wallet', recipient: null });
    // carol gets a link-your-wallet report for the backend to pass on.
    expect((await db.query(`SELECT kind, github_user_id::int AS g FROM grainhack_reports`)).rows).toEqual([{ kind: 'grainhack_link_wallet', g: 303 }]);
    // Again: nothing changes.
    expect(await service.importStatement(st, 'tester')).toMatchObject({ ok: true, alreadyImported: true });
    // The frozen wallet stays frozen even if the link changes; the table flags it.
    await link(101, 'alice');
    const view = await service.eventView(HACK);
    expect(view.rows.find((x) => x.githubUserId === 101)).toMatchObject({ recipient: alice, walletChanged: true });
  });

  it('refuses statements that do not verify, are for another network, or have no configured mint', async () => {
    const st = makeStatement(lines([101, 'alice', 4]));
    expect(await service.importStatement({ ...st, signature: resultsKey(Buffer.alloc(32, 6)).sign(st.statement) }, 't')).toMatchObject({ ok: false, error: expect.stringMatching(/signature/) });
    expect(await service.importStatement(makeStatement(lines([101, 'alice', 4]), { network: 'solana-mainnet' }), 't')).toMatchObject({ ok: false, error: expect.stringMatching(/GRAINHACK_NETWORK/) });
    expect(await service.importStatement(makeStatement(lines([101, 'alice', 4]), { currency: 'EURC' }), 't')).toMatchObject({ ok: false, error: expect.stringMatching(/no GrainHack mint/) });
    expect((await db.query(`SELECT count(*)::int AS n FROM grainhack_statements`)).rows[0].n).toBe(0);
  });

  it('a superseding statement updates unpaid rows only, and must supersede the current one', async () => {
    await link(101, 'alice');
    const a = makeStatement(lines([101, 'alice', 4], [202, 'bob', 3.5, 'held_kyc'], [303, 'carol', 2.5]));
    await service.importStatement(a, 't');
    // alice is paid under statement A.
    const log: string[] = [];
    expect(await run(() => '4 USDC', log)).toEqual({ paid: 1, skipped: 0, failed: 0 });
    // Out of order: does not name A.
    const stray = makeStatement(lines([101, 'alice', 4], [202, 'bob', 3.5], [303, 'carol', 2.5]), { supersedes: uuid() });
    expect(await service.importStatement(stray, 't')).toMatchObject({ ok: false, error: expect.stringMatching(/current statement/) });
    expect(await service.importStatement(makeStatement(lines([101, 'alice', 4], [202, 'bob', 3.5], [303, 'carol', 2.5]), { supersedes: idOf(a), computation_id: uuid() }), 't'))
      .toMatchObject({ ok: false, error: expect.stringMatching(/computation/) });
    // bob's KYC clears; B supersedes A.
    await link(202, 'bob');
    const b = makeStatement(lines([101, 'alice', 4], [202, 'bob', 3.5], [303, 'carol', 2.5]), { supersedes: idOf(a) });
    expect(await service.importStatement(b, 't')).toMatchObject({ ok: true, created: 0, updated: 2, kept: 1 });
    const m = await rows();
    expect(m.get(101)).toMatchObject({ status: 'paid', statement_id: idOf(a) });
    expect(m.get(202)).toMatchObject({ status: 'awaiting_approval', statement_id: idOf(b), recipient: wallets.get(202) });
    expect(m.get(303)).toMatchObject({ status: 'awaiting_wallet', statement_id: idOf(b) });
    // A third statement that no longer lists carol removes her unpaid row.
    const c = makeStatement(lines([101, 'alice', 4], [202, 'bob', 6]), { supersedes: idOf(b) });
    expect(await service.importStatement(c, 't')).toMatchObject({ ok: true, removed: 1 });
    expect((await rows()).get(303)).toMatchObject({ status: 'removed' });
    // Statements are never edited.
    await expect(db.query(`UPDATE grainhack_statements SET hackathon_name = 'x' WHERE statement_id = $1`, [idOf(c)])).rejects.toThrow(/immutable/);
  });

  it('approve-event: the table first, then one typed amount and one signature per row; paid rows reach the ledger and the backend outbox', async () => {
    await link(101, 'alice');
    await link(303, 'carol');
    await service.importStatement(makeStatement(lines([101, 'alice', 4], [202, 'bob', 3.5, 'held_kyc'], [303, 'carol', 2.5], [404, 'dave', 1])), 't');
    const log: string[] = [];
    const asked: string[] = [];
    const r = await run((q) => {
      asked.push(q);
      return q.includes('(4 USDC)') ? '4 USDC' : q.includes('(2.5 USDC)') ? '2.50' : 's';
    }, log);
    // carol's typed amount did not match its exact form: skipped, nothing signed.
    expect(r).toEqual({ paid: 1, skipped: 1, failed: 0 });
    expect(asked).toHaveLength(2);
    const tableAt = log.findIndex((l) => l.startsWith('login'));
    const firstAsk = log.findIndex((l) => l.includes('Pay alice'));
    expect(tableAt).toBeGreaterThan(-1);
    expect(tableAt).toBeLessThan(firstAsk);
    expect(log.join('\n')).toMatch(/held .*3\.5 USDC/);
    expect(rail.sent).toEqual([{ to: wallets.get(101), amountMinor: 4_000_000n }]);
    const m = await rows();
    expect(m.get(101)).toMatchObject({ status: 'paid' });
    expect(m.get(303)).toMatchObject({ status: 'awaiting_approval' });
    expect(journal.all().map((j) => [j.github_user_id, j.status])).toEqual([[101, 'confirmed']]);
    const ledger = (await db.query(`SELECT kind, login, amount_minor::text AS a, network, is_history FROM grainhack_ledger`)).rows;
    expect(ledger).toEqual([{ kind: 'grainhack_payout', login: 'alice', a: '4000000', network: 'solana-devnet', is_history: false }]);
    expect((await db.query(`SELECT kind, payload->>'tx_signature' AS tx FROM grainhack_reports WHERE kind = 'grainhack_paid'`)).rows).toEqual([{ kind: 'grainhack_paid', tx: m.get(101)!.tx_signature }]);
    await expect(db.query(`UPDATE grainhack_ledger SET amount_minor = 1`)).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM grainhack_ledger`)).rejects.toThrow(/append-only/);
  });

  it('the agent forwards only an approval that matches its records exactly', async () => {
    await link(101, 'alice');
    await service.importStatement(makeStatement(lines([101, 'alice', 4], [202, 'bob', 6])), 't');
    const v = await service.eventView(HACK);
    const row = v.rows.find((x) => x.githubUserId === 101)!;
    const terms = row.terms!;
    const post = (id: string, approval: unknown, auth = TOKEN) =>
      fetch(`${agentUrl}/api/grainhack/payouts/${id}/approve`, { method: 'POST', headers: { authorization: `Bearer ${auth}` }, body: JSON.stringify({ approval }) });
    const sign = (t: GrainhackTerms, kp = approver) => signGrainhackApproval(t, kp.secretKey, kp.publicKey.toBase58(), new Date());
    expect((await post(row.payoutId, sign(terms), 'wrong-token-wrong-token-wrong-tok')).status).toBe(401);
    expect((await fetch(`${agentUrl}/api/grainhack/events/${HACK}`)).status).toBe(401);
    expect(await (await post(row.payoutId, sign({ ...terms, amount_minor: '4000001' }))).json()).toMatchObject({ error: 'approval terms do not match this payout' });
    expect(await (await post(row.payoutId, sign({ ...terms, recipient: Keypair.generate().publicKey.toBase58() }))).json()).toMatchObject({ error: 'approval terms do not match this payout' });
    const stranger = Keypair.generate();
    expect(await (await post(row.payoutId, sign(terms, stranger))).json()).toMatchObject({ error: expect.stringMatching(/not trusted/) });
    // A wallet relinked after the row was frozen: refused until a person refreezes it.
    await link(101, 'alice');
    expect(await (await post(row.payoutId, sign(terms))).json()).toMatchObject({ error: expect.stringMatching(/refreeze/) });
    await expect(service.refreeze(row.payoutId, 'op', '')).rejects.toThrow(/reason/);
    expect(await service.refreeze(row.payoutId, 'op', 'winner moved wallets')).toMatchObject({ to: wallets.get(101) });
    const fresh = (await service.eventView(HACK)).rows.find((x) => x.githubUserId === 101)!.terms!;
    expect((await post(row.payoutId, sign(terms))).status).toBe(409); // the old terms no longer match
    const ok = await post(row.payoutId, sign(fresh));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ txUrl: expect.stringContaining('cluster=devnet') });
    // Once paid it is not awaiting approval any more.
    expect(await (await post(row.payoutId, sign(fresh))).json()).toMatchObject({ error: 'payout is paid, not awaiting approval' });
    expect(rail.sent).toHaveLength(1);
  });

  it('a signer refusal puts the row back for a new approval; an unknown outcome waits for a person and then reconciles', async () => {
    await link(303, 'carol');
    await link(606, 'frank');
    await service.importStatement(makeStatement(lines([303, 'carol', 2.5], [505, 'erin', 400, 'held_kyc'], [606, 'frank', 600])), 't');
    const v = await service.eventView(HACK);
    const carol = v.rows.find((x) => x.githubUserId === 303)!;
    const frank = v.rows.find((x) => x.githubUserId === 606)!;
    // The agent does not apply the signer's caps; the signer refuses, journals
    // nothing, and the row goes back to awaiting approval with the reason.
    expect(await service.approve(frank.payoutId, signGrainhackApproval(frank.terms!, approver.secretKey, approverAddr, new Date()))).toMatchObject({ ok: false, status: 403, rowStatus: 'awaiting_approval' });
    expect((await db.query(`SELECT status, last_error FROM grainhack_payouts WHERE id = $1`, [frank.payoutId])).rows[0]).toMatchObject({ status: 'awaiting_approval', last_error: expect.stringMatching(/per-payout cap/) });
    expect(journal.all()).toHaveLength(0);
    // The broadcast's outcome is unknown: the row says so and nothing retries it.
    rail.failBroadcast = true;
    const r = await service.approve(carol.payoutId, signGrainhackApproval(carol.terms!, approver.secretKey, approverAddr, new Date()));
    expect(r).toMatchObject({ ok: false, status: 502, rowStatus: 'unknown' });
    expect((await rows()).get(303)!.status).toBe('unknown');
    expect(await service.reconcile(HACK)).toMatchObject({ unknown: 1 });
    expect((await rows()).get(303)!.status).toBe('unknown');
    // A person resolves it on the signer, from the chain; reconcile then records the payment.
    journal.resolve(carol.payoutId, 'confirmed', 'op', 'found on explorer', { slot: 1 });
    expect(await service.reconcile(HACK)).toMatchObject({ paid: 1 });
    expect((await rows()).get(303)).toMatchObject({ status: 'paid', tx_signature: journal.byPayoutId(carol.payoutId)!.tx_signature });
    expect((await db.query(`SELECT count(*)::int AS n FROM grainhack_ledger WHERE payout_id = $1`, [carol.payoutId])).rows[0].n).toBe(1);
  });

  it('reconcile marks a signer-resolved failed_unsent as failed, and releases an approval the signer never recorded', async () => {
    await link(101, 'alice');
    await link(303, 'carol');
    await service.importStatement(makeStatement(lines([101, 'alice', 4], [303, 'carol', 2.5], [505, 'erin', 400, 'held_kyc'])), 't');
    const v = await service.eventView(HACK);
    const alice = v.rows.find((x) => x.githubUserId === 101)!;
    const carol = v.rows.find((x) => x.githubUserId === 303)!;
    rail.failBroadcast = true;
    await service.approve(alice.payoutId, signGrainhackApproval(alice.terms!, approver.secretKey, approverAddr, new Date()));
    journal.resolve(alice.payoutId, 'failed_unsent', 'op', 'blockhash expired', {});
    // carol: the agent claimed the row, but the request never reached the signer.
    await db.query(`UPDATE grainhack_payouts SET status = 'submitted' WHERE id = $1`, [carol.payoutId]);
    expect(await service.reconcile(HACK)).toMatchObject({ failed: 1, released: 1 });
    const m = await rows();
    expect(m.get(101)!.status).toBe('failed');
    expect(m.get(303)!.status).toBe('awaiting_approval');
  });

  it('the public view shows login, amount, status and transaction, and never a KYC status', async () => {
    await link(101, 'alice');
    await link(303, 'carol');
    await service.importStatement(makeStatement(lines([101, 'alice', 4], [202, 'bob', 3.5, 'held_kyc'], [303, 'carol', 2.5], [404, 'dave', 1])), 't');
    await run((q) => (q.includes('(4 USDC)') ? '4 USDC' : 's'));
    const res = await fetch(`${agentUrl}/public/grainhack/${HACK}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toMatch(/kyc|held|awaiting|wallet|recipient|github_user_id|githubUserId/i);
    const body = JSON.parse(text);
    const by = Object.fromEntries(body.winners.map((w: { login: string }) => [w.login, w]));
    expect(by.alice).toMatchObject({ status: 'paid', amount: '4.00 test USDC', test: true, txUrl: expect.stringContaining('?cluster=devnet') });
    for (const login of ['bob', 'carol', 'dave']) expect(by[login]).toMatchObject({ status: 'waiting', txSignature: null, txUrl: null });
    expect(body).toMatchObject({ hackathonName: 'GrainHack Devnet Event', network: 'solana-devnet', test: true, totals: { paidMinor: '4000000', waitingMinor: '7000000', paidCount: 1, waitingCount: 3 } });
    expect((await fetch(`${agentUrl}/public/grainhack/${uuid()}`)).status).toBe(404);
    expect(['held_kyc', 'awaiting_wallet', 'awaiting_approval', 'failed'].map(publicStatus)).toEqual(['waiting', 'waiting', 'waiting', 'waiting']);
  });

  it('records a pool deposit only when the chain shows the configured mint reaching the float\'s token account, for the stated amount', async () => {
    const floatAta = getAssociatedTokenAddressSync(new PublicKey(MINT), FLOAT_KP.publicKey, false, TOKEN_PROGRAM_ID).toBase58();
    const facts = (over: Partial<DepositFacts['changes'][number]> = {}, err: unknown = null): DepositFacts => ({
      err, blockTime: 1_791_000_000, changes: [{ account: floatAta, mint: MINT, owner: FLOAT, pre: 1_000_000n, post: 101_000_000n, ...over }],
    });
    const fund = (f: DepositFacts | null, amount = 100_000_000n, tx = 'DepositTx1') =>
      recordPoolFunding({ db, cfg, chain: { deposit: async () => f } }, { hackathonId: HACK, txSignature: tx, expectedAmountMinor: amount, actor: 'op' });
    expect(await fund(null)).toMatchObject({ ok: false, error: expect.stringMatching(/not found/) });
    expect(await fund(facts({}, { InstructionError: [0, 'x'] }))).toMatchObject({ ok: false, error: expect.stringMatching(/failed on chain/) });
    expect(await fund(facts({ mint: Keypair.generate().publicKey.toBase58() }))).toMatchObject({ ok: false, error: expect.stringMatching(/did not touch/) });
    expect(await fund(facts({ account: Keypair.generate().publicKey.toBase58() }))).toMatchObject({ ok: false, error: expect.stringMatching(/did not touch/) });
    expect(await fund(facts(), 99_000_000n)).toMatchObject({ ok: false, error: expect.stringMatching(/not the 99000000/) });
    expect(await fund(facts({ post: 1_000_000n }))).toMatchObject({ ok: false, error: expect.stringMatching(/did not credit/) });
    expect(await fund(facts())).toMatchObject({ ok: true, recorded: true, amountMinor: '100000000', at: new Date(1_791_000_000_000).toISOString() });
    expect(await fund(facts())).toMatchObject({ ok: true, recorded: false });
    const res = await (await fetch(`${agentUrl}/public/grainhack/${HACK}`)).json();
    expect(res.funding).toEqual([expect.objectContaining({ amount: '100.00 test USDC', txUrl: 'https://solscan.io/tx/DepositTx1?cluster=devnet' })]);
    expect(parseAmount('100', 6)).toBe(100_000_000n);
    expect(parseAmount('2.5', 6)).toBe(2_500_000n);
    expect(() => parseAmount('1e3', 6)).toThrow();
    expect(() => parseAmount('0.0000001', 6)).toThrow(/decimals/);
  });

  it('event 1\'s KeeperHub legs appear once, as testnet history on Base Sepolia, on the ledger and the event page', async () => {
    expect(await recordEvent1History(db, { hackathonId: HACK, hackathonName: 'GrainHack #1', actor: 'op' })).toBe(2);
    expect(await recordEvent1History(db, { hackathonId: HACK, actor: 'op' })).toBe(0);
    const ledger = await (await fetch(`${agentUrl}/public/ledger`)).json();
    const gh = ledger.events.filter((e: { kind: string }) => e.kind.startsWith('grainhack_'));
    expect(gh).toHaveLength(2);
    for (const e of gh) expect(e).toMatchObject({ kind: 'grainhack_payout', hackathonId: HACK, test: true, history: true, amount: '4.00 test USDC', proof: { url: expect.stringMatching(/^https:\/\/sepolia\.basescan\.org\/tx\/0x/) } });
    expect(ledger.totals).toMatchObject({ grainhackPaidTest: 2, grainhackPaidMainnet: 0 });
    const page = await (await fetch(`${agentUrl}/public/grainhack/${HACK}`)).json();
    expect(page.history.map((h: { login: string; paidAt: string; txSignature: string }) => [h.login, h.paidAt, h.txSignature])).toEqual(
      EVENT1_KEEPERHUB_HISTORY.map((h) => [h.login, new Date(h.at).toISOString(), h.tx]),
    );
    expect(page.history[0]).toMatchObject({ network: 'base-sepolia', status: 'paid', history: true, test: true });
    expect(page.winners).toEqual([]);
    expect(explorerTx('base-sepolia', '0xabc')).toBe('https://sepolia.basescan.org/tx/0xabc');
  });

  it('delivers reports to a configurable backend path with a bearer token, once each', async () => {
    await service.importStatement(makeStatement(lines([303, 'carol', 2.5])), 't');
    const calls: { url: string; auth: string | null; body: { kind: string; github_user_id: number } }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, auth: new Headers(init.headers).get('authorization'), body: JSON.parse(String(init.body)) });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    expect(await deliverReports({ db, backendUrl: 'https://api.example/', path: '/v2/grainhack/events', token: 'report-token', f })).toBe(1);
    expect(await deliverReports({ db, backendUrl: 'https://api.example/', path: '/v2/grainhack/events', token: 'report-token', f })).toBe(0);
    expect(calls).toEqual([{ url: 'https://api.example/v2/grainhack/events', auth: 'Bearer report-token', body: expect.objectContaining({ kind: 'grainhack_link_wallet', github_user_id: 303 }) }]);
    expect(await deliverReports({ db, backendUrl: undefined, token: 'x', f })).toBe(0);
  });
});

describe('GrainHack settings and the backend statement client', () => {
  const base = { GRAINHACK_MINTS: JSON.stringify({ USDC: { mint: MINT, decimals: 6 } }), GRAINHACK_RESULTS_PUBKEY: key.pubkeyB64, APPROVER_PUBKEYS: approverAddr };
  it('is off without GRAINHACK_NETWORK, and independent of the bounty PAYOUT_NETWORK', () => {
    expect(grainhackConfigFromEnv({ ...base, PAYOUT_NETWORK: 'solana-mainnet' })).toBeNull();
    expect(grainhackConfigFromEnv({ ...base, PAYOUT_NETWORK: 'solana-mainnet', GATE_ALLOW_MAINNET: 'yes', GRAINHACK_NETWORK: 'solana-devnet' })).toMatchObject({ network: 'solana-devnet' });
    expect(() => grainhackConfigFromEnv({ ...base, GRAINHACK_NETWORK: 'solana-mainnet', PAYOUT_ALLOW_MAINNET: 'yes' })).toThrow(/GRAINHACK_ALLOW_MAINNET/);
    expect(grainhackConfigFromEnv({ ...base, GRAINHACK_NETWORK: 'solana-mainnet', GRAINHACK_ALLOW_MAINNET: 'yes' })).toMatchObject({ network: 'solana-mainnet' });
    expect(() => grainhackConfigFromEnv({ ...base, GRAINHACK_NETWORK: 'base-sepolia' })).toThrow(/not one of/);
  });
  it('fetches a statement with the bearer token and refuses a malformed answer', async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const ok = (async (url: string, init: RequestInit) => {
      seen.push({ url, auth: new Headers(init.headers).get('authorization') });
      return new Response(JSON.stringify({ statement: '{}', signature: 'sig' }), { status: 200 });
    }) as typeof fetch;
    const id = '6f9a1c52-6a4e-4f4b-9b8e-1d2c3b4a5f60';
    expect(await new BackendStatementSource('https://api.example/', 'tok', ok).fetch(id)).toEqual({ statement: '{}', signature: 'sig' });
    expect(seen).toEqual([{ url: `https://api.example/grainhack/results-statements/${id}`, auth: 'Bearer tok' }]);
    const bad = (async () => new Response(JSON.stringify({ statement: {} }), { status: 200 })) as unknown as typeof fetch;
    await expect(new BackendStatementSource('https://api.example', 'tok', bad).fetch(id)).rejects.toThrow(/not \{ statement/);
    await expect(new BackendStatementSource('https://api.example', 'tok', ok).fetch('../admin')).rejects.toThrow(/uuid/);
  });
});
