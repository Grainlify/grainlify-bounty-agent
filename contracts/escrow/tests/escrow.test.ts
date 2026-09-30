// The escrow, end to end on a local validator, including every way it can go
// wrong. This program holds other people's money: the refusals matter more
// than the happy path, so they come first.
import { describe, it, expect, beforeAll } from 'vitest';
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  createMint, createAssociatedTokenAccount, mintTo, getAccount, TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import {
  PROGRAM_ID, escrowPda, vaultPda, decodeEscrow, MODE_DRAW, MODE_SELF,
  ixInitialize, ixAssign, ixUnassign, ixRelease, ixRefund, ixCancel, findEvent,
} from './client.ts';

const RPC = process.env.ESCROW_RPC ?? 'http://127.0.0.1:8899';
const conn = new Connection(RPC, 'confirmed');
const DEC = 6;
const USDC = (n: number) => BigInt(Math.round(n * 10 ** DEC));

let payer: Keypair, mint: PublicKey, attestor: Keypair, feeOwner: Keypair, feeToken: PublicKey;

/** Devnet's faucet rate-limits, so there the SOL comes from the deployer. */
const ONCHAIN = !RPC.includes('127.0.0.1') && !RPC.includes('localhost');

const fund = async (kp: Keypair, sol = ONCHAIN ? 0.003 : 2) => {
  if (!ONCHAIN) {
    const sig = await conn.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, 'confirmed');
    return;
  }
  // Enough for rent on the accounts a test creates plus its fees, and no more:
  // this is real devnet SOL out of one wallet across two dozen tests.
  const lamports = Math.round(sol * LAMPORTS_PER_SOL);
  await sendAndConfirmTransaction(conn, new Transaction().add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: kp.publicKey, lamports }),
  ), [payer], { commitment: 'confirmed' });
};

/** The wallet that pays on devnet: the same one that deployed the program.
 *
 *  Read from the Solana CLI's configured keypair rather than assuming
 *  ~/.config/solana/id.json - this machine's config points somewhere else, and
 *  assuming the default quietly created an empty wallet and spent a test run
 *  discovering it. ESCROW_PAYER_KEYPAIR overrides. */
function deployerKey() {
  let path = process.env.ESCROW_PAYER_KEYPAIR;
  if (!path) {
    try {
      const cfg = execSync('solana config get', { encoding: 'utf8' });
      path = /Keypair Path:\s*(\S+)/.exec(cfg)?.[1];
    } catch { /* fall through to the default below */ }
  }
  path = path ?? `${homedir()}/.config/solana/id.json`;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
}

beforeAll(async () => {
  payer = ONCHAIN ? deployerKey() : Keypair.generate();
  if (!ONCHAIN) await fund(payer, 10);
  mint = await createMint(conn, payer, payer.publicKey, null, DEC);
  attestor = Keypair.generate(); await fund(attestor);
  feeOwner = Keypair.generate(); await fund(feeOwner);
  feeToken = await createAssociatedTokenAccount(conn, payer, mint, feeOwner.publicKey);
}, 120_000);

/** A funder with money, and an escrow funded from it. */
async function setup(o: { amount?: number; feeBps?: number; feeMin?: number; deadlineIn?: number; mode?: number } = {}) {
  const amount = USDC(o.amount ?? 50);
  const feeBps = o.feeBps ?? 250;
  const feeMinimum = USDC(o.feeMin ?? 0.25);
  // On a public RPC the round trip plus rate-limiting can eat ten seconds
  // between reading the clock and the transaction landing, so a deliberately
  // short deadline needs a much wider margin there than on a local validator.
  const requested = o.deadlineIn ?? 3600;
  const deadline = (await chainNow()) + (ONCHAIN && requested < 60 ? 45 : requested);
  const mode = o.mode ?? MODE_DRAW;

  const funder = Keypair.generate(); await fund(funder, ONCHAIN ? 0.011 : 2);
  const funderToken = await createAssociatedTokenAccount(conn, payer, mint, funder.publicKey);
  await mintTo(conn, payer, mint, funderToken, payer, Number(USDC(1000)));

  const bountyId = randomBytes(16);
  const [escrow] = escrowPda(bountyId);
  const [vault] = vaultPda(escrow);

  const tx = new Transaction().add(ixInitialize({
    funder: funder.publicKey, escrow, vault, funderToken, mint,
    feeDestination: feeToken, attestor: attestor.publicKey,
    bountyId, amount, feeBps, feeMinimum, deadline, mode,
  }));
  await sendAndConfirmTransaction(conn, tx, [funder], { commitment: 'confirmed' });
  return { funder, funderToken, bountyId, escrow, vault, amount, feeBps, deadline };
}

