import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import bs58 from 'bs58';

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** Decodes a base58 (Solana/Phantom default) or base64 signature; null unless it is 64 bytes. */
export function decodeSignature(s: string): Buffer | null {
  for (const dec of [(x: string) => Buffer.from(bs58.decode(x)), (x: string) => Buffer.from(x, 'base64')]) {
    try {
      const b = dec(s);
      if (b.length === 64) return b;
    } catch {
      /* next encoding */
    }
  }
  return null;
}

export function isSolanaAddress(a: string): boolean {
  try {
    return bs58.decode(a).length === 32;
  } catch {
    return false;
  }
}

export function verifyDetached(addressB58: string, message: string, signature: string): boolean {
  const sig = decodeSignature(signature);
  if (!sig || !isSolanaAddress(addressB58)) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(bs58.decode(addressB58))]), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(message, 'utf8'), key, sig);
  } catch {
    return false;
  }
}

/** Signs with a 64-byte Solana secret key; returns base58. */
export function signDetached(secret64: Uint8Array, message: string): string {
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(secret64.slice(0, 32))]), format: 'der', type: 'pkcs8' });
  return bs58.encode(sign(null, Buffer.from(message, 'utf8'), key));
}

export function publicKeyOf(secret64: Uint8Array): string {
  return bs58.encode(secret64.slice(32));
}
