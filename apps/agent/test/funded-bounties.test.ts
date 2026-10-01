// Maintainer-funded bounties end to end, against Postgres, with the chain and
// the attestor faked. Needs TEST_DATABASE_URL.
//
// The chain fake holds escrow accounts as the program lays them out, so the
// service reads them through the same decoder it uses in production. What
// these tests pin is the product's rules, in the order a funded bounty meets
// them: nothing visible until funded, the funder runs it, nobody gets an
// abandon from a clock, both sides once a pull request is open, silence is
// consent, and the chain wins when it disagrees with us.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { Keypair, PublicKey, type Connection } from '@solana/web3.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase } from '../../../packages/db/src/testing.ts';
import { DrawService } from '../src/draw-service.ts';
import { EscrowService } from '../src/escrow-service.ts';
import { escrowPda } from '../src/escrow-ix.ts';
import { FundedService, type Attestor } from '../src/funded-service.ts';
import { PublicApi } from '../src/public.ts';
import { BountyService } from '../src/service.ts';
import { signApproval } from '../../../packages/gate/src/approval.ts';
import { p2Config } from '../src/config.ts';
import { FakeGitHub } from './fake-github.ts';

const dbUrl = process.env.TEST_DATABASE_URL;
const REPO = 'acme/widgets';
const MINT = Keypair.generate().publicKey.toBase58();
const ATTESTOR = Keypair.generate().publicKey;
const FEE = Keypair.generate().publicKey;

/** An escrow account as the program writes it (lib.rs, struct Escrow). */
function encodeEscrow(e: {
  bountyId: Buffer; funder: PublicKey; amount: bigint; feeAmount: bigint; mode: 0 | 1; state: 0 | 1;
  contributor: PublicKey | null; everAssigned: boolean; deadline: number;
}) {
  const parts: Buffer[] = [Buffer.alloc(8), e.bountyId, e.funder.toBuffer(), new PublicKey(MINT).toBuffer()];
  const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
  const u16 = Buffer.alloc(2); u16.writeUInt16LE(250);
  parts.push(u64(e.amount), u16, u64(250_000n), u64(e.feeAmount), FEE.toBuffer(), ATTESTOR.toBuffer(), Buffer.from([e.mode, e.state]));
  parts.push(e.contributor ? Buffer.concat([Buffer.from([1]), e.contributor.toBuffer()]) : Buffer.from([0]));
  const dl = Buffer.alloc(8); dl.writeBigInt64LE(BigInt(e.deadline));
  parts.push(Buffer.from([e.everAssigned ? 1 : 0]), dl, Buffer.from([0]), Buffer.alloc(4));
  return Buffer.concat(parts);
}

class FakeChain {
  accounts = new Map<string, Buffer>();
  asConnection(): Connection {
    return {
      getAccountInfo: async (k: PublicKey) => {
        const data = this.accounts.get(k.toBase58());
        return data ? { data, owner: ATTESTOR, lamports: 1, executable: false } : null;
      },
      getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 }),
    } as unknown as Connection;
  }
}

class FakeAttestor implements Attestor {
  calls: string[] = [];
  fail = false;
  constructor(private readonly chain: FakeChain, private readonly now: () => Date) {}
  private rewrite(escrow: string, f: (d: Buffer) => Buffer) {
    this.chain.accounts.set(escrow, f(this.chain.accounts.get(escrow)!));
  }
  async assign(escrow: string, wallet: string) {
    this.calls.push(`assign ${wallet}`);
    if (this.fail) return { ok: false as const, error: 'signer down' };
    this.rewrite(escrow, (d) => setContributor(d, new PublicKey(wallet)));
    return { ok: true as const, signature: `sig-assign-${this.calls.length}` };
  }
  async unassign(escrow: string) {
    this.calls.push('unassign');
    if (this.fail) return { ok: false as const, error: 'signer down' };
    this.rewrite(escrow, (d) => setContributor(d, null));
    return { ok: true as const, signature: `sig-unassign-${this.calls.length}` };
  }
}

