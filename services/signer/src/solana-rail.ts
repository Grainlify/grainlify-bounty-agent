// Real Solana mainnet USDC transfers for x402 payments.

import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from '@solana/web3.js';
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import bs58 from 'bs58';
import { signDetached, type PaymentRail, type TransferResult } from './rails.ts';

const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

/** A plain transfer_checked uses well under 10k compute units. */
const COMPUTE_UNIT_LIMIT = 10_000;
/** A small priority fee so payments land in 5 minutes without costing real money: 10k CU x 1000 microlamports = 10 lamports. */
const MICROLAMPORTS_PER_CU = 1_000;
/** Upper bound we reserve per payment: the 5000-lamport base fee, the priority fee, and slack. */
export const FEE_RESERVE_LAMPORTS = 10_000;

export class SolanaRail implements PaymentRail {
  readonly kind = 'solana' as const;
  private readonly kp: Keypair;
  private readonly conn: Connection;

  constructor(secret64: Uint8Array, rpcUrl: string) {
    this.kp = Keypair.fromSecretKey(secret64);
    this.conn = new Connection(rpcUrl, 'confirmed');
  }

  address() {
    return this.kp.publicKey.toBase58();
  }

  signMessage(message: string) {
    return signDetached(this.kp.secretKey, message);
  }

  async prepareUsdcTransfer(args: { to: string; amountMicro: number }) {
    const owner = this.kp.publicKey;
    const source = getAssociatedTokenAddressSync(USDC_MINT, owner);
    const dest = getAssociatedTokenAddressSync(USDC_MINT, new PublicKey(args.to), true);
    const { blockhash, lastValidBlockHeight } = await this.conn.getLatestBlockhash('confirmed');
    const tx = new Transaction({ feePayer: owner, blockhash, lastValidBlockHeight }).add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: MICROLAMPORTS_PER_CU }),
      createTransferCheckedInstruction(source, USDC_MINT, dest, owner, BigInt(args.amountMicro), 6),
    );
    tx.sign(this.kp);
    const signature = bs58.encode(tx.signature!);
    const raw = tx.serialize();
    return {
      signature,
      broadcast: async (): Promise<TransferResult> => {
        await this.conn.sendRawTransaction(raw, { preflightCommitment: 'confirmed', maxRetries: 5 });
        const conf = await this.conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
        if (conf.value.err) throw new Error(`transaction ${signature} failed on-chain: ${JSON.stringify(conf.value.err)}`);
        const txInfo = await this.conn.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
        return { signature, feeLamports: txInfo?.meta?.fee ?? FEE_RESERVE_LAMPORTS };
      },
    };
  }
}
