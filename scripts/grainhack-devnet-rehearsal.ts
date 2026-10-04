// GrainHack payout rehearsal on Solana devnet, end to end, with throwaway keys.
//
// Runs the real agent GrainHack routes (in-process, the same createAgentServer
// code the hosted agent uses) against a real grainhack-signer process that pays
// test USDC on devnet, and walks the approved design: import a signed results
// statement, approve one row at a time with approve-event, pay, refuse what must
// be refused, hold a KYC winner and pay them after a superseding statement, pay
// a winner who links a wallet late, and hit the per-payout and daily caps.
//
// Nothing here touches production: a local database, a devnet float, a test
// results key and a test approver key that exist only in REHEARSAL_DIR.
//
//   REHEARSAL_DIR=... DATABASE_URL=postgres://... GRAINHACK_SIGNER_URL=http://127.0.0.1:8789 \
//   GRAINHACK_SIGNER_TOKEN=... npx tsx scripts/grainhack-devnet-rehearsal.ts
//
// REHEARSAL_DIR/keys holds float.json, approver.json, results-seed.b64 and
// w-<name>.json wallets (Solana CLI keypair files). The signer must be started
// with the same float, approver pubkey and results pubkey.

import { createPrivateKey, randomUUID, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import pg from 'pg';
import { migrate } from '../packages/db/src/pg.ts';
import { signGrainhackApproval, type GrainhackTerms } from '../packages/gate/src/grainhack-approval.ts';
import { canonicalJson, RESULTS_DOMAIN, statementSha256, type ResultsStatement, type StatementLine } from '../packages/gate/src/grainhack-statement.ts';
import { p2Config } from '../apps/agent/src/config.ts';
import { approveEvent } from '../apps/agent/src/grainhack/approve-event.ts';
import type { GrainhackConfig } from '../apps/agent/src/grainhack/config.ts';
import { GrainhackService } from '../apps/agent/src/grainhack/service.ts';
import { GrainhackSignerClient } from '../apps/agent/src/grainhack/signer-client.ts';
import { PublicApi } from '../apps/agent/src/public.ts';
import { createAgentServer } from '../apps/agent/src/server.ts';
import { BountyService } from '../apps/agent/src/service.ts';

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};
const DIR = need('REHEARSAL_DIR');
const SIGNER_URL = need('GRAINHACK_SIGNER_URL');
const SIGNER_TOKEN = need('GRAINHACK_SIGNER_TOKEN');
const RPC = process.env.GRAINHACK_RPC_URL ?? 'https://api.devnet.solana.com';
const MINT = process.env.GRAINHACK_MINT ?? 'DQNUbSmmakWcVKcdRXraNSgWdabZs5dMJyTVPFv21fNL';
const TOKEN = 'rehearsal-payouts-token-0123456789abcdef';

const kp = (name: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(DIR, 'keys', `${name}.json`), 'utf8')) as number[]));
const float = kp('float');
const approver = kp('approver');
const seed = Buffer.from(readFileSync(join(DIR, 'keys', 'results-seed.b64'), 'utf8').trim(), 'base64');
const PKCS8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
const resultsPriv = createPrivateKey({ key: PKCS8, format: 'der', type: 'pkcs8' });
const resultsPub = Buffer.from((resultsPriv.export({ format: 'jwk' }) as { x: string }).x, 'base64url').toString('base64');
const signStatement = (s: ResultsStatement) => {
  const json = canonicalJson(s);
  return { statement: json, signature: sign(null, Buffer.from(RESULTS_DOMAIN + json, 'utf8'), resultsPriv).toString('base64') };
};

