import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { envelopeMessage, signApproval, type PayoutTerms } from '../../../packages/gate/src/approval.ts';
import { signDetached } from '../../../packages/gate/src/ed25519.ts';
import { GRAINHACK_APPROVAL_DOMAIN, signGrainhackApproval, type GrainhackApproval, type GrainhackTerms } from '../../../packages/gate/src/grainhack-approval.ts';
import { statementSha256, type ResultsStatement, type StatementLine } from '../../../packages/gate/src/grainhack-statement.ts';
import { resultsKey, signed, statement } from '../../../packages/gate/test/grainhack-support.ts';
import { grainhackCapsFor, parseGrainhackCaps } from '../src/grainhack/caps.ts';
import { grainhackSignerConfig } from '../src/grainhack/config.ts';
import { GrainhackSigner } from '../src/grainhack/grainhack-signer.ts';
import { GrainhackJournal } from '../src/grainhack/journal.ts';
import { decide, resolvePayout, type ChainStatus } from '../src/grainhack/resolve.ts';
import { createGrainhackServer } from '../src/grainhack/server.ts';
import { PayoutJournal } from '../src/payout/journal.ts';
import { PayoutSigner } from '../src/payout/payout-signer.ts';
import type { PayoutRail } from '../src/payout/rail.ts';
import { createPayoutServer } from '../src/payout/server.ts';

const approver = Keypair.generate();
const approverAddr = approver.publicKey.toBase58();
const MINT = Keypair.generate().publicKey.toBase58();
const FLOAT = Keypair.generate().publicKey.toBase58();
const key = resultsKey(Buffer.alloc(32, 3));
const USD = 1_000_000n;
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

class FakeRail implements PayoutRail {
  sent: { to: string; amountMinor: bigint }[] = [];
  built = 0;
  failBuild = false;
  failBroadcast = false;
  onBroadcast?: (signature: string) => void;
  address() {
    return FLOAT;
  }
  async prepareTransfer(a: { to: string; amountMinor: bigint }) {
    if (this.failBuild) throw new Error('rpc down');
    const signature = `tx-${++n}`;
    this.built++;
    return {
      signature,
      lastValidBlockHeight: 1000,
      broadcast: async () => {
        this.onBroadcast?.(signature);
        if (this.failBroadcast) throw new Error('timeout waiting for confirmation');
        this.sent.push({ to: a.to, amountMinor: a.amountMinor });
      },
    };
  }
}

function setup(opts: { caps?: Parameters<typeof grainhackCapsFor>[1]; network?: string } = {}) {
  const journal = new GrainhackJournal(join(mkdtempSync(join(tmpdir(), 'gh-')), 'j.sqlite'));
  const rail = new FakeRail();
  const clock = { now: new Date('2026-10-03T09:00:00Z') };
  const signer = new GrainhackSigner(
    { network: opts.network ?? 'solana-devnet', mints: { USDC: { mint: MINT, decimals: 6 } }, caps: { USDC: opts.caps ?? {} }, trustedApprovers: [approverAddr], resultsPubkey: key.pubkeyB64 },
    journal,
    rail,
    () => clock.now,
  );
  return { signer, rail, journal, clock };
}

function lines(...amountsUsd: [number, number, ('payable' | 'held_kyc')?][]): StatementLine[] {
  return amountsUsd.map(([id, usd, status]) => ({ github_user_id: id, login: `user${id}`, amount_minor: String(BigInt(Math.round(usd * 1e6))), status: status ?? 'payable' }));
}
function makeStatement(ls: StatementLine[], over: Partial<ResultsStatement> = {}) {
  const pool = ls.reduce((a, l) => a + BigInt(l.amount_minor), 0n);
  return signed(key, statement({ statement_id: uuid(), lines: ls, pool_minor: String(pool), ...over }));
}
function termsFor(st: { statement: string }, githubUserId: number, over: Partial<GrainhackTerms> = {}): GrainhackTerms {
  const s = JSON.parse(st.statement) as ResultsStatement;
  const line = s.lines.find((l) => l.github_user_id === githubUserId)!;
  return {
    payout_id: uuid(), statement_id: s.statement_id, statement_sha256: statementSha256(st.statement), hackathon_id: s.hackathon_id, pool: s.pool,
    github_user_id: githubUserId, login: line.login, recipient: Keypair.generate().publicKey.toBase58(), amount_minor: line.amount_minor,
    currency: s.currency, mint: MINT, network: s.network, ...over,
  };
}
const approve = (t: GrainhackTerms, at: Date) => signGrainhackApproval(t, approver.secretKey, approverAddr, at);
const req = (st: { statement: string; signature: string }, a: GrainhackApproval) => ({ approval: a, statement: st.statement, statement_signature: st.signature });