/** The chain's own clock.
 *
 *  The program compares the deadline against Clock::unix_timestamp, and on
 *  devnet that runs ahead of this machine's wall clock - enough that a deadline
 *  computed as Date.now()+2 arrived already expired and initialize refused it
 *  as DeadlineInPast. Everything to do with deadlines is measured against the
 *  chain from here. */
async function chainNow(): Promise<number> {
  const slot = await conn.getSlot('confirmed');
  const t = await conn.getBlockTime(slot);
  return t ?? Math.floor(Date.now() / 1000);
}

/** Wait until the chain's clock has passed `ts`. */
async function waitForChain(ts: number) {
  for (let i = 0; i < 60; i++) {
    if ((await chainNow()) > ts) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('the chain clock never passed the deadline');
}

const read = async (escrow: PublicKey) =>
  decodeEscrow(Buffer.from((await conn.getAccountInfo(escrow, 'confirmed'))!.data));

/** The logs of a confirmed transaction, for reading events out of. */
async function logsOf(sig: string) {
  const tx = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  return tx?.meta?.logMessages ?? [];
}

const balance = async (ata: PublicKey) => (await getAccount(conn, ata, 'confirmed')).amount;

async function contributorWith() {
  const kp = Keypair.generate(); await fund(kp);
  const ata = await createAssociatedTokenAccount(conn, payer, mint, kp.publicKey);
  return { kp, ata };
}

async function expectFail(p: Promise<unknown>, needle: RegExp) {
  let threw = false;
  try { await p; } catch (e) { threw = true; expect(String(e)).toMatch(needle); }
  expect(threw, 'the instruction was expected to be refused and was not').toBe(true);
}

describe('funding', () => {
  it('moves amount + fee into the vault and records the terms', async () => {
    const s = await setup({ amount: 50, feeBps: 250 });
    const e = await read(s.escrow);
    expect(e.state).toBe('Funded');
    expect(e.amount).toBe(USDC(50));
    // 2.5% of 50 = 1.25, charged ON TOP so the contributor still gets 50.
    expect(e.feeAmount).toBe(USDC(1.25));
    expect(await balance(s.vault)).toBe(USDC(51.25));
    expect(e.contributor).toBeNull();
  }, 60_000);

  it('refuses a fee above the ceiling the program will accept', async () => {
    await expectFail(setup({ feeBps: 1001 }), /FeeTooHigh|0x/);
  }, 60_000);

  it('refuses a deadline in the past', async () => {
    await expectFail(setup({ deadlineIn: -60 }), /DeadlineInPast|0x/);
  }, 60_000);
});

describe('who may assign', () => {
  it('in draw mode only the attestor can', async () => {
    const s = await setup({ mode: MODE_DRAW });
    const c = await contributorWith();
    await expectFail(
      sendAndConfirmTransaction(conn, new Transaction().add(
        ixAssign({ signer: s.funder.publicKey, escrow: s.escrow, contributor: c.kp.publicKey })), [s.funder]),
      /AttestorOnly|0x/,
    );
    await sendAndConfirmTransaction(conn, new Transaction().add(
      ixAssign({ signer: attestor.publicKey, escrow: s.escrow, contributor: c.kp.publicKey })), [attestor]);
    expect((await read(s.escrow)).contributor?.toBase58()).toBe(c.kp.publicKey.toBase58());
  }, 90_000);

  it('in self-assign mode only the funder can, and the attestor cannot', async () => {
    const s = await setup({ mode: MODE_SELF });
    const c = await contributorWith();
    await expectFail(
      sendAndConfirmTransaction(conn, new Transaction().add(
        ixAssign({ signer: attestor.publicKey, escrow: s.escrow, contributor: c.kp.publicKey })), [attestor]),
      /FunderOnly|0x/,
    );
    await sendAndConfirmTransaction(conn, new Transaction().add(
      ixAssign({ signer: s.funder.publicKey, escrow: s.escrow, contributor: c.kp.publicKey })), [s.funder]);
    expect((await read(s.escrow)).state).toBe('Assigned');
  }, 90_000);
});

describe('release', () => {
  it('pays the contributor the advertised amount and the fee separately', async () => {
    const s = await setup({ amount: 50, feeBps: 250 });
    const c = await contributorWith();
    const feeBefore = await balance(feeToken);
    await sendAndConfirmTransaction(conn, new Transaction().add(
      ixAssign({ signer: attestor.publicKey, escrow: s.escrow, contributor: c.kp.publicKey })), [attestor]);

    const commit = randomBytes(20);
    const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ixRelease({
      attestor: attestor.publicKey, funder: s.funder.publicKey, escrow: s.escrow, vault: s.vault,
      contributorToken: c.ata, feeToken, mint, mergeCommit: commit,
    })), [attestor]);

    // Exactly the advertised amount. The fee came from the funder, on top.
    expect(await balance(c.ata)).toBe(USDC(50));
    expect(await balance(feeToken)).toBe(feeBefore + USDC(1.25));

    // Both accounts are closed and their rent is back with the funder, so the
    // outcome is read from the event rather than from account state.
    expect(await conn.getAccountInfo(s.escrow, 'confirmed')).toBeNull();
    expect(await conn.getAccountInfo(s.vault, 'confirmed')).toBeNull();

    const ev = findEvent(await logsOf(sig), 'EscrowReleased');
    expect(ev, 'no EscrowReleased event in the logs').not.toBeNull();
    // escrow(32) contributor(32) amount(8) fee(8) merge_commit(20)
    expect(new PublicKey(ev!.subarray(32, 64)).toBase58()).toBe(c.kp.publicKey.toBase58());
    expect(ev!.readBigUInt64LE(64)).toBe(USDC(50));
    expect(ev!.subarray(80, 100).toString('hex')).toBe(commit.toString('hex'));
  }, 90_000);

  it('returns the rent on both accounts to the funder', async () => {
    const s = await setup();
    const c = await contributorWith();
    await sendAndConfirmTransaction(conn, new Transaction().add(
      ixAssign({ signer: attestor.publicKey, escrow: s.escrow, contributor: c.kp.publicKey })), [attestor]);
    const before = await conn.getBalance(s.funder.publicKey, 'confirmed');
    await sendAndConfirmTransaction(conn, new Transaction().add(ixRelease({
      attestor: attestor.publicKey, funder: s.funder.publicKey, escrow: s.escrow, vault: s.vault,
      contributorToken: c.ata, feeToken, mint, mergeCommit: randomBytes(20),
    })), [attestor]);
    const after = await conn.getBalance(s.funder.publicKey, 'confirmed');
    // ~0.0032 SOL across the escrow account and the vault. The funder paid it
    // at funding; leaving it stranded would be taking their money quietly.
    expect(after - before).toBeGreaterThan(0.003 * 1e9);
    expect(await conn.getAccountInfo(s.escrow, 'confirmed')).toBeNull();
    expect(await conn.getAccountInfo(s.vault, 'confirmed')).toBeNull();
  }, 90_000);

  it('the funder cannot release - that is the attestor\'s alone', async () => {
    const s = await setup();
    const c = await contributorWith();
    await sendAndConfirmTransaction(conn, new Transaction().add(
      ixAssign({ signer: attestor.publicKey, escrow: s.escrow, contributor: c.kp.publicKey })), [attestor]);
    await expectFail(
      sendAndConfirmTransaction(conn, new Transaction().add(ixRelease({
        attestor: s.funder.publicKey, funder: s.funder.publicKey, escrow: s.escrow, vault: s.vault,
        contributorToken: c.ata, feeToken, mint, mergeCommit: randomBytes(20),
      })), [s.funder]),
      /AttestorOnly|0x/,
    );
  }, 90_000);

  // The whole non-custodial claim rests on this: the attestor may release, but
  // only to the address recorded on the escrow.
  it('cannot be redirected to an address the attestor chooses', async () => {
    const s = await setup();
    const assigned = await contributorWith();
    const attacker = await contributorWith();
    await sendAndConfirmTransaction(conn, new Transaction().add(
      ixAssign({ signer: attestor.publicKey, escrow: s.escrow, contributor: assigned.kp.publicKey })), [attestor]);
    await expectFail(
      sendAndConfirmTransaction(conn, new Transaction().add(ixRelease({
        attestor: attestor.publicKey, funder: s.funder.publicKey, escrow: s.escrow, vault: s.vault,
        contributorToken: attacker.ata, feeToken, mint, mergeCommit: randomBytes(20),
      })), [attestor]),
      /WrongContributor|0x/,
    );
  }, 90_000);

  it('cannot send the fee somewhere other than the destination fixed at funding', async () => {
    const s = await setup();
    const c = await contributorWith();
    const elsewhere = await contributorWith();
    await sendAndConfirmTransaction(conn, new Transaction().add(
      ixAssign({ signer: attestor.publicKey, escrow: s.escrow, contributor: c.kp.publicKey })), [attestor]);
    await expectFail(
      sendAndConfirmTransaction(conn, new Transaction().add(ixRelease({
        attestor: attestor.publicKey, funder: s.funder.publicKey, escrow: s.escrow, vault: s.vault,
        contributorToken: c.ata, feeToken: elsewhere.ata, mint, mergeCommit: randomBytes(20),
      })), [attestor]),
      /WrongFeeDestination|0x/,
    );
  }, 90_000);

  it('refuses to release twice', async () => {
    const s = await setup();
    const c = await contributorWith();
    await sendAndConfirmTransaction(conn, new Transaction().add(
      ixAssign({ signer: attestor.publicKey, escrow: s.escrow, contributor: c.kp.publicKey })), [attestor]);
    const rel = () => sendAndConfirmTransaction(conn, new Transaction().add(ixRelease({
      attestor: attestor.publicKey, funder: s.funder.publicKey, escrow: s.escrow, vault: s.vault,
      contributorToken: c.ata, feeToken, mint, mergeCommit: randomBytes(20),
    })), [attestor]);
    await rel();
    await expectFail(rel(), /NotAssigned|0x/);
  }, 90_000);
});

