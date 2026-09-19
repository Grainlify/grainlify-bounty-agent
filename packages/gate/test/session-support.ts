// Test stand-in for Grainlify-Backend's POST /me/bounty-wallet/challenge:
// the same message shape (BountyLinkMessage) and the same domain-prefixed
// countersignature, made with a key the test owns.

import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { signDetached } from '../src/ed25519.ts';
import { SESSION_LINK_DOMAIN } from '../src/session-link.ts';

export function grainlifyKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicB64: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64') };
}

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

export function linkMessage(a: { login: string; id: number; wallet: string; nonce?: string; issued: Date; ttlMs?: number }) {
  return [
    'Grainlify: link this wallet to my GitHub account',
    `GitHub: ${a.login} (id ${a.id})`,
    `Wallet: ${a.wallet}`,
    `Nonce: ${a.nonce ?? randomBytes(16).toString('hex')}`,
    `Issued: ${iso(a.issued)}`,
    `Expires: ${iso(new Date(a.issued.getTime() + (a.ttlMs ?? 600_000)))}`,
  ].join('\n');
}

export function countersign(key: ReturnType<typeof grainlifyKey>, message: string, domain = SESSION_LINK_DOMAIN) {
  return sign(null, Buffer.from(domain + message, 'utf8'), key.privateKey).toString('base64');
}

/** A full request body as the browser would send it. */
export function linkRequest(key: ReturnType<typeof grainlifyKey>, wallet: Keypair, a: { login: string; id: number; issued: Date; nonce?: string; ttlMs?: number }) {
  const message = linkMessage({ ...a, wallet: wallet.publicKey.toBase58() });
  return { message, countersignature: countersign(key, message), walletSignature: signDetached(wallet.secretKey, message) };
}
