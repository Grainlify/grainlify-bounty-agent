// How the signer actually moves money and signs messages. The keypair is
// loaded here and never leaves this process: nothing returns it, logs it, or
// sends it over the wire.

import { createPrivateKey, randomBytes, sign as edSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import bs58 from 'bs58';

export interface TransferResult {
  signature: string;
  /** Actual network fee in lamports, from the confirmed transaction. */
  feeLamports: number;
}

export interface PaymentRail {
  readonly kind: 'mock' | 'solana';
  address(): string;
  /** Detached ed25519 signature over utf8 `message`, base58. */
  signMessage(message: string): string;
  /**
   * Builds the transfer and returns its signature BEFORE broadcasting, so the
   * journal can record it first. `broadcast` then sends and waits for
   * confirmation.
   */
  prepareUsdcTransfer(args: { to: string; amountMicro: number }): Promise<{ signature: string; broadcast: () => Promise<TransferResult> }>;
}

/** A 64-byte Solana secret key (solana-keygen JSON format) as a Node KeyObject. */
export function loadSolanaKeypair(path: string): { secret: Uint8Array; publicKey: Uint8Array } {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as number[];
  if (!Array.isArray(raw) || raw.length !== 64) throw new Error(`${path} is not a 64-byte Solana keypair file`);
  const secret = Uint8Array.from(raw);
  return { secret, publicKey: secret.slice(32) };
}

function ed25519PrivateKey(seed32: Uint8Array) {
  // PKCS#8 DER prefix for a raw 32-byte ed25519 seed.
  const prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
  return createPrivateKey({ key: Buffer.concat([prefix, Buffer.from(seed32)]), format: 'der', type: 'pkcs8' });
}

export function signDetached(secret64: Uint8Array, message: string): string {
  return bs58.encode(edSign(null, Buffer.from(message, 'utf8'), ed25519PrivateKey(secret64.slice(0, 32))));
}

/**
 * Pays into the mock gateway's pretend chain. It uses a real ed25519 key, so
 * balance proofs verify exactly as they would against the real gateway.
 */
export class MockRail implements PaymentRail {
  readonly kind = 'mock' as const;
  private readonly secret: Uint8Array;
  private readonly pub: Uint8Array;

  constructor(private readonly mockBaseUrl: string, keypair?: { secret: Uint8Array; publicKey: Uint8Array }) {
    if (keypair) {
      this.secret = keypair.secret;
      this.pub = keypair.publicKey;
    } else {
      const { privateKey, publicKey } = generateEd25519();
      this.secret = privateKey;
      this.pub = publicKey;
    }
  }

  address() {
    return bs58.encode(this.pub);
  }

  signMessage(message: string) {
    return signDetached(this.secret, message);
  }

  async prepareUsdcTransfer(args: { to: string; amountMicro: number }) {
    const signature = bs58.encode(randomBytes(64));
    return {
      signature,
      broadcast: async (): Promise<TransferResult> => {
        const res = await fetch(`${this.mockBaseUrl}/__mock/chain/transfers`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ signature, from: this.address(), to: args.to, asset: 'USDC', amount_micro: args.amountMicro }),
        });
        if (!res.ok) throw new Error(`mock chain refused transfer: ${res.status} ${await res.text()}`);
        return { signature, feeLamports: 5_000 };
      },
    };
  }
}

function generateEd25519(): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const seed = randomBytes(32);
  const key = ed25519PrivateKey(seed);
  const jwk = key.export({ format: 'jwk' }) as { x: string };
  const pub = Buffer.from(jwk.x, 'base64url');
  return { privateKey: Uint8Array.from(Buffer.concat([seed, pub])), publicKey: Uint8Array.from(pub) };
}