describe('grainhack-signer pays', () => {
  it('pays an approved payable line once, journalled with its transaction signature before the broadcast', async () => {
    const { signer, rail, journal, clock } = setup();
    const st = makeStatement(lines([101, 4], [202, 3.5, 'held_kyc'], [303, 2.5]));
    const t = termsFor(st, 101);
    let atBroadcast: unknown;
    rail.onBroadcast = (sig) => (atBroadcast = journal.byPayoutId(t.payout_id));
    const r = await signer.pay(req(st, approve(t, clock.now)));
    expect(r).toMatchObject({ ok: true, payer: FLOAT });
    expect(atBroadcast).toMatchObject({ status: 'sent', tx_signature: (r as { signature: string }).signature, last_valid_block_height: 1000 });
    expect(rail.sent).toEqual([{ to: t.recipient, amountMinor: 4n * USD }]);
    expect(journal.byPayoutId(t.payout_id)).toMatchObject({ status: 'confirmed', github_user_id: 101, approver: approverAddr });
    expect(journal.transitions(t.payout_id).map((x) => x.to_status)).toEqual(['reserved', 'sent', 'confirmed']);
  });
});

describe('grainhack-signer refuses (contract §2, in order)', () => {
  it('1. approvals: missing, the bounty kind, extra keys, untrusted, forged, expired, longer than an hour', async () => {
    const { signer, rail, clock } = setup();
    const st = makeStatement(lines([101, 4]));
    const t = termsFor(st, 101);
    const bountyTerms: PayoutTerms = {
      payout_id: 'p', bounty_id: 'b', repo: 'o/r', issue_number: 1, pr_number: 2, author_login: 'user101', recipient: t.recipient, amount_minor: t.amount_minor,
      currency: 'USDC', mint: MINT, network: 'solana-devnet',
    };
    const untrusted = Keypair.generate();
    const now = clock.now;
    const long = (() => {
      const approved_at = now.toISOString();
      const expires_at = new Date(now.getTime() + 2 * 3600_000).toISOString();
      return { terms: t, approver: approverAddr, approved_at, expires_at, signature: signDetached(approver.secretKey, envelopeMessage(GRAINHACK_APPROVAL_DOMAIN, t, approved_at, expires_at)) };
    })();
    const cases: [unknown, number, RegExp][] = [
      [{ ...approve(t, now), terms: undefined }, 400, /missing approval terms/],
      [signApproval(bountyTerms, approver.secretKey, approverAddr, now), 400, /bounty payout, not a GrainHack payout/],
      [approve({ ...t, note: 'x' } as never, now), 400, /exactly/],
      [signGrainhackApproval(t, untrusted.secretKey, untrusted.publicKey.toBase58(), now), 403, /not trusted/],
      [signGrainhackApproval(t, untrusted.secretKey, approverAddr, now), 403, /signature does not verify/],
      [approve(t, new Date(now.getTime() - 3600_001)), 403, /expired/],
      [long, 403, /lifetime/],
    ];
    for (const [a, status, why] of cases) {
      expect(await signer.pay(req(st, a as GrainhackApproval)), String(why)).toMatchObject({ ok: false, status, error: expect.stringMatching(why) });
    }
    expect(rail.built).toBe(0);
  });

  it('2. statements: wrong key, other bytes than approved, another statement, another event', async () => {
    const { signer, rail, clock } = setup();
    const st = makeStatement(lines([101, 4], [303, 2.5]));
    const t = termsFor(st, 101);
    const other = resultsKey(Buffer.alloc(32, 8));
    const st2 = makeStatement(lines([101, 4], [303, 2.5]));
    const cases: [ReturnType<typeof req>, RegExp][] = [
      [{ ...req(st, approve(t, clock.now)), statement_signature: other.sign(st.statement) }, /statement signature does not verify/],
      [req(st2, approve(t, clock.now)), /sha256 does not match/],
      [req(st2, approve({ ...t, statement_sha256: statementSha256(st2.statement) }, clock.now)), /id .* is not the approved/],
      [req(st, approve({ ...t, hackathon_id: uuid() }, clock.now)), /hackathon or pool/],
    ];
    for (const [r, why] of cases) expect(await signer.pay(r), String(why)).toMatchObject({ ok: false, status: 403, error: expect.stringMatching(why) });
    expect(rail.built).toBe(0);
  });

  it('3. network, currency and mint must be the signer\'s', async () => {
    const { signer, rail, clock } = setup();
    const main = makeStatement(lines([101, 4]), { network: 'solana-mainnet' });
    const eur = makeStatement(lines([101, 4]), { currency: 'EURC' });
    const st = makeStatement(lines([101, 4]));
    const cases: [ReturnType<typeof req>, RegExp][] = [
      [req(main, approve(termsFor(main, 101), clock.now)), /network/],
      [req(st, approve(termsFor(st, 101, { network: 'solana-mainnet' }), clock.now)), /network/],
      [req(eur, approve(termsFor(eur, 101), clock.now)), /mint .* is not the configured EURC mint/],
      [req(st, approve(termsFor(st, 101, { currency: 'EURC' }), clock.now)), /currency/],
      [req(st, approve(termsFor(st, 101, { mint: Keypair.generate().publicKey.toBase58() }), clock.now)), /mint/],
    ];
    for (const [r, why] of cases) expect(await signer.pay(r), String(why)).toMatchObject({ ok: false, error: expect.stringMatching(why) });
    expect(rail.built).toBe(0);
  });

  it('4. the statement must name this winner as payable, for this amount and login', async () => {
    const { signer, rail, clock } = setup();
    const st = makeStatement(lines([101, 4], [202, 3.5, 'held_kyc']));
    const cases: [GrainhackTerms, RegExp][] = [
      [termsFor(st, 101, { github_user_id: 999 }), /no line for github_user_id 999/],
      [termsFor(st, 202), /held_kyc on this statement, not payable/],
      [termsFor(st, 101, { amount_minor: '4000001' }), /not the statement's 4000000/],
      [termsFor(st, 101, { login: 'someone-else' }), /login/],
    ];
    for (const [t, why] of cases) expect(await signer.pay(req(st, approve(t, clock.now))), String(why)).toMatchObject({ ok: false, status: 403, error: expect.stringMatching(why) });
    expect(rail.built).toBe(0);
  });

  it('5. the recipient must be a Solana address and not the float', async () => {
    const { signer, rail, clock } = setup();
    const st = makeStatement(lines([101, 4]));
    expect(await signer.pay(req(st, approve(termsFor(st, 101, { recipient: '0xabc' }), clock.now)))).toMatchObject({ ok: false, status: 400 });
    expect(await signer.pay(req(st, approve(termsFor(st, 101, { recipient: FLOAT }), clock.now)))).toMatchObject({ ok: false, error: expect.stringMatching(/float/) });
    expect(rail.built).toBe(0);
  });
});

describe('grainhack-signer caps, at their edges', () => {
  it('per payout: exactly $500 pays, $500.000001 does not', async () => {
    const { signer, rail, clock } = setup();
    const st = makeStatement(lines([101, 500], [202, 500.000001]));
    expect(await signer.pay(req(st, approve(termsFor(st, 101), clock.now)))).toMatchObject({ ok: true });
    expect(await signer.pay(req(st, approve(termsFor(st, 202), clock.now)))).toMatchObject({ ok: false, error: expect.stringMatching(/per-payout cap/) });
    expect(rail.sent).toHaveLength(1);
  });

  it('per UTC day: $2,500 exactly pays, one more micro-dollar waits for the next UTC day', async () => {
    const { signer, rail, clock } = setup();
    const st = makeStatement(lines(...Array.from({ length: 7 }, (_, i) => [i + 1, i === 5 ? 0.000001 : 500] as [number, number])));
    for (const id of [1, 2, 3, 4, 5]) expect(await signer.pay(req(st, approve(termsFor(st, id), clock.now))), `#${id}`).toMatchObject({ ok: true });
    expect(await signer.pay(req(st, approve(termsFor(st, 6), clock.now)))).toMatchObject({ ok: false, error: expect.stringMatching(/daily cap/) });
    clock.now = new Date('2026-10-03T23:59:59.999Z');
    expect(await signer.pay(req(st, approve(termsFor(st, 6), clock.now)))).toMatchObject({ ok: false, error: expect.stringMatching(/daily cap/) });
    clock.now = new Date('2026-10-04T00:00:00Z');
    expect(await signer.pay(req(st, approve(termsFor(st, 6), clock.now)))).toMatchObject({ ok: true });
    expect(rail.sent).toHaveLength(6);
  });

  it('per event: $5,000 across days pays, the next payout from that pool does not', async () => {
    const { signer, rail, clock } = setup();
    const st = makeStatement(lines(...Array.from({ length: 11 }, (_, i) => [i + 1, 500] as [number, number])));
    for (let id = 1; id <= 10; id++) {
      clock.now = new Date(Date.UTC(2026, 9, 3 + Math.floor((id - 1) / 5), 9));
      expect(await signer.pay(req(st, approve(termsFor(st, id), clock.now))), `#${id}`).toMatchObject({ ok: true });
    }
    clock.now = new Date('2026-10-06T09:00:00Z');
    expect(await signer.pay(req(st, approve(termsFor(st, 11), clock.now)))).toMatchObject({ ok: false, error: expect.stringMatching(/event cap/) });
    expect(rail.sent).toHaveLength(10);
  });

  it('per event: never more than the statement\'s own pool, across superseding statements', async () => {
    const { signer, rail, clock } = setup();
    const a = makeStatement(lines([101, 4], [202, 3, 'held_kyc'], [303, 2]));
    expect(await signer.pay(req(a, approve(termsFor(a, 101), clock.now)))).toMatchObject({ ok: true });
    expect(await signer.pay(req(a, approve(termsFor(a, 303), clock.now)))).toMatchObject({ ok: true });
    // A later statement for the same event with a smaller pool (6) than already paid (6) + 3.
    const b = makeStatement(lines([101, 1], [202, 3], [303, 2]), { supersedes: JSON.parse(a.statement).statement_id });
    expect(await signer.pay(req(b, approve(termsFor(b, 202), clock.now)))).toMatchObject({ ok: false, error: expect.stringMatching(/event cap: 6000000 .* > 6000000/) });
    // Exactly the pool is fine.
    const c = makeStatement(lines([101, 4], [202, 3], [303, 2]), { supersedes: JSON.parse(b.statement).statement_id });
    expect(await signer.pay(req(c, approve(termsFor(c, 202), clock.now)))).toMatchObject({ ok: true });
    expect(rail.sent.map((s) => s.amountMinor)).toEqual([4n * USD, 2n * USD, 3n * USD]);
  });

  it('configuration lowers the caps and can never raise them', async () => {
    expect(grainhackCapsFor('USDC', { perPayoutMaxMinor: 10n * USD, dailyMaxMinor: 99_999n * USD })).toEqual({ perPayoutMaxMinor: 10n * USD, perEventMaxMinor: 5000n * USD, dailyMaxMinor: 2500n * USD });
    expect(grainhackCapsFor('ANSEM')).toBeNull();
    expect(parseGrainhackCaps('{"USDC":{"perEventMaxMinor":"20000000"}}')).toEqual({ USDC: { perEventMaxMinor: 20n * USD } });
    expect(() => parseGrainhackCaps('{"USDC":{"perEventMaxMinor":20}}')).toThrow();
    expect(() => parseGrainhackCaps('{"USDC":{"perBountyMaxMinor":"1"}}')).toThrow(/unknown cap/);
    const { signer, rail, clock } = setup({ caps: { perPayoutMaxMinor: 3n * USD } });
    const st = makeStatement(lines([101, 4], [303, 3]));
    expect(await signer.pay(req(st, approve(termsFor(st, 101), clock.now)))).toMatchObject({ ok: false, error: expect.stringMatching(/per-payout cap/) });
    expect(await signer.pay(req(st, approve(termsFor(st, 303), clock.now)))).toMatchObject({ ok: true });
    expect(rail.sent).toHaveLength(1);
  });

  it('sums are keyed by (currency, network): another network\'s payouts do not count', () => {
    const journal = new GrainhackJournal(join(mkdtempSync(join(tmpdir(), 'gh-')), 'j.sqlite'));
    const base = { approver: approverAddr, statementId: uuid(), statementSha256: 'a'.repeat(64), hackathonId: uuid(), pool: 'contributor', login: 'x', recipient: 'r', currency: 'USDC', mint: MINT, amountMinor: 500n * USD, day: '2026-10-03', lastValidBlockHeight: 1 };
    const limits = { eventMaxMinor: 5000n * USD, dailyMaxMinor: 2500n * USD };
    for (let i = 0; i < 5; i++) expect(journal.reserve({ ...base, payoutId: uuid(), approvalSignature: `s${i}`, githubUserId: i + 1, network: 'solana-mainnet', txSignature: `t${i}` }, limits)).toMatchObject({ ok: true });
    expect(journal.committedOnDay('USDC', 'solana-devnet', '2026-10-03')).toBe(0n);
    expect(journal.committedOnDay('USDC', 'solana-mainnet', '2026-10-03')).toBe(2500n * USD);
    expect(journal.check({ ...base, payoutId: uuid(), approvalSignature: 'z', githubUserId: 99, network: 'solana-devnet' }, limits)).toBeNull();
    expect(() => (journal as unknown as { db: { exec: (s: string) => void } }).db.exec('DELETE FROM grainhack_payouts')).toThrow(/never deleted/);
  });
});

describe('grainhack-signer: one payout per winner, ever', () => {
  // Caps (check 6) run before uniqueness (check 7), so these pools leave room
  // under the cap for a second payment: the refusal has to come from uniqueness.
  it('refuses a second payout for the same winner, under any statement or approval; replays the first', async () => {
    const { signer, rail, clock } = setup();
    const a = makeStatement(lines([101, 4], [303, 2], [999, 400, 'held_kyc']));
    const t = termsFor(a, 101);
    const first = approve(t, clock.now);
    const paid = await signer.pay(req(a, first));
    expect(paid).toMatchObject({ ok: true });
    expect(await signer.pay(req(a, first))).toEqual(paid); // the same approval again: its payment, not another
    expect(await signer.pay(req(a, approve({ ...t, payout_id: uuid() }, clock.now)))).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/one payout per winner/) });
    const b = makeStatement(lines([101, 4], [303, 2], [999, 400, 'held_kyc']), { supersedes: JSON.parse(a.statement).statement_id });
    expect(await signer.pay(req(b, approve(termsFor(b, 101), clock.now)))).toMatchObject({ ok: false, status: 409 });
    expect(rail.sent).toHaveLength(1);
  });

  it('an unknown outcome is journalled, never retried, and still blocks the winner', async () => {
    const { signer, rail, journal, clock } = setup();
    const st = makeStatement(lines([101, 4], [999, 400, 'held_kyc']));
    const t = termsFor(st, 101);
    rail.failBroadcast = true;
    const a = approve(t, clock.now);
    expect(await signer.pay(req(st, a))).toMatchObject({ ok: false, status: 502, unknown: true, error: expect.stringMatching(/a person must resolve/) });
    expect(journal.byPayoutId(t.payout_id)).toMatchObject({ status: 'unknown', error: expect.stringMatching(/timeout/) });
    rail.failBroadcast = false;
    expect(await signer.pay(req(st, a))).toMatchObject({ ok: false, status: 409, existing: { status: 'unknown' } });
    expect(await signer.pay(req(st, approve({ ...t, payout_id: uuid() }, clock.now)))).toMatchObject({ ok: false, status: 409 });
    expect(rail.built).toBe(1);
    expect(rail.sent).toHaveLength(0);
  });

  it('a transfer that cannot be built leaves no row and does not block the winner', async () => {
    const { signer, rail, journal, clock } = setup();
    const st = makeStatement(lines([101, 4]));
    rail.failBuild = true;
    expect(await signer.pay(req(st, approve(termsFor(st, 101), clock.now)))).toMatchObject({ ok: false, status: 422, error: expect.stringMatching(/nothing sent/) });
    expect(journal.all()).toHaveLength(0);
    rail.failBuild = false;
    expect(await signer.pay(req(st, approve(termsFor(st, 101), clock.now)))).toMatchObject({ ok: true });
  });
});

