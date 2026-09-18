// Prints a wallet's SOL and USDC balances. Reads only a public address.

import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';

const address = process.argv[2];
if (!address) {
  console.error('usage: pnpm tsx scripts/wallet.ts <address>');
  process.exit(2);
}
const conn = new Connection(process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com', 'confirmed');
const owner = new PublicKey(address);
const usdcAta = getAssociatedTokenAddressSync(new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), owner);
const sol = (await conn.getBalance(owner)) / 1e9;
const usdc = await conn.getTokenAccountBalance(usdcAta).then((r) => r.value.uiAmountString ?? '0', () => 'no USDC account');
console.log(`${address}\n  SOL  ${sol}\n  USDC ${usdc} (${usdcAta.toBase58()})`);
