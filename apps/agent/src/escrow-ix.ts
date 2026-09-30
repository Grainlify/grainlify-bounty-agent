// The escrow program's wire format: PDAs, instructions, account and event
// decoding.
//
// Written against @solana/web3.js rather than @coral-xyz/anchor on purpose.
// This repository's lockfile has already been rewritten once by a package
// manager upgrading itself, and Anchor's format is small enough to write out -
// an 8-byte discriminator followed by borsh. It lives here rather than in the
// tests so the product and the tests send the same bytes.
import { createHash } from 'node:crypto';
import {
  PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, TransactionInstruction,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

/** The deployed program. Devnet only for now; there is no mainnet deployment. */
export const PROGRAM_ID = new PublicKey(
  process.env.ESCROW_PROGRAM_ID ?? '6MXnJKEdt1YPUZoxT8LkhL7bVshB68o4mXJiSfD8spDA',
);

/** Anchor's instruction discriminator: sha256("global:<name>")[0..8]. */
const disc = (name: string) =>
  createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);

const u64 = (n: bigint | number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const i64 = (n: bigint | number) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };

export const escrowPda = (bountyId: Buffer) =>
  PublicKey.findProgramAddressSync([Buffer.from('escrow'), bountyId], PROGRAM_ID);
export const vaultPda = (escrow: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from('vault'), escrow.toBuffer()], PROGRAM_ID);

export const MODE_DRAW = 0, MODE_SELF = 1;

export function ixInitialize(a: {
  funder: PublicKey; escrow: PublicKey; vault: PublicKey; funderToken: PublicKey;
  mint: PublicKey; feeDestination: PublicKey; attestor: PublicKey;
  bountyId: Buffer; amount: bigint; feeBps: number; feeMinimum: bigint; deadline: number; mode: number;
}) {
  const data = Buffer.concat([
    disc('initialize'), a.bountyId, u64(a.amount), u16(a.feeBps), u64(a.feeMinimum), i64(a.deadline), Buffer.from([a.mode]),
  ]);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: a.funder, isSigner: true, isWritable: true },
      { pubkey: a.escrow, isSigner: false, isWritable: true },
      { pubkey: a.vault, isSigner: false, isWritable: true },
      { pubkey: a.funderToken, isSigner: false, isWritable: true },
      { pubkey: a.mint, isSigner: false, isWritable: false },
      { pubkey: a.feeDestination, isSigner: false, isWritable: false },
      { pubkey: a.attestor, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function ixAssign(a: { signer: PublicKey; escrow: PublicKey; contributor: PublicKey }) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: a.signer, isSigner: true, isWritable: false },
      { pubkey: a.escrow, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([disc('assign'), a.contributor.toBuffer()]),
  });
}

export function ixUnassign(a: { signer: PublicKey; escrow: PublicKey }) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: a.signer, isSigner: true, isWritable: false },
      { pubkey: a.escrow, isSigner: false, isWritable: true },
    ],
    data: disc('unassign'),
  });
}

export function ixRelease(a: {
  attestor: PublicKey; funder: PublicKey; escrow: PublicKey; vault: PublicKey;
  contributorToken: PublicKey; feeToken: PublicKey; mint: PublicKey; mergeCommit: Buffer;
}) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: a.attestor, isSigner: true, isWritable: false },
      // Not a signer: the rent goes back to whoever paid it, and the program
      // checks that against the escrow rather than trusting this key.
      { pubkey: a.funder, isSigner: false, isWritable: true },
      { pubkey: a.escrow, isSigner: false, isWritable: true },
      { pubkey: a.vault, isSigner: false, isWritable: true },
      { pubkey: a.contributorToken, isSigner: false, isWritable: true },
      { pubkey: a.feeToken, isSigner: false, isWritable: true },
      { pubkey: a.mint, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc('release'), a.mergeCommit]),
  });
}

function refundLike(name: 'refund' | 'cancel', a: {
  funder: PublicKey; escrow: PublicKey; vault: PublicKey; funderToken: PublicKey; mint: PublicKey;
}) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: a.funder, isSigner: true, isWritable: false },
      { pubkey: a.escrow, isSigner: false, isWritable: true },
      { pubkey: a.vault, isSigner: false, isWritable: true },
      { pubkey: a.funderToken, isSigner: false, isWritable: true },
      { pubkey: a.mint, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: disc(name),
  });
}
export const ixRefund = (a: Parameters<typeof refundLike>[1]) => refundLike('refund', a);
export const ixCancel = (a: Parameters<typeof refundLike>[1]) => refundLike('cancel', a);

export const STATE = ['Funded', 'Assigned', 'Released', 'Refunded'] as const;

/** Decode the Escrow account. Field order follows the struct in lib.rs. */
export function decodeEscrow(data: Buffer) {
  let o = 8;                                   // discriminator
  const bountyId = data.subarray(o, o + 16); o += 16;
  const funder = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const mint = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const amount = data.readBigUInt64LE(o); o += 8;
  const feeBps = data.readUInt16LE(o); o += 2;
  const feeMinimum = data.readBigUInt64LE(o); o += 8;
  const feeAmount = data.readBigUInt64LE(o); o += 8;
  const feeDestination = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const attestor = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const mode = data[o] ?? 0; o += 1;
  // A state byte outside the enum means the account is not what we think it is,
  // which is worth saying rather than indexing past the end of the list.
  const stateByte = data[o] ?? 255; o += 1;
  const hasContributor = data[o] ?? 0; o += 1;
  let contributor: PublicKey | null = null;
  if (hasContributor) { contributor = new PublicKey(data.subarray(o, o + 32)); o += 32; }
  const deadline = data.readBigInt64LE(o); o += 8;
  const hasCommit = data[o] ?? 0; o += 1;
  let mergeCommit: Buffer | null = null;
  if (hasCommit) { mergeCommit = Buffer.from(data.subarray(o, o + 20)); o += 20; }
  return { bountyId, funder, mint, amount, feeBps, feeMinimum, feeAmount, feeDestination, attestor,
    mode, state: STATE[stateByte] ?? `unknown(${stateByte})`, contributor, deadline, mergeCommit };
}

/** Anchor's event discriminator: sha256("event:<Name>")[0..8]. */
const eventDisc = (name: string) =>
  createHash('sha256').update(`event:${name}`).digest().subarray(0, 8);

/**
 * Read an event out of a transaction's logs.
 *
 * Once an escrow is released or refunded its account is closed and the rent
 * goes back to the funder, so the account can no longer be read for the
 * outcome. The event is where the record lives from then on - permanently, in
 * transaction history, which is the ledger this was always meant to be read
 * from.
 */
export function findEvent(logs: string[], name: string) {
  const want = eventDisc(name);
  for (const line of logs) {
    const m = /^Program data: (.+)$/.exec(line);
    if (!m?.[1]) continue;
    const buf = Buffer.from(m[1], 'base64');
    if (!buf.subarray(0, 8).equals(want)) continue;
    return buf.subarray(8);
  }
  return null;
}
