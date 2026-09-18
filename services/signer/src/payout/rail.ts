// SPL token transfers for bounty payouts (devnet test USDC in P2).

import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import bs58 from 'bs58';

export interface PayoutRail {
  address(): string;
  prepareTransfer(a: { mint: string; decimals: number; to: string; amountMinor: bigint }): Promise<{ signature: string; broadcast: () => Promise<void> }>;
}

export class SplPayoutRail implements PayoutRail {
  private readonly kp: Keypair;
  private readonly conn: Connection;

  constructor(secret64: Uint8Array, rpcUrl: string) {
    this.kp = Keypair.fromSecretKey(secret64);
    this.conn = new Connection(rpcUrl, 'confirmed');
  }

  address() {
    return this.kp.publicKey.toBase58();
  }

  async prepareTransfer(a: { mint: string; decimals: number; to: string; amountMinor: bigint }) {
    const mint = new PublicKey(a.mint);
    const owner = this.kp.publicKey;
    const recipient = new PublicKey(a.to);
    const source = getAssociatedTokenAddressSync(mint, owner);
    const dest = getAssociatedTokenAddressSync(mint, recipient, true);
    const { blockhash, lastValidBlockHeight } = await this.conn.getLatestBlockhash('confirmed');
    const tx = new Transaction({ feePayer: owner, blockhash, lastValidBlockHeight }).add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }),
      // Creates the recipient's token account if it does not exist yet; a no-op otherwise.
      createAssociatedTokenAccountIdempotentInstruction(owner, dest, recipient, mint),
      createTransferCheckedInstruction(source, mint, dest, owner, a.amountMinor, a.decimals),
    );
    tx.sign(this.kp);
    const signature = bs58.encode(tx.signature!);
    const raw = tx.serialize();
    return {
      signature,
      broadcast: async () => {
        await this.conn.sendRawTransaction(raw, { preflightCommitment: 'confirmed', maxRetries: 5 });
        const conf = await this.conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
        if (conf.value.err) throw new Error(`payout ${signature} failed on-chain: ${JSON.stringify(conf.value.err)}`);
      },
    };
  }
}