// Offsets into the encoded account: discriminator 8, bounty 16, funder 32,
// mint 32, amount 8, fee bps 2, fee min 8, fee 8, fee dest 32, attestor 32.
const MODE_AT = 8 + 16 + 32 + 32 + 8 + 2 + 8 + 8 + 32 + 32;
function setContributor(d: Buffer, who: PublicKey | null) {
  const head = Buffer.from(d.subarray(0, MODE_AT + 2));
  const hadContributor = d[MODE_AT + 2] === 1;
  const tail = d.subarray(MODE_AT + 3 + (hadContributor ? 32 : 0));
  head[MODE_AT + 1] = who ? 1 : 0;                         // Assigned : Funded
  const contributor = who ? Buffer.concat([Buffer.from([1]), who.toBuffer()]) : Buffer.from([0]);
  const rest = Buffer.from(tail);
  if (who) rest[0] = 1;                                     // ever_assigned
  return Buffer.concat([head, contributor, rest]);
}

describe.skipIf(!dbUrl)('funded bounties', () => {
  let db: pg.Pool;
  let gh: FakeGitHub;
  let chain: FakeChain;
  let attestor: FakeAttestor;
  let escrow: EscrowService;
  let funded: FundedService;
  let draw: DrawService;
  let clock = new Date('2026-10-02T10:00:00Z');
  const now = () => clock;
  const funderWallet = Keypair.generate().publicKey;
  const deadline = () => new Date(clock.getTime() + 14 * 86_400_000);

  const setSwitch = (on: boolean) => db.query(
    `INSERT INTO bounty_config (key, value, updated_by, updated_at) VALUES ('funded_bounties_enabled',$1,'test',now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [String(on)]);

  const person = async (id: number, login: string, wallet = true) => {
    gh.addUser(login, id, '2024-01-01T00:00:00Z');
    await db.query('INSERT INTO contributors (github_user_id, login) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, login]);
    const address = Keypair.generate().publicKey.toBase58();
    if (wallet) await db.query(`INSERT INTO wallet_links (github_user_id, address, message, signature, source) VALUES ($1,$2,'m','s','t')`, [id, address]);
    return address;
  };

  const make = (attestorOn = true) => {
    escrow = new EscrowService({
      db, connection: chain.asConnection(), attestor: ATTESTOR, feeDestination: FEE, network: 'solana-devnet',
      mints: { USDC: { mint: MINT, decimals: 6 } }, testers: ['tester-tia'], now,
    });
    draw = new DrawService({ db, gh, now });
    funded = new FundedService({
      db, gh, draw, escrow, attestor: attestorOn ? attestor : undefined,
      caps: { USDC: { perBountyMaxMinor: 50_000_000n } }, now,
    });
  };

  const prepareInput = (over: Partial<Parameters<FundedService['prepare']>[0]> = {}) => ({
    login: 'owen', githubUserId: 900, repo: REPO, issueNumber: 41, amountMinor: 50_000_000n, currency: 'USDC',
    mode: 'draw' as const, deadline: deadline(), funderWallet: funderWallet.toBase58(), verifiedProject: true, ...over,
  });

  /** Prepare, then put the escrow on the fake chain as the funder's signature would, then confirm. */
  async function fundedBounty(mode: 'draw' | 'self_assign' = 'draw') {
    const p = await funded.prepare(prepareInput({ mode }));
    if (!p.ok) throw new Error(`prepare: ${p.error}`);
    const [pda] = escrowPda(Buffer.from(p.bountyId.replace(/-/g, ''), 'hex'));
    chain.accounts.set(pda.toBase58(), encodeEscrow({
      bountyId: Buffer.from(p.bountyId.replace(/-/g, ''), 'hex'), funder: funderWallet,
      amount: 50_000_000n, feeAmount: BigInt(p.feeAmountMinor), mode: mode === 'draw' ? 0 : 1, state: 0,
      contributor: null, everAssigned: false, deadline: Math.floor(deadline().getTime() / 1000),
    }));
    const c = await funded.confirm(p.bountyId, 'owen', 'sig-fund');
    if (!c.ok) throw new Error(`confirm: ${c.error}`);
    return { bountyId: p.bountyId, escrowAddress: pda.toBase58() };
  }

  const apply = async (bountyId: string, id: number, login: string) =>
    draw.apply({ bountyId, githubUserId: id, githubLogin: login });

  const live = async (bountyId: string) =>
    (await db.query(`SELECT * FROM bounty_assignments WHERE bounty_id = $1 AND status IN ('active','pr_submitted')`, [bountyId])).rows[0];

  const openPr = async (bountyId: string, githubUserId: number, n = 58) => {
    await db.query(
      `INSERT INTO submissions (id, bounty_id, pr_number, author_github_user_id, author_login, state) VALUES ($1,$2,$3,$4,'x','open')`,
      [randomUUID(), bountyId, n, githubUserId]);
    await db.query(`UPDATE bounty_assignments SET status = 'pr_submitted', qualifying_pr_number = $2 WHERE bounty_id = $1 AND status = 'active'`, [bountyId, n]);
  };

  beforeAll(async () => { db = await freshDatabase(dbUrl!, 'test_funded_bounties'); });
  beforeEach(async () => {
    clock = new Date('2026-10-02T10:00:00Z');
    await db.query(`TRUNCATE funder_conduct_notes, bounty_unassign_proposals, bounty_escrow_events, bounty_escrows, submissions,
                    bounty_events, bounty_assignments, bounty_draws, bounty_applications, bounties, wallet_links, contributors,
                    repos, audit_log, bounty_config CASCADE`);
    gh = new FakeGitHub();
    gh.issues.set(gh.key(REPO, 41), { number: 41, title: 'Add retry budgets to the rail worker', body: '', state: 'open', authorLogin: 'owen' });
    gh.permissions.set(`${REPO}:owen`, 'maintain');
    chain = new FakeChain();
    attestor = new FakeAttestor(chain, now);
    make();
    await setSwitch(true);
  });
  afterAll(async () => { await db?.end(); });

  describe('creating one', () => {
    it('is unreachable while switched off, except for a named tester', async () => {
      await setSwitch(false);
      expect((await funded.prepare(prepareInput())).ok).toBe(false);
      gh.permissions.set(`${REPO}:tester-tia`, 'write');
      const r = await funded.prepare(prepareInput({ login: 'tester-tia' }));
      expect(r).toMatchObject({ ok: true });
    });

    it('needs a verified project, write access, an open issue, and an amount within the payout cap', async () => {
      expect(await funded.prepare(prepareInput({ verifiedProject: false }))).toMatchObject({ error: 'not_a_verified_project' });
      expect(await funded.prepare(prepareInput({ login: 'passer-by' }))).toMatchObject({ error: 'not_your_repo' });
      expect(await funded.prepare(prepareInput({ amountMinor: 50_000_001n }))).toMatchObject({ error: 'over_cap' });
      expect(await funded.prepare(prepareInput({ deadline: new Date(clock.getTime() + 2 * 86_400_000) }))).toMatchObject({ error: 'bad_deadline' });
      gh.issues.get(gh.key(REPO, 41))!.state = 'closed';
      expect(await funded.prepare(prepareInput())).toMatchObject({ error: 'issue_closed' });
    });

    it('is invisible until the chain shows the money locked', async () => {
      const pub = new PublicApi(db, p2Config({ mints: {}, trustedApprovers: [] }), { escrowMints: escrow.mints(), funded });
      const p = await funded.prepare(prepareInput());
      expect(p.ok).toBe(true);
      if (!p.ok) return;
      expect(await pub.bounties()).toHaveLength(0);
      // Nobody can apply to a bounty that is not funded.
      await person(1, 'jotel-dev');
      expect(await apply(p.bountyId, 1, 'jotel-dev')).toMatchObject({ ok: false, error: 'not_open' });
      // Confirming before the chain has it is refused, and changes nothing.
      expect(await funded.confirm(p.bountyId, 'owen', 'sig')).toMatchObject({ ok: false, error: 'escrow_not_on_chain' });
      expect(await pub.bounties()).toHaveLength(0);
    });

    it('appears, with who funded it and their record, once funded - and is announced on the issue', async () => {
      const { bountyId, escrowAddress } = await fundedBounty();
      const pub = new PublicApi(db, p2Config({ mints: {}, trustedApprovers: [] }), { escrowMints: escrow.mints(), funded });
      const [b] = await pub.bounties();
      expect(b!.id).toBe(bountyId);
      expect(b!.funded).toMatchObject({ by: 'owen', mode: 'draw', escrow: escrowAddress, profile: { bountiesFunded: 1, unassignedBeforePr: 0, disputesRaised: 0 } });
      expect(gh.comments.at(-1)!.body).toContain('Funded bounty: 50 USDC');
      // Confirming again is harmless.
      expect(await funded.confirm(bountyId, 'owen', 'sig-fund')).toMatchObject({ ok: true, already: true });
    });

    it('lets an unfinished funding be prepared again, by the same funder only', async () => {
      const a = await funded.prepare(prepareInput());
      const b = await funded.prepare(prepareInput({ amountMinor: 20_000_000n }));
      expect(a.ok && b.ok && a.bountyId === b.bountyId).toBe(true);
      gh.permissions.set(`${REPO}:other-maint`, 'write');
      expect(await funded.prepare(prepareInput({ login: 'other-maint' }))).toMatchObject({ error: 'issue_has_bounty' });
    });
  });

  describe('assigning', () => {
    it('keeps applications open with no window, and refuses the funder applying to their own', async () => {
      const { bountyId } = await fundedBounty();
      await person(900, 'owen');
      expect(await apply(bountyId, 900, 'owen')).toMatchObject({ ok: false, error: 'own_bounty' });
      await person(1, 'jotel-dev');
      clock = new Date(clock.getTime() + 10 * 86_400_000);  // long past any normal window
      expect((await apply(bountyId, 1, 'jotel-dev')).ok).toBe(true);
    });

    it('is never drawn by the clock: the funder draws when they choose', async () => {
      const { bountyId } = await fundedBounty();
      await person(1, 'jotel-dev');
      await apply(bountyId, 1, 'jotel-dev');
      clock = new Date(clock.getTime() + 13 * 86_400_000);
      const swept = await draw.closeDueWindows();
      expect(swept.drawn).not.toContain(bountyId);
      expect(await live(bountyId)).toBeUndefined();
    });

    it('draw mode: the funder runs it, the attestor names the winner on-chain, and the deadline is the escrow\'s', async () => {
      const { bountyId } = await fundedBounty();
      expect(await funded.runDraw(bountyId, 'owen', false)).toMatchObject({ ok: false, error: 'no_applicants' });
      const wallet = await person(1, 'jotel-dev');
      await person(2, 'no-wallet', false);
      await apply(bountyId, 1, 'jotel-dev');
      const r = await funded.runDraw(bountyId, 'owen', false);
      expect(r.ok).toBe(true);
      expect(attestor.calls).toEqual([`assign ${wallet}`]);
      const a = await live(bountyId);
      expect(a.github_login).toBe('jotel-dev');
      expect(new Date(a.stale_at).getTime()).toBe(Math.floor(deadline().getTime() / 1000) * 1000 || new Date(a.stale_at).getTime());
      const e = (await db.query('SELECT state, contributor_wallet FROM bounty_escrows WHERE bounty_id = $1', [bountyId])).rows[0];
      expect(e).toEqual({ state: 'assigned', contributor_wallet: wallet });
    });

    it('only the funder runs it - not a repository maintainer who did not fund it', async () => {
      const { bountyId } = await fundedBounty();
      gh.permissions.set(`${REPO}:co-maint`, 'admin');
      expect(await funded.runDraw(bountyId, 'co-maint', false)).toMatchObject({ ok: false, error: 'not_the_funder' });
    });

    it('refuses a draw rather than half-doing it when the attestor is not set up', async () => {
      make(false);
      const { bountyId } = await fundedBounty();
      await person(1, 'jotel-dev');
      await apply(bountyId, 1, 'jotel-dev');
      expect(await funded.runDraw(bountyId, 'owen', false)).toMatchObject({ ok: false, error: 'attestor_not_configured' });
      expect(await live(bountyId)).toBeUndefined();
    });

    it('a failed on-chain assign keeps the win and is retried by the sweep', async () => {
      const { bountyId } = await fundedBounty();
      const wallet = await person(1, 'jotel-dev');
      await apply(bountyId, 1, 'jotel-dev');
      attestor.fail = true;
      const r = await funded.runDraw(bountyId, 'owen', false);
      expect(r).toMatchObject({ ok: true, onChain: null });
      attestor.fail = false;
      expect(await funded.reconcile()).toEqual([{ bountyId, what: 'assign_retried' }]);
      expect((await db.query('SELECT contributor_wallet FROM bounty_escrows WHERE bounty_id = $1', [bountyId])).rows[0].contributor_wallet).toBe(wallet);
    });

    it('self-assign: the funder picks, signs in their wallet, and the chain is believed rather than the caller', async () => {
      const { bountyId, escrowAddress } = await fundedBounty('self_assign');
      const wallet = await person(1, 'jotel-dev');
      await apply(bountyId, 1, 'jotel-dev');
      expect(await funded.runDraw(bountyId, 'owen', false)).toMatchObject({ error: 'self_assign_mode' });
      const p = await funded.assignPrepare(bountyId, 'owen', 'jotel-dev');
      expect(p).toMatchObject({ ok: true, wallet });
      // Claiming it is done before it is: refused.
      expect(await funded.assignConfirm(bountyId, 'owen', 'jotel-dev', 'sig')).toMatchObject({ error: 'not_assigned_on_chain' });
      chain.accounts.set(escrowAddress, setContributor(chain.accounts.get(escrowAddress)!, new PublicKey(wallet)));
      expect(await funded.assignConfirm(bountyId, 'owen', 'jotel-dev', 'sig')).toMatchObject({ ok: true });
      expect((await live(bountyId)).github_login).toBe('jotel-dev');
      expect(attestor.calls).toEqual([]);  // Grainlify signed nothing
    });
  });

  describe('unassigning before a pull request', () => {
    it('is the funder\'s alone, needs no reason, records no abandon, and goes on their public record', async () => {
      const { bountyId } = await fundedBounty();
      await person(1, 'jotel-dev');
      await person(2, 'boluxx123');
      await apply(bountyId, 1, 'jotel-dev');
      await apply(bountyId, 2, 'boluxx123');
      await funded.runDraw(bountyId, 'owen', false);
      const first = (await live(bountyId)).github_login;
      const r = await funded.unassign(bountyId, 'owen', '');
      expect(r).toMatchObject({ ok: true, needsSignature: false });
      const a = (await db.query(`SELECT * FROM bounty_assignments WHERE bounty_id = $1`, [bountyId])).rows[0];
      expect(a).toMatchObject({ status: 'released_voluntary', counts_as_abandon: false, release_reason: 'No reason was given.', released_by: 'owen' });
      expect(await funded.profile('owen')).toMatchObject({ unassignedBeforePr: 1 });
      // Drawn again at once, from whoever remains.
      await funded.runDraw(bountyId, 'owen', false);
      expect((await live(bountyId)).github_login).not.toBe(first);
    });

    it('self-assign: the funder signs it; done from their own wallet without us, it is recorded as exactly that', async () => {
      const { bountyId, escrowAddress } = await fundedBounty('self_assign');
      const wallet = await person(1, 'jotel-dev');
      await apply(bountyId, 1, 'jotel-dev');
      chain.accounts.set(escrowAddress, setContributor(chain.accounts.get(escrowAddress)!, new PublicKey(wallet)));
      await funded.assignConfirm(bountyId, 'owen', 'jotel-dev', 'sig');
      await openPr(bountyId, 1);
      // A pull request is open and nobody agreed; the funder unassigns on-chain anyway.
      chain.accounts.set(escrowAddress, setContributor(chain.accounts.get(escrowAddress)!, null));
      expect(await funded.reconcile()).toEqual([{ bountyId, what: 'unassigned_outside' }]);
      const a = (await db.query(`SELECT * FROM bounty_assignments WHERE bounty_id = $1`, [bountyId])).rows[0];
      expect(a).toMatchObject({ status: 'released_voluntary', unassigned_on_chain_directly: true, counts_as_abandon: false });
      expect(a.release_reason).toBe('The funder unassigned this on-chain, without going through Grainlify.');
    });
  });

  describe('once a pull request is open', () => {
    async function heldWithPr() {
      const b = await fundedBounty();
      await person(1, 'jotel-dev');
      await apply(b.bountyId, 1, 'jotel-dev');
      await funded.runDraw(b.bountyId, 'owen', false);
      await openPr(b.bountyId, 1);
      return b;
    }

    it('the funder cannot unassign alone', async () => {
      const { bountyId } = await heldWithPr();
      expect(await funded.unassign(bountyId, 'owen', 'changed my mind')).toMatchObject({ ok: false, error: 'pr_open' });
    });

    it('a refusal is a dispute: both positions recorded, counted on the funder, and nothing else happens', async () => {
      const { bountyId } = await heldWithPr();
      const p = await funded.propose(bountyId, 'owen', 900, 'going a different direction');
      expect(p.ok).toBe(true);
      if (!p.ok) return;
      // Only the other side answers, and a refusal must say why.
      expect(await funded.respond(p.proposalId, 'owen', 900, false, 'no')).toMatchObject({ error: 'not_the_other_side' });
      expect(await funded.respond(p.proposalId, 'jotel-dev', 1, false, '')).toMatchObject({ error: 'response_required' });
      expect(await funded.respond(p.proposalId, 'jotel-dev', 1, false, 'CI is green and it does what the issue asked')).toMatchObject({ ok: true, status: 'refused' });
      expect((await live(bountyId)).github_login).toBe('jotel-dev');   // still theirs
      expect(attestor.calls).toEqual([expect.stringMatching(/^assign /)]);
      const [d] = await funded.disputes();
      expect(d).toMatchObject({ funderSays: 'going a different direction', contributorSays: 'CI is green and it does what the issue asked', prNumber: 58 });
      expect(await funded.profile('owen')).toMatchObject({ disputesRaised: 1 });
      expect(await funded.leaveToDeadline(d!.id, 'admin')).toMatchObject({ ok: true });
      expect(await funded.conductNote(d!.id, 'admin', 'Asked for changes after the work was done.')).toMatchObject({ ok: true });
      const view = await funded.dispute(d!.id);
      expect(view).toMatchObject({ ok: true, arbitration: 'left_to_deadline', conductNotes: [{ by: 'admin' }] });
    });

    it('agreement carries it out at once in draw mode', async () => {
      const { bountyId } = await heldWithPr();
      const p = await funded.propose(bountyId, 'jotel-dev', 1, 'I cannot finish this');
      if (!p.ok) throw new Error(p.error);
      expect(await funded.respond(p.proposalId, 'owen', 900, true, '')).toMatchObject({ ok: true, carriedOut: true });
      expect(await live(bountyId)).toBeUndefined();
      expect(attestor.calls.at(-1)).toBe('unassign');
      // Agreed after a pull request: not a pre-PR unassign on the funder's record.
      expect(await funded.profile('owen')).toMatchObject({ unassignedBeforePr: 0 });
    });

    it('seven days of silence counts as accepting', async () => {
      const { bountyId } = await heldWithPr();
      const p = await funded.propose(bountyId, 'owen', 900, 'scope changed');
      if (!p.ok) throw new Error(p.error);
      clock = new Date(clock.getTime() + 6 * 86_400_000);
      expect(await funded.expireProposals()).toEqual([]);
      clock = new Date(clock.getTime() + 2 * 86_400_000);
      expect(await funded.expireProposals()).toEqual([p.proposalId]);
      expect(await live(bountyId)).toBeUndefined();
    });

    it('is never released by the stale sweep, whatever the clock says', async () => {
      const { bountyId } = await fundedBounty();
      await person(1, 'jotel-dev');
      await apply(bountyId, 1, 'jotel-dev');
      await funded.runDraw(bountyId, 'owen', false);
      clock = new Date(clock.getTime() + 30 * 86_400_000);
      const r = await draw.releaseStaleAssignments();
      expect(r.released).toEqual([]);
      expect(r.warned).toEqual([]);
    });
  });

  describe('the merge', () => {
    it('pays the escrow\'s recorded wallet, through the escrow route, on the same human approval', async () => {
      const { bountyId, escrowAddress } = await fundedBounty();
      const wallet = await person(1, 'jotel-dev');
      await apply(bountyId, 1, 'jotel-dev');
      await funded.runDraw(bountyId, 'owen', false);
      // They relink to a new wallet after being assigned: the escrow still pays the old one.
      await db.query(`UPDATE wallet_links SET revoked_at = now() WHERE github_user_id = 1`);
      await db.query(`INSERT INTO wallet_links (github_user_id, address, message, signature, source) VALUES (1,$1,'m','s','t')`, [Keypair.generate().publicKey.toBase58()]);

      gh.addUser('jotel-dev', 1, '2024-01-01T00:00:00Z');
      gh.permissions.set(`${REPO}:owen`, 'maintain');
      gh.pulls.set(gh.key(REPO, 58), {
        number: 58, state: 'closed', merged: true, mergedByLogin: 'owen', mergedAt: clock.toISOString(), authorId: 1, authorLogin: 'jotel-dev',
        authorType: 'User', headSha: 'abc', title: 'Retry budgets', body: 'Closes #41', closes: [41], diff: '',
      });
      const approver = Keypair.generate();
      const releases: unknown[] = [];
      const cfg = p2Config({ mints: {}, trustedApprovers: [approver.publicKey.toBase58()] });
      cfg.gate = { ...cfg.gate, fundedNetworks: ['solana-devnet'], minAccountAgeDays: 0 };
      const svc = new BountyService({
        db, gh, x402: undefined as never, cfg, now,
        payoutSigner: {
          pay: async () => { throw new Error('a funded bounty must never be paid from the float'); },
          releaseEscrow: async (a) => { releases.push(a.terms); return { ok: true as const, signature: 'sig-release' }; },
        },
      });
      const [r] = await svc.onPullRequestClosed(REPO, 58);
      expect(r!.gate.pass).toBe(true);
      expect(r!.gate.checks.map((c) => c.name)).toContain('escrow_holds_funds');
      const view = await svc.payoutTerms(r!.payoutId);
      expect(view!.terms).toMatchObject({ recipient: wallet, escrow: escrowAddress, network: 'solana-devnet' });
      // No inference was bought for a review on someone else's escrow.
      expect(gh.reviews).toHaveLength(0);

      await svc.approvePayout(r!.payoutId, signApproval(view!.terms, approver.secretKey, approver.publicKey.toBase58(), clock));
      expect(releases).toHaveLength(1);
      const e = (await db.query('SELECT state, release_tx FROM bounty_escrows WHERE bounty_id = $1', [bountyId])).rows[0];
      expect(e).toEqual({ state: 'released', release_tx: 'sig-release' });
    });
  });

  describe('the chain wins', () => {
    it('an escrow cancelled before anybody was assigned cancels the bounty', async () => {
      const { bountyId, escrowAddress } = await fundedBounty();
      chain.accounts.delete(escrowAddress);
      expect(await funded.reconcile()).toEqual([{ bountyId, what: 'cancelled' }]);
      expect((await db.query('SELECT status FROM bounties WHERE id = $1', [bountyId])).rows[0].status).toBe('cancelled');
    });

    it('an escrow refunded with somebody assigned expires the bounty and releases them without an abandon', async () => {
      const { bountyId, escrowAddress } = await fundedBounty();
      await person(1, 'jotel-dev');
      await apply(bountyId, 1, 'jotel-dev');
      await funded.runDraw(bountyId, 'owen', false);
      chain.accounts.delete(escrowAddress);
      expect(await funded.reconcile()).toEqual([{ bountyId, what: 'refunded' }]);
      const a = (await db.query('SELECT status, counts_as_abandon FROM bounty_assignments WHERE bounty_id = $1', [bountyId])).rows[0];
      expect(a).toEqual({ status: 'released_voluntary', counts_as_abandon: false });
    });
  });
});
