// Produces a "/grainlify link ..." comment by signing with a Solana keypair
// file, for testing without a browser wallet. The keypair never leaves this process.
//
// Usage: pnpm tsx scripts/sign-link.ts <github-login> <keypair.json>

import { readFileSync } from 'node:fs';
import { publicKeyOf, signDetached } from '../packages/gate/src/ed25519.ts';
import { linkMessage } from '../packages/gate/src/link.ts';

const [login, keyPath] = process.argv.slice(2);
if (!login || !keyPath) {
  console.error('usage: pnpm tsx scripts/sign-link.ts <github-login> <keypair.json>');
  process.exit(2);
}
const secret = Uint8Array.from(JSON.parse(readFileSync(keyPath, 'utf8')) as number[]);
const wallet = publicKeyOf(secret);
const issuedAt = new Date().toISOString();
console.log(`/grainlify link ${wallet} ${signDetached(secret, linkMessage({ githubLogin: login, wallet, issuedAt }))} ${issuedAt}`);