const cfg: GrainhackConfig = { network: 'solana-devnet', mints: { USDC: { mint: MINT, decimals: 6 } }, resultsPubkey: resultsPub, trustedApprovers: [approver.publicKey.toBase58()], floatAddress: float.publicKey.toBase58() };
const conn = new Connection(RPC, 'confirmed');
const usdc = (minor: string | bigint) => (Number(minor) / 1e6).toFixed(2);
const line = (id: number, login: string, usd: number, status: StatementLine['status'] = 'payable'): StatementLine => ({ github_user_id: id, login, amount_minor: String(Math.round(usd * 1e6)), status });
const results: { check: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  results.push({ check: name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

function statement(hackathonId: string, name: string, computation: string, lines: StatementLine[], supersedes: string | null = null): ResultsStatement {
  return {
    v: 1, kind: 'grainhack_results', statement_id: randomUUID(), supersedes, hackathon_id: hackathonId, hackathon_name: name,
    pool: 'contributor', computation_id: computation, currency: 'USDC', network: 'solana-devnet',
    pool_minor: String(lines.reduce((a, l) => a + BigInt(l.amount_minor), 0n)),
    lines: [...lines].sort((a, b) => a.github_user_id - b.github_user_id), issued_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  };
}

async function tokenBalance(owner: string): Promise<string> {
  const ata = getAssociatedTokenAddressSync(new PublicKey(MINT), new PublicKey(owner));
  try {
    return (await conn.getTokenAccountBalance(ata)).value.amount;
  } catch {
    return '0';
  }
}

async function payDirect(body: unknown) {
  const r = await fetch(`${SIGNER_URL}/v1/grainhack/pay`, { method: 'POST', headers: { authorization: `Bearer ${SIGNER_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

async function main() {
  const db = new pg.Pool({ connectionString: need('DATABASE_URL') });
  await migrate(db);
  const servers: Server[] = [];
  const listen = async (s: Server) => {
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  };
  const signer = new GrainhackSignerClient(SIGNER_URL, SIGNER_TOKEN);
  const service = new GrainhackService({ db, cfg, signer, orphanAfterMs: 0 });
  const p2 = p2Config({ mints: {}, trustedApprovers: [] });
  const bounty = new BountyService({ db, gh: {} as never, x402: {} as never, payoutSigner: {} as never, cfg: p2 });
  const agentUrl = await listen(createAgentServer({ db, service: bounty, webhookSecret: 'x'.repeat(32), payoutsApiToken: TOKEN, grainhack: service, publicApi: new PublicApi(db, p2), log: () => {} }));

  // The signer must agree with this agent: same network, mint and float.
  const sc = (await (await fetch(`${SIGNER_URL}/v1/config`, { headers: { authorization: `Bearer ${SIGNER_TOKEN}` } })).json()) as { network: string; mints: Record<string, { mint: string }>; address: string; caps: unknown };
  check('signer config matches the agent (network, mint, float)', sc.network === cfg.network && sc.mints.USDC?.mint === MINT && sc.address === cfg.floatAddress, `${sc.network}, float ${sc.address}, caps ${JSON.stringify(sc.caps)}`);

  const wallets: Record<string, string> = {};
  async function link(id: number, login: string, wallet: string) {
    wallets[login] = wallet;
    await db.query('INSERT INTO contributors (github_user_id, login) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, login]);
    await db.query('UPDATE wallet_links SET revoked_at = now() WHERE github_user_id = $1 AND revoked_at IS NULL', [id]);
    await db.query(`INSERT INTO wallet_links (github_user_id, address, message, signature, source) VALUES ($1,$2,'rehearsal','rehearsal','rehearsal')`, [id, wallet]);
  }
  const W = (n: string) => kp(`w-${n}`).publicKey.toBase58();
  const ask = async (q: string) => /\(([^)]+)\) exactly/.exec(q)?.[1] ?? 's'; // the operator types the amount shown
  const approve = async (hid: string) => {
    const log: string[] = [];
    const r = await approveEvent(hid, { agentUrl, token: TOKEN, approverSecret: approver.secretKey, resultsPubkey: resultsPub, ask, log: (l) => log.push(l) });
    for (const l of log) console.log(`      | ${l}`);
    return r;
  };
  const view = async (hid: string) => service.eventView(hid);
  const rowOf = async (hid: string, id: number) => (await view(hid)).rows.find((r) => r.githubUserId === id);

  // ---- Event A: two payable winners with wallets, one held for KYC, one with no wallet yet.
  const A = randomUUID();
  const compA = randomUUID();
  await link(101, 'alice', W('alice'));
  await link(202, 'bob', W('bob'));
  await link(303, 'carol', W('carol'));
  const stA = signStatement(statement(A, 'GrainHack Devnet Rehearsal A', compA, [line(101, 'alice', 4), line(202, 'bob', 3.5, 'held_kyc'), line(303, 'carol', 2.5), line(404, 'dave', 1)]));
  const impA = await service.importStatement(stA, 'rehearsal');
  check('import: statement A verifies and creates one row per winner', impA.ok && !impA.alreadyImported && impA.created === 4, JSON.stringify(impA.ok ? impA.byStatus : impA));
  const statuses = Object.fromEntries((await view(A)).rows.map((r) => [r.login, r.status]));
  check('import: alice+carol awaiting_approval, bob held_kyc, dave awaiting_wallet', statuses.alice === 'awaiting_approval' && statuses.carol === 'awaiting_approval' && statuses.bob === 'held_kyc' && statuses.dave === 'awaiting_wallet', JSON.stringify(statuses));
  check('import: the same statement again changes nothing', (await service.importStatement(stA, 'rehearsal')).ok);
  const tampered = { ...stA, statement: stA.statement.replace('"4000000"', '"9000000"') };
  check('import: a tampered statement is refused', !(await service.importStatement(tampered, 'rehearsal')).ok);

  const before = { alice: await tokenBalance(W('alice')), carol: await tokenBalance(W('carol')) };
  const r1 = await approve(A);
  check('approve-event A: pays exactly the two approvable rows on devnet', r1.paid === 2 && r1.failed === 0, JSON.stringify(r1));
  const after = { alice: await tokenBalance(W('alice')), carol: await tokenBalance(W('carol')) };
  check('chain: alice received 4.00 test USDC', BigInt(after.alice) - BigInt(before.alice) === 4_000_000n, `${usdc(before.alice)} -> ${usdc(after.alice)}`);
  check('chain: carol received 2.50 test USDC', BigInt(after.carol) - BigInt(before.carol) === 2_500_000n, `${usdc(before.carol)} -> ${usdc(after.carol)}`);
  const aliceRow = await rowOf(A, 101);
  check('agent row: alice paid with a devnet tx link', aliceRow?.status === 'paid' && !!aliceRow.txUrl, aliceRow?.txUrl ?? 'none');

  // ---- Refusals, straight at the signer (the agent never forwards these, the signer must refuse them anyway).
  const termsFor = (st: { statement: string }, payoutId: string, id: number, login: string, recipient: string, amountMinor: string, hid = A): GrainhackTerms => ({
    payout_id: payoutId, statement_id: (JSON.parse(st.statement) as ResultsStatement).statement_id, statement_sha256: statementSha256(st.statement), hackathon_id: hid,
    pool: 'contributor', github_user_id: id, login, recipient, amount_minor: amountMinor, currency: 'USDC', mint: MINT, network: 'solana-devnet',
  });
  const approvalOf = (t: GrainhackTerms, k = approver) => signGrainhackApproval(t, k.secretKey, k.publicKey.toBase58(), new Date());
  const req = (t: GrainhackTerms, st = stA, k = approver) => ({ approval: approvalOf(t, k), statement: st.statement, statement_signature: st.signature });
  const aliceTerms = termsFor(stA, aliceRow!.payoutId, 101, 'alice', W('alice'), '4000000');
  let x = await payDirect(req(aliceTerms));
  check('refuse: paying alice a second time (fresh approval, same winner)', x.status >= 400, `${x.status} ${String(x.body.error ?? x.body.reason ?? JSON.stringify(x.body))}`);
  x = await payDirect(req(termsFor(stA, randomUUID(), 404, 'dave', W('dave'), '2000000')));
  check('refuse: an amount that is not the statement line (dave 2.00 vs 1.00)', x.status >= 400, `${x.status} ${String(x.body.error ?? JSON.stringify(x.body))}`);
  x = await payDirect(req(termsFor(stA, randomUUID(), 404, 'dave', W('dave'), '1000000'), stA, Keypair.generate()));
  check('refuse: an approval signed by a key that is not an approver', x.status >= 400, `${x.status} ${String(x.body.error ?? JSON.stringify(x.body))}`);
  x = await payDirect(req(termsFor(stA, randomUUID(), 202, 'bob', W('bob'), '3500000')));
  check('refuse: a held_kyc line', x.status >= 400, `${x.status} ${String(x.body.error ?? JSON.stringify(x.body))}`);
  x = await payDirect(req(termsFor(stA, randomUUID(), 404, 'dave', cfg.floatAddress!, '1000000')));
  check('refuse: paying the float itself', x.status >= 400, `${x.status} ${String(x.body.error ?? JSON.stringify(x.body))}`);
  x = await payDirect({ ...req(termsFor(stA, randomUUID(), 404, 'dave', W('dave'), '1000000')), statement_signature: tampered.signature.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) });
  check('refuse: a statement signature that does not verify', x.status >= 400, `${x.status} ${String(x.body.error ?? JSON.stringify(x.body))}`);

  // ---- KYC clears for bob: a superseding statement, same computation, bob payable. Paid rows stay paid.
  const stA2 = signStatement({ ...statement(A, 'GrainHack Devnet Rehearsal A', compA, [line(101, 'alice', 4), line(202, 'bob', 3.5), line(303, 'carol', 2.5), line(404, 'dave', 1)], (JSON.parse(stA.statement) as ResultsStatement).statement_id) });
  const impA2 = await service.importStatement(stA2, 'rehearsal');
  check('supersede: statement A2 (bob payable) imports, paid rows kept', impA2.ok && impA2.kept === 2, JSON.stringify(impA2.ok ? { updated: impA2.updated, kept: impA2.kept, byStatus: impA2.byStatus } : impA2));
  const bobBefore = await tokenBalance(W('bob'));
  const r2 = await approve(A);
  check('approve-event A again: pays bob only', r2.paid === 1 && r2.failed === 0, JSON.stringify(r2));
  check('chain: bob received 3.50 test USDC', BigInt(await tokenBalance(W('bob'))) - BigInt(bobBefore) === 3_500_000n);

  // ---- dave links a wallet late; the refresh picks it up; paid on the next run.
  await link(404, 'dave', W('dave'));
  await fetch(`${agentUrl}/api/grainhack/events/${A}/refresh`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } });
  check('late wallet: dave moves to awaiting_approval after the refresh', (await rowOf(A, 404))?.status === 'awaiting_approval', (await rowOf(A, 404))?.status);
  const r3 = await approve(A);
  check('approve-event A third time: pays dave only', r3.paid === 1, JSON.stringify(r3));
  check('chain: dave received 1.00 test USDC', (await tokenBalance(W('dave'))) === '1000000');
  check('alice still received exactly once (4.00 total)', (await tokenBalance(W('alice'))) === '4000000');

  // ---- Caps. Per payout: $500. Per UTC day: $2,500 (11.00 already paid today on this float's journal).
  const C = randomUUID();
  const stC = signStatement(statement(C, 'GrainHack Devnet Rehearsal C (caps)', randomUUID(), [line(707, 'gina', 600)]));
  x = await payDirect(req(termsFor(stC, randomUUID(), 707, 'gina', Keypair.generate().publicKey.toBase58(), '600000000', C), stC));
  check('cap: a 600 USDC payout is refused (limit 500)', x.status >= 400, `${x.status} ${String(x.body.error ?? JSON.stringify(x.body))}`);
  const B = randomUUID();
  const fives: [number, string][] = [[505, 'erin'], [606, 'frank'], [808, 'hank'], [909, 'ivy'], [1010, 'jo']];
  for (const [id, login] of fives) await link(id, login, ['erin', 'frank'].includes(login) ? W(login) : Keypair.generate().publicKey.toBase58());
  const stB = signStatement(statement(B, 'GrainHack Devnet Rehearsal B (daily cap)', randomUUID(), fives.map(([id, login]) => line(id, login, 500))));
  check('daily cap: statement B (5 x 500) imports', (await service.importStatement(stB, 'rehearsal')).ok);
  const r4 = await approve(B);
  const bRows = (await view(B)).rows;
  const paidB = bRows.filter((r) => r.status === 'paid').length;
  check('daily cap: 4 x 500 paid, the 5th refused (11 + 2,000 + 500 > 2,500)', paidB === 4 && r4.paid === 4, `${JSON.stringify(r4)}; statuses ${bRows.map((r) => `${r.login}=${r.status}${r.lastError ? `(${r.lastError})` : ''}`).join(', ')}`);

  // ---- What the public sees and what the ledger records.
  const pub = (await (await fetch(`${agentUrl}/public/grainhack/${A}`)).json()) as { rows?: { login: string; status: string; txUrl?: string | null }[] };
  check('public view A: every winner paid with a tx link, no KYC wording', JSON.stringify(pub).includes('paid') && !/kyc/i.test(JSON.stringify(pub)), JSON.stringify(pub).slice(0, 300));
  const ledger = (await db.query<{ kind: string; n: number }>(`SELECT kind, count(*)::int AS n FROM grainhack_ledger GROUP BY kind ORDER BY kind`)).rows;
  check('ledger: one grainhack_payout row per payment (4 in A + 4 in B)', ledger.find((l) => l.kind === 'grainhack_payout')?.n === 8, JSON.stringify(ledger));
  const journal = (await (await fetch(`${SIGNER_URL}/v1/grainhack/payouts`, { headers: { authorization: `Bearer ${SIGNER_TOKEN}` } })).json()) as { payouts: { status: string }[] };
  const js = journal.payouts.reduce<Record<string, number>>((a, p) => ({ ...a, [p.status]: (a[p.status] ?? 0) + 1 }), {});
  check('signer journal: 8 confirmed, nothing unknown', js.confirmed === 8 && !js.unknown, JSON.stringify(js));
  console.log(`float after: ${usdc(await tokenBalance(cfg.floatAddress!))} test USDC; events A=${A} B=${B}`);

  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  await db.end();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
