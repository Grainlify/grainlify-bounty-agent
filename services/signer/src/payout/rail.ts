// SPL token transfers for bounty payouts (devnet test USDC in P2), and for
// GrainHack payouts from their own float.

import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import bs58 from 'bs58';

export interface PayoutRail {
  address(): string;
  prepareTransfer(a: { mint: string; decimals: number; to: string; amountMinor: bigint }): Promise<{
    signature: string;
    /** After this block height the transaction can never land. Lets a person resolve an unknown outcome. */
    lastValidBlockHeight?: number;
    broadcast: () => Promise<void>;
  }>;
}

/** What the rail needs from an RPC connection; a real Connection, or a fake in tests. */
export type RailConnection = Pick<Connection, 'getAccountInfo' | 'getLatestBlockhash' | 'sendRawTransaction' | 'confirmTransaction'>;

/**
 * Which token program owns a mint. A mint made by the classic SPL Token
 * program and one made by Token-2022 (ANSEM, like other recent pump.fun mints)
 * have different associated token accounts and need their instructions
 * addressed to their own program; using the classic program for a Token-2022
 * mint derives an account that does not exist and the transfer fails.
 */
export async function tokenProgramFor(conn: Pick<Connection, 'getAccountInfo'>, mint: PublicKey): Promise<PublicKey> {
  const info = await conn.getAccountInfo(mint, 'confirmed');
  if (!info) throw new Error(`mint ${mint.toBase58()} does not exist on this network`);
  if (info.owner.equals(TOKEN_PROGRAM_ID) || info.owner.equals(TOKEN_2022_PROGRAM_ID)) return info.owner;
  throw new Error(`mint ${mint.toBase58()} is owned by ${info.owner.toBase58()}, not a token program`);
}

export class SplPayoutRail implements PayoutRail {
  private readonly kp: Keypair;
  private readonly conn: RailConnection;

  constructor(secret64: Uint8Array, rpc: string | RailConnection) {
    this.kp = Keypair.fromSecretKey(secret64);
    this.conn = typeof rpc === 'string' ? new Connection(rpc, 'confirmed') : rpc;
  }

  address() {
    return this.kp.publicKey.toBase58();
  }

  async prepareTransfer(a: { mint: string; decimals: number; to: string; amountMinor: bigint }) {
    const mint = new PublicKey(a.mint);
    const owner = this.kp.publicKey;
    const recipient = new PublicKey(a.to);
    const programId = await tokenProgramFor(this.conn, mint);
    const source = getAssociatedTokenAddressSync(mint, owner, false, programId);
    const dest = getAssociatedTokenAddressSync(mint, recipient, true, programId);
    const { blockhash, lastValidBlockHeight } = await this.conn.getLatestBlockhash('confirmed');
    const tx = new Transaction({ feePayer: owner, blockhash, lastValidBlockHeight }).add(
      // Token-2022 account creation costs more compute than the classic program's.
      ComputeBudgetProgram.setComputeUnitLimit({ units: programId.equals(TOKEN_PROGRAM_ID) ? 60_000 : 120_000 }),
      // Creates the recipient's token account if it does not exist yet; a no-op otherwise.
      createAssociatedTokenAccountIdempotentInstruction(owner, dest, recipient, mint, programId),
      createTransferCheckedInstruction(source, mint, dest, owner, a.amountMinor, a.decimals, [], programId),
    );
    tx.sign(this.kp);
    const signature = bs58.encode(tx.signature!);
    const raw = tx.serialize();
    return {
      signature,
      lastValidBlockHeight,
      broadcast: async () => {
        await this.conn.sendRawTransaction(raw, { preflightCommitment: 'confirmed', maxRetries: 5 });
        const conf = await this.conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
        if (conf.value.err) throw new Error(`payout ${signature} failed on-chain: ${JSON.stringify(conf.value.err)}`);
      },
    };
  }
}