describe('cross-route refusal', () => {
  it('the bounty payout signer refuses a GrainHack approval', async () => {
    const pj = new PayoutJournal(join(mkdtempSync(join(tmpdir(), 'pj-')), 'j.sqlite'));
    const rail = new FakeRail();
    const now = new Date('2026-10-03T09:00:00Z');
    const bounty = new PayoutSigner(
      { network: 'solana-devnet', mints: { USDC: { mint: MINT, decimals: 6 } }, caps: {}, allowedRepos: ['o/r'], trustedApprovers: [approverAddr] },
      pj, rail, async () => ({ merged: true, authorLogin: 'user101', mergedByLogin: 'm' }), () => now,
    );
    const st = makeStatement(lines([101, 4]));
    const g = approve(termsFor(st, 101), now);
    expect(await bounty.pay(g as never)).toMatchObject({ ok: false, error: expect.stringMatching(/signature does not verify/) });
    // Even dressed up with the bounty fields it lacks, the GrainHack domain does not verify there.
    const dressed = signGrainhackApproval({ ...g.terms, repo: 'o/r', bounty_id: 'b', pr_number: 1, issue_number: 1, author_login: 'user101' } as never, approver.secretKey, approverAddr, now);
    expect(await bounty.pay(dressed as never)).toMatchObject({ ok: false, error: expect.stringMatching(/signature does not verify/) });
    expect(rail.built).toBe(0);
  });

  it('each server has only its own route', async () => {
    const tok = 't'.repeat(32);
    const { signer, journal } = setup();
    const gh = createGrainhackServer(signer, journal, tok);
    const pj = new PayoutJournal(join(mkdtempSync(join(tmpdir(), 'pj-')), 'j.sqlite'));
    const bounty = createPayoutServer(new PayoutSigner({ network: 'solana-devnet', mints: {}, caps: {}, allowedRepos: [], trustedApprovers: [] }, pj, new FakeRail()), pj, tok);
    const listen = async (s: typeof gh) => {
      await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
      return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    };
    const [g, b] = [await listen(gh), await listen(bounty)];
    const post = (u: string, body: unknown) => fetch(u, { method: 'POST', headers: { authorization: `Bearer ${tok}` }, body: JSON.stringify(body) });
    expect((await post(`${g}/v1/payout/pay`, { approval: {} })).status).toBe(404);
    expect((await post(`${g}/v1/escrow/release`, { approval: {} })).status).toBe(404);
    expect((await post(`${b}/v1/grainhack/pay`, { approval: {} })).status).toBe(404);
    expect((await fetch(`${g}/v1/config`)).status).toBe(401);
    const cfg = await (await fetch(`${g}/v1/config`, { headers: { authorization: `Bearer ${tok}` } })).json();
    expect(cfg).toMatchObject({ service: 'grainhack-signer', network: 'solana-devnet', address: FLOAT, caps: { USDC: { perPayoutMaxMinor: '500000000', perEventMaxMinor: '5000000000', dailyMaxMinor: '2500000000' } } });
    const bad = await post(`${g}/v1/grainhack/pay`, { approval: signApproval({ payout_id: 'p', bounty_id: 'b', repo: 'o/r', issue_number: 1, pr_number: 1, author_login: 'a', recipient: FLOAT, amount_minor: '1', currency: 'USDC', mint: MINT, network: 'solana-devnet' }, approver.secretKey, approverAddr, new Date()) });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'this approval is for a bounty payout, not a GrainHack payout' });
    await Promise.all([gh, bounty].map((s) => new Promise((r) => s.close(r))));
  });
});

