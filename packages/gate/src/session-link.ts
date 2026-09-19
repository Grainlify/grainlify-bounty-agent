// Linking a wallet from a signed-in Grainlify session.
//
// Grainlify (POST /me/bounty-wallet/challenge in Grainlify-Backend) writes the
// signed-in person's GitHub account, the wallet, a random nonce and a
// ten-minute expiry into a message and countersigns it with a key that exists
// only for this. The wallet then signs the same message. We hold only the
// public half of Grainlify's key, so:
//
//   - the countersignature proves Grainlify vouched for WHICH GitHub account;
//   - the wallet signature proves control of the wallet;
//   - the expiry and the single-use nonce (spent by the caller, atomically
//     with storing the link) stop a leaked pair from being replayed.
//
// Nothing here trusts the browser: every field we store comes out of the
// message both parties signed. The comment command (link.ts) is unchanged and
// remains the fallback.

import { createPublicKey, verify } from 'node:crypto';
import { isSolanaAddress, verifyDetached } from './ed25519.ts';

/** Prefix Grainlify signs before the message; must match bountyLinkDomain in the backend. */
export const SESSION_LINK_DOMAIN = 'grainlify-bounty-wallet-link:v1\n';
/** The backend issues ten-minute windows; anything wider was not issued by it. */
export const SESSION_LINK_MAX_WINDOW_MS = 10 * 60_000;
const CLOCK_SKEW_MS = 60_000;

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

// Exactly the six lines BountyLinkMessage writes, nothing before or after.
const MESSAGE = new RegExp(
  [
    '^Grainlify: link this wallet to my GitHub account',
    'GitHub: ([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})) \\(id ([1-9][0-9]{0,15})\\)',
    'Wallet: ([1-9A-HJ-NP-Za-km-z]{32,44})',
    'Nonce: ([0-9a-f]{32})',
    'Issued: (\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z)',
    'Expires: (\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z)$',
  ].join('\\n'),
);

export interface SessionLinkFields {
  login: string;
  githubUserId: number;
  wallet: string;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
}

export function parseSessionLinkMessage(message: string): SessionLinkFields | null {
  const m = MESSAGE.exec(message);
  if (!m) return null;
  const [, login, id, wallet, nonce, issued, expires] = m as unknown as string[];
  const githubUserId = Number(id);
  const issuedAt = new Date(issued!);
  const expiresAt = new Date(expires!);
  if (!Number.isSafeInteger(githubUserId) || Number.isNaN(issuedAt.getTime()) || Number.isNaN(expiresAt.getTime())) return null;
  if (!isSolanaAddress(wallet!)) return null;
  return { login: login!, githubUserId, wallet: wallet!, nonce: nonce!, issuedAt, expiresAt };
}

export type SessionLinkRefusal =
  | 'malformed'
  | 'bad_countersignature'
  | 'not_yet_valid'
  | 'expired'
  | 'bad_window'
  | 'bad_wallet_signature';

export type SessionLinkResult = { ok: true; fields: SessionLinkFields } | { ok: false; code: SessionLinkRefusal; reason: string };

export function verifySessionLink(
  input: { message: unknown; countersignature: unknown; walletSignature: unknown },
  countersignPublicKeyB64: string,
  now: Date,
): SessionLinkResult {
  const { message, countersignature, walletSignature } = input;
  if (typeof message !== 'string' || typeof countersignature !== 'string' || typeof walletSignature !== 'string') {
    return { ok: false, code: 'malformed', reason: 'message, countersignature and walletSignature are required' };
  }
  const fields = parseSessionLinkMessage(message);
  if (!fields) return { ok: false, code: 'malformed', reason: 'the message is not a Grainlify wallet-link message' };

  if (!verifyCountersignature(message, countersignature, countersignPublicKeyB64)) {
    return { ok: false, code: 'bad_countersignature', reason: 'Grainlify did not sign this message' };
  }
  const t = now.getTime();
  if (fields.issuedAt.getTime() > t + CLOCK_SKEW_MS) return { ok: false, code: 'not_yet_valid', reason: 'the message is issued in the future' };
  if (fields.expiresAt.getTime() - fields.issuedAt.getTime() > SESSION_LINK_MAX_WINDOW_MS || fields.expiresAt <= fields.issuedAt) {
    return { ok: false, code: 'bad_window', reason: 'the message has an impossible validity window' };
  }
  if (t > fields.expiresAt.getTime()) return { ok: false, code: 'expired', reason: 'the message expired; start again to get a fresh one' };
  if (!verifyDetached(fields.wallet, message, walletSignature)) {
    return { ok: false, code: 'bad_wallet_signature', reason: 'the wallet signature does not match this message and wallet' };
  }
  return { ok: true, fields };
}

function verifyCountersignature(message: string, sigB64: string, pubB64: string): boolean {
  try {
    const pub = Buffer.from(pubB64, 'base64');
    const sig = Buffer.from(sigB64, 'base64');
    if (pub.length !== 32 || sig.length !== 64) return false;
    const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, pub]), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(SESSION_LINK_DOMAIN + message, 'utf8'), key, sig);
  } catch {
    return false;
  }
}
