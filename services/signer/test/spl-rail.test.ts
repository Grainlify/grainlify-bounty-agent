// The SPL rail without a validator: a fake connection that owns the mint with
// whichever token program the test says, and captures the raw transaction.

import { ComputeBudgetProgram, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { describe, expect, it } from 'vitest';
import { SplPayoutRail, type RailConnection } from '../src/payout/rail.ts';

function fakeConnection(mintOwner: PublicKey | null) {
  const sent: Buffer[] = [];
  const conn = {
    getAccountInfo: async () => (mintOwner ? { owner: mintOwner, data: Buffer.alloc(82), lamports: 1, executable: false } : null),
    getLatestBlockhash: async () => ({ blockhash: new PublicKey(Buffer.alloc(32, 7)).toBase58(), lastValidBlockHeight: 1234 }),
    sendRawTransaction: async (raw: Buffer) => {
      sent.push(Buffer.from(raw));
      return 'x';
    },
    confirmTransaction: async () => ({ context: { slot: 1 }, value: { err: null } }),
  } as unknown as RailConnection;
  return { conn, sent };
}

describe('SplPayoutRail token programs', () => {
  const float = Keypair.generate();
  const mint = Keypair.generate().publicKey;
  const to = Keypair.generate().publicKey;

  it('builds exactly the instructions it always built for a classic SPL mint', async () => {
    const { conn, sent } = fakeConnection(TOKEN_PROGRAM_ID);
    const t = await new SplPayoutRail(float.secretKey, conn).prepareTransfer({ mint: mint.toBase58(), decimals: 6, to: to.toBase58(), amountMinor: 4_000_000n });
    expect(t.lastValidBlockHeight).toBe(1234);
    await t.broadcast();
    const tx = Transaction.from(sent[0]!);
    // What the rail produced before it knew about Token-2022 (default program
    // ids), compiled to the same message: byte-identical.
    const src = getAssociatedTokenAddressSync(mint, float.publicKey);
    const dest = getAssociatedTokenAddressSync(mint, to, true);
    const before = new Transaction({ feePayer: float.publicKey, blockhash: tx.recentBlockhash!, lastValidBlockHeight: 1234 }).add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }),
      createAssociatedTokenAccountIdempotentInstruction(float.publicKey, dest, to, mint),
      createTransferCheckedInstruction(src, mint, dest, float.publicKey, 4_000_000n, 6),
    );
    expect(tx.serializeMessage().equals(before.serializeMessage())).toBe(true);
    expect(tx.instructions[0]!.data.readUInt32LE(1)).toBe(60_000);
    expect(tx.signature && tx.verifySignatures()).toBe(true);
  });

  it('addresses a Token-2022 mint to Token-2022, with its own associated accounts', async () => {
    const { conn, sent } = fakeConnection(TOKEN_2022_PROGRAM_ID);
    const t = await new SplPayoutRail(float.secretKey, conn).prepareTransfer({ mint: mint.toBase58(), decimals: 6, to: to.toBase58(), amountMinor: 5_000_000n });
    await t.broadcast();
    const tx = Transaction.from(sent[0]!);
    const [, create, transfer] = tx.instructions;
    const dest = getAssociatedTokenAddressSync(mint, to, true, TOKEN_2022_PROGRAM_ID);
    const src = getAssociatedTokenAddressSync(mint, float.publicKey, false, TOKEN_2022_PROGRAM_ID);
    expect(dest.equals(getAssociatedTokenAddressSync(mint, to, true))).toBe(false);
    expect(create!.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
    expect(create!.keys.map((k) => k.pubkey.toBase58())).toContain(TOKEN_2022_PROGRAM_ID.toBase58());
    expect(create!.keys[1]!.pubkey.equals(dest)).toBe(true);
    expect(transfer!.programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    expect(transfer!.keys[0]!.pubkey.equals(src)).toBe(true);
    expect(transfer!.keys[2]!.pubkey.equals(dest)).toBe(true);
    expect(tx.instructions[0]!.data.readUInt32LE(1)).toBe(120_000);
  });

  it('refuses before signing anything when the mint is missing or not a token mint', async () => {
    for (const owner of [null, Keypair.generate().publicKey]) {
      const { conn, sent } = fakeConnection(owner);
      await expect(new SplPayoutRail(float.secretKey, conn).prepareTransfer({ mint: mint.toBase58(), decimals: 6, to: to.toBase58(), amountMinor: 1n })).rejects.toThrow(/mint/);
      expect(sent).toHaveLength(0);
    }
  });
});