describe('resolving an unknown outcome (a person, from the chain)', () => {
  const unknownRow = { status: 'unknown' as const, last_valid_block_height: 1000 };
  it('decides only what the chain proves', () => {
    const found = (err: unknown, c: string | null = 'finalized'): ChainStatus => ({ found: true, err, confirmationStatus: c, slot: 5 });
    expect(decide(unknownRow, found(null))).toMatchObject({ to: 'confirmed' });
    expect(decide(unknownRow, found({ InstructionError: [2, 'x'] }))).toMatchObject({ to: 'failed_unsent' });
    expect(decide(unknownRow, found(null, 'processed'))).toMatchObject({ to: null });
    expect(decide(unknownRow, { found: false, finalizedBlockHeight: 1001 })).toMatchObject({ to: 'failed_unsent', why: expect.stringMatching(/expired/) });
    expect(decide(unknownRow, { found: false, finalizedBlockHeight: 1000 })).toMatchObject({ to: null, why: expect.stringMatching(/could still land/) });
    expect(decide({ ...unknownRow, last_valid_block_height: null }, { found: false, finalizedBlockHeight: 9999 })).toMatchObject({ to: null });
    expect(decide({ ...unknownRow, status: 'confirmed' }, found(null))).toMatchObject({ to: null, why: 'already confirmed' });
  });

  it('records who resolved it, why, and the evidence; refuses without a name and reason', async () => {
    const { signer, rail, journal, clock } = setup();
    const st = makeStatement(lines([101, 4]));
    const t = termsFor(st, 101);
    rail.failBroadcast = true;
    await signer.pay(req(st, approve(t, clock.now)));
    const chain = { status: async () => ({ found: true, err: null, confirmationStatus: 'finalized', slot: 77 }) as ChainStatus };
    await expect(resolvePayout(journal, chain, t.payout_id, '', 'x')).rejects.toThrow(/actor/);
    const r = await resolvePayout(journal, chain, t.payout_id, 'jagadeesh', 'checked after RPC timeout');
    expect(r).toMatchObject({ resolved: true, row: { status: 'confirmed', resolved_by: 'jagadeesh', resolved_reason: 'checked after RPC timeout' } });
    expect(JSON.parse(r.row.resolution!)).toMatchObject({ chain: { slot: 77 } });
    expect(journal.transitions(t.payout_id).at(-1)).toMatchObject({ from_status: 'unknown', to_status: 'confirmed', actor: 'jagadeesh' });
    expect(await resolvePayout(journal, chain, t.payout_id, 'jagadeesh', 'again')).toMatchObject({ resolved: false, why: 'already confirmed' });
    expect(() => journal.resolve(t.payout_id, 'failed_unsent', 'x', 'y', {})).toThrow(/illegal transition/);
  });
});