describe('the funder getting their money back', () => {
  it('cancel returns everything while nobody is assigned', async () => {
    const s = await setup({ amount: 50, feeBps: 250 });
    const before = await balance(s.funderToken);
    await sendAndConfirmTransaction(conn, new Transaction().add(ixCancel({
      funder: s.funder.publicKey, escrow: s.escrow, vault: s.vault, funderToken: s.funderToken, mint,
    })), [s.funder]);
    expect(await balance(s.funderToken)).toBe(before + USDC(51.25));
    // Closed, so "Refunded" is the absence of the account plus the event.
    expect(await conn.getAccountInfo(s.escrow, 'confirmed')).toBeNull();
  }, 90_000);

  it('cancel is refused once somebody is assigned', async () => {
    const s = await setup();
    const c = await contributorWith();
    await sendAndConfirmTransaction(conn, new Transaction().add(
      ixAssign({ signer: attestor.publicKey, escrow: s.escrow, contributor: c.kp.publicKey })), [attestor]);
    await expectFail(
      sendAndConfirmTransaction(conn, new Transaction().add(ixCancel({
        funder: s.funder.publicKey, escrow: s.escrow, vault: s.vault, funderToken: s.funderToken, mint,
      })), [s.funder]),
      /NotOpen|AlreadyHasContributor|0x/,
    );
  }, 90_000);

  it('refund is refused before the deadline', async () => {
    const s = await setup({ deadlineIn: 3600 });
    await expectFail(
      sendAndConfirmTransaction(conn, new Transaction().add(ixRefund({
        funder: s.funder.publicKey, escrow: s.escrow, vault: s.vault, funderToken: s.funderToken, mint,
      })), [s.funder]),
      /DeadlineNotReached|0x/,
    );
  }, 90_000);

  // The property that makes the money the funder's rather than ours: after the
  // deadline they get it back with no attestation and nobody else's signature.
  it('refund works after the deadline with no attestor involvement, even while assigned', async () => {
    const s = await setup({ deadlineIn: 8 });
    const c = await contributorWith();
    await sendAndConfirmTransaction(conn, new Transaction().add(
      ixAssign({ signer: attestor.publicKey, escrow: s.escrow, contributor: c.kp.publicKey })), [attestor]);
    const before = await balance(s.funderToken);
    await waitForChain(s.deadline);
    await sendAndConfirmTransaction(conn, new Transaction().add(ixRefund({
      funder: s.funder.publicKey, escrow: s.escrow, vault: s.vault, funderToken: s.funderToken, mint,
    })), [s.funder]);
    expect(await balance(s.funderToken)).toBeGreaterThan(before);
    expect(await conn.getAccountInfo(s.escrow, 'confirmed')).toBeNull();
  }, 120_000);

  it('nobody but the funder can refund', async () => {
    const s = await setup({ deadlineIn: 8 });
    const stranger = await contributorWith();
    await waitForChain(s.deadline);
    await expectFail(
      sendAndConfirmTransaction(conn, new Transaction().add(ixRefund({
        funder: stranger.kp.publicKey, escrow: s.escrow, vault: s.vault, funderToken: stranger.ata, mint,
      })), [stranger.kp]),
      /FunderOnly|ConstraintTokenOwner|0x/,
    );
  }, 120_000);
});

