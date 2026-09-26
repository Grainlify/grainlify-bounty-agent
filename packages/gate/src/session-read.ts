// Reading "which wallet is linked to my GitHub account".
//
// The counterpart to session-link.ts, and deliberately a separate module with
// a separate domain. Both are signed by the SAME Grainlify key, so the domain
// prefix is the only thing keeping a read challenge from standing in for a
// link instruction. A read message carries no wallet and no wallet signature:
// it proves who is asking, not that the asker controls a wallet. That is the
// right bar, because reading your own link is not a privileged act — but
// linking one is.
//
// The message shape is a contract with Grainlify-Backend's
// handlers.BountyReadMessage: change both or neither.

import { createPublicKey, verify } from 'node:crypto';

export const SESSION_READ_DOMAIN = 'grainlify-bounty-wallet-read:v1\n';
/** The backend issues ten-minute windows; anything wider was not issued by it. */
export const SESSION_READ_MAX_WINDOW_MS = 10 * 60_000;
const CLOCK_SKEW_MS = 60_000;
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

// Exactly the five lines BountyReadMessage writes. Note the absence of a
// Wallet line: a link message can therefore never parse as a read message,
// and a read message can never parse as a link message.
const MESSAGE = new RegExp(
  [
    '^Grainlify: read my linked wallet',
    'GitHub: ([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})) \\(id ([1-9][0-9]{0,15})\\)',
    'Nonce: ([0-9a-f]{32})',
    'Issued: (\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z)',
    'Expires: (\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z)$',
  ].join('\\n'),
);

export interface SessionReadFields {
  login: string;
  githubUserId: number;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
}

export function parseSessionReadMessage(message: string): SessionReadFields | null {
  const m = MESSAGE.exec(message);
  if (!m) return null;
  const [, login, id, nonce, issued, expires] = m as unknown as string[];
  const githubUserId = Number(id);
  const issuedAt = new Date(issued!);
  const expiresAt = new Date(expires!);
  if (!Number.isSafeInteger(githubUserId) || Number.isNaN(issuedAt.getTime()) || Number.isNaN(expiresAt.getTime())) return null;
  return { login: login!, githubUserId, nonce: nonce!, issuedAt, expiresAt };
}

export type SessionReadRefusal = 'malformed' | 'bad_countersignature' | 'not_yet_valid' | 'expired' | 'bad_window';
export type SessionReadResult = { ok: true; fields: SessionReadFields } | { ok: false; code: SessionReadRefusal; reason: string };

export function verifySessionRead(
  input: { message: unknown; countersignature: unknown },
  countersignPublicKeyB64: string,
  now: Date,
): SessionReadResult {
  const { message, countersignature } = input;
  if (typeof message !== 'string' || typeof countersignature !== 'string') {
    return { ok: false, code: 'malformed', reason: 'message and countersignature are required' };
  }
  const fields = parseSessionReadMessage(message);
  if (!fields) return { ok: false, code: 'malformed', reason: 'the message is not a Grainlify wallet-read message' };

  if (!verifyReadCountersignature(message, countersignature, countersignPublicKeyB64)) {
    return { ok: false, code: 'bad_countersignature', reason: 'Grainlify did not sign this message' };
  }
  const t = now.getTime();
  if (fields.issuedAt.getTime() > t + CLOCK_SKEW_MS) return { ok: false, code: 'not_yet_valid', reason: 'the message is issued in the future' };
  if (fields.expiresAt.getTime() - fields.issuedAt.getTime() > SESSION_READ_MAX_WINDOW_MS || fields.expiresAt <= fields.issuedAt) {
    return { ok: false, code: 'bad_window', reason: 'the message has an impossible validity window' };
  }
  if (t > fields.expiresAt.getTime()) return { ok: false, code: 'expired', reason: 'the message expired; ask for a fresh one' };
  return { ok: true, fields };
}

function verifyReadCountersignature(message: string, sigB64: string, pubB64: string): boolean {
  try {
    const pub = Buffer.from(pubB64, 'base64');
    const sig = Buffer.from(sigB64, 'base64');
    if (pub.length !== 32 || sig.length !== 64) return false;
    const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, pub]), format: 'der', type: 'spki' });
    // The read domain, never the link one.
    return verify(null, Buffer.from(SESSION_READ_DOMAIN + message, 'utf8'), key, sig);
  } catch {
    return false;
  }
}