describe('grainhack-signer configuration', () => {
  const env = {
    GRAINHACK_PAYOUT_NETWORK: 'solana-devnet', GRAINHACK_PAYOUT_MINTS: JSON.stringify({ USDC: { mint: MINT, decimals: 6 } }), GRAINHACK_RESULTS_PUBKEY: key.pubkeyB64,
    APPROVER_PUBKEYS: approverAddr, GRAINHACK_PAYOUT_RPC_URL: 'https://api.devnet.solana.com',
  };
  it('reads its own variables', () => {
    expect(grainhackSignerConfig(env)).toMatchObject({ network: 'solana-devnet', journalPath: 'data/grainhack-journal.sqlite', trustedApprovers: [approverAddr] });
  });
  it('refuses mainnet unless switched on deliberately', () => {
    expect(() => grainhackSignerConfig({ ...env, GRAINHACK_PAYOUT_NETWORK: 'solana-mainnet' })).toThrow(/GRAINHACK_ALLOW_MAINNET=yes/);
    expect(grainhackSignerConfig({ ...env, GRAINHACK_PAYOUT_NETWORK: 'solana-mainnet', GRAINHACK_ALLOW_MAINNET: 'yes' }).network).toBe('solana-mainnet');
  });
  it('refuses to start beside another process\'s key, or with a malformed results key', () => {
    expect(() => grainhackSignerConfig({ ...env, PAYOUT_KEYPAIR_JSON: '[1]' })).toThrow(/another process's key/);
    expect(() => grainhackSignerConfig({ ...env, GRAINHACK_RESULTS_PUBKEY: approverAddr })).toThrow(/GRAINHACK_RESULTS_PUBKEY/);
  });
});