describe('the assignee going quiet, and a rejected pull request', () => {
  it('unassign puts it back without paying, and it can be assigned again', async () => {
    const s = await setup();
    const first = await contributorWith();
    const second = await contributorWith();
    await sendAndConfirmTransaction(conn, new Transaction().add(
      ixAssign({ signer: attestor.publicKey, escrow: s.escrow, contributor: first.kp.publicKey })), [attestor]);
    await sendAndConfirmTransaction(conn, new Transaction().add(
      ixUnassign({ signer: attestor.publicKey, escrow: s.escrow })), [attestor]);

    const mid = await read(s.escrow);
    expect(mid.state).toBe('Funded');
    expect(mid.contributor).toBeNull();
    expect(await balance(s.vault)).toBe(USDC(51.25));   // nothing moved

    await sendAndConfirmTransaction(conn, new Transaction().add(
      ixAssign({ signer: attestor.publicKey, escrow: s.escrow, contributor: second.kp.publicKey })), [attestor]);
    expect((await read(s.escrow)).contributor?.toBase58()).toBe(second.kp.publicKey.toBase58());
  }, 120_000);

  it('a released escrow cannot be unassigned back into play', async () => {
    const s = await setup();
    const c = await contributorWith();
    await sendAndConfirmTransaction(conn, new Transaction().add(
      ixAssign({ signer: attestor.publicKey, escrow: s.escrow, contributor: c.kp.publicKey })), [attestor]);
    await sendAndConfirmTransaction(conn, new Transaction().add(ixRelease({
      attestor: attestor.publicKey, funder: s.funder.publicKey, escrow: s.escrow, vault: s.vault,
      contributorToken: c.ata, feeToken, mint, mergeCommit: randomBytes(20),
    })), [attestor]);
    await expectFail(
      sendAndConfirmTransaction(conn, new Transaction().add(
        ixUnassign({ signer: attestor.publicKey, escrow: s.escrow })), [attestor]),
      /NotAssigned|0x/,
    );
  }, 120_000);

  it('a refunded escrow cannot then be released', async () => {
    const s = await setup({ deadlineIn: 8 });
    const c = await contributorWith();
    await sendAndConfirmTransaction(conn, new Transaction().add(
      ixAssign({ signer: attestor.publicKey, escrow: s.escrow, contributor: c.kp.publicKey })), [attestor]);
    await waitForChain(s.deadline);
    await sendAndConfirmTransaction(conn, new Transaction().add(ixRefund({
      funder: s.funder.publicKey, escrow: s.escrow, vault: s.vault, funderToken: s.funderToken, mint,
    })), [s.funder]);
    await expectFail(
      sendAndConfirmTransaction(conn, new Transaction().add(ixRelease({
        attestor: attestor.publicKey, funder: s.funder.publicKey, escrow: s.escrow, vault: s.vault,
        contributorToken: c.ata, feeToken, mint, mergeCommit: randomBytes(20),
      })), [attestor]),
      /NotAssigned|0x/,
    );
  }, 120_000);
});

