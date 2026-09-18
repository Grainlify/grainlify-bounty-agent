// Sets up a TEST USDC token on devnet or a local validator: a mint we control
// (6 decimals, no value), a funded payout float, and some SOL for fees.
// It refuses to run against mainnet.
//
// Usage: pnpm tsx scripts/test-usdc-setup.ts <rpc-url> <authority-keypair> <payout-float-pubkey> [state-file]

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token';

export async function setupTestUsdc(rpc: string, authority: Keypair, float: PublicKey, opts: { mint?: string; airdrop?: boolean; floatSol?: number; mintAmount?: bigint } = {}) {
  if (/mainnet/.test(rpc)) throw new Error('refusing to create test tokens against mainnet');
  const conn = new Connection(rpc, 'confirmed');
  if (opts.airdrop) {
    const sig = await conn.requestAirdrop(authority.publicKey, 10 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, 'confirmed');
  }
  const mint = opts.mint ? new PublicKey(opts.mint) : await createMint(conn, authority, authority.publicKey, null, 6);
  const ata = await getOrCreateAssociatedTokenAccount(conn, authority, mint, float);
  await mintTo(conn, authority, mint, ata.address, authority, opts.mintAmount ?? 1_000_000_000n); // 1,000 test USDC
  const floatSol = opts.floatSol ?? 0.2;
  if ((await conn.getBalance(float)) < floatSol * LAMPORTS_PER_SOL / 2) {
    await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: float, lamports: Math.round(floatSol * LAMPORTS_PER_SOL) })), [authority]);
  }
  return { mint: mint.toBase58(), floatAta: ata.address.toBase58() };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [rpc, authorityPath, floatPubkey, stateFile = 'data/test-usdc.json'] = process.argv.slice(2);
  if (!rpc || !authorityPath || !floatPubkey) {
    console.error('usage: pnpm tsx scripts/test-usdc-setup.ts <rpc-url> <authority-keypair> <payout-float-pubkey> [state-file]');
    process.exit(2);
  }
  const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(authorityPath, 'utf8')) as number[]));
  const prev = existsSync(stateFile) ? (JSON.parse(readFileSync(stateFile, 'utf8')) as { mint?: string; rpc?: string }) : {};
  const out = await setupTestUsdc(rpc, authority, new PublicKey(floatPubkey), { mint: prev.rpc === rpc ? prev.mint : undefined });
  writeFileSync(stateFile, JSON.stringify({ rpc, ...out }, null, 2));
  console.log(JSON.stringify({ rpc, ...out }, null, 2));
}