describe('the fee floor', () => {
  // 2.5% of a $1 bounty is 2.5c, against roughly 2.3c of cost per bounty. The
  // floor is what keeps the newcomer-sized bounties from running at a loss.
  it('charges the minimum when the percentage falls below it', async () => {
    const s = await setup({ amount: 1, feeBps: 250, feeMin: 0.25 });
    const e = await read(s.escrow);
    expect(e.amount).toBe(USDC(1));
    expect(e.feeAmount).toBe(USDC(0.25));        // not 0.025
    expect(await balance(s.vault)).toBe(USDC(1.25));
  }, 60_000);

  it('charges the percentage once it rises above the minimum', async () => {
    const s = await setup({ amount: 50, feeBps: 250, feeMin: 0.25 });
    const e = await read(s.escrow);
    expect(e.feeAmount).toBe(USDC(1.25));
    expect(e.feeMinimum).toBe(USDC(0.25));
  }, 60_000);

  // The crossover: 2.5% of $10 is exactly the 25c floor.
  it('takes the larger of the two at the crossover', async () => {
    const s = await setup({ amount: 10, feeBps: 250, feeMin: 0.25 });
    expect((await read(s.escrow)).feeAmount).toBe(USDC(0.25));
  }, 60_000);

  it('still pays the contributor exactly the advertised amount on a floored fee', async () => {
    const s = await setup({ amount: 1, feeBps: 250, feeMin: 0.25 });
    const c = await contributorWith();
    await sendAndConfirmTransaction(conn, new Transaction().add(
      ixAssign({ signer: attestor.publicKey, escrow: s.escrow, contributor: c.kp.publicKey })), [attestor]);
    const feeBefore = await balance(feeToken);
    await sendAndConfirmTransaction(conn, new Transaction().add(ixRelease({
      attestor: attestor.publicKey, funder: s.funder.publicKey, escrow: s.escrow, vault: s.vault,
      contributorToken: c.ata, feeToken, mint, mergeCommit: randomBytes(20),
    })), [attestor]);
    expect(await balance(c.ata)).toBe(USDC(1));
    expect(await balance(feeToken)).toBe(feeBefore + USDC(0.25));
  }, 90_000);
});

describe('a funder taking the money back out from under an open pull request', () => {
  // Written to prove a hole, not to pass. In self-assign mode the funder may
  // unassign on their own, and `cancel` only asks whether somebody is assigned
  // RIGHT NOW - so unassign-then-cancel returns the whole escrow instantly,
  // while a contributor has merged-ready work in an open pull request and no
  // deadline left to wait for.
  it('cannot unassign and then cancel straight back out', async () => {
    const s = await setup({ mode: MODE_SELF, deadlineIn: 3600 });
    const c = await contributorWith();
    await sendAndConfirmTransaction(conn, new Transaction().add(
      ixAssign({ signer: s.funder.publicKey, escrow: s.escrow, contributor: c.kp.publicKey })), [s.funder]);
    await sendAndConfirmTransaction(conn, new Transaction().add(
      ixUnassign({ signer: s.funder.publicKey, escrow: s.escrow })), [s.funder]);

    // The deadline is an hour away, so refund must still be refused - and
    // cancel has to be refused too, or the deadline protects nobody.
    await expectFail(
      sendAndConfirmTransaction(conn, new Transaction().add(ixCancel({
        funder: s.funder.publicKey, escrow: s.escrow, vault: s.vault, funderToken: s.funderToken, mint,
      })), [s.funder]),
      /AlreadyHasContributor|NotOpen|0x/,
    );
    expect(await balance(s.vault)).toBe(USDC(51.25));
  }, 120_000);
});
