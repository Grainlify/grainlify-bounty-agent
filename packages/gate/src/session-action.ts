// Acting on behalf of a signed-in Grainlify user: applying for a bounty, and
// the admin actions behind the draw controls.
//
// Third in the family after session-link.ts and session-read.ts, and built the
// same way for the same reason. The browser cannot be allowed to say who it
// is - a wallet extension sits in the middle of every request it makes, and
// more to the point a page can claim any login it likes. So Grainlify-Backend,
// which is the only service that knows who is signed in, writes a short
// message naming the person and the action and signs it with the bounty link
// key. This agent holds only the public half.
//
// Two domains, not one. An apply message signed for a contributor must never
// be usable to change a draw weight, so the domain prefix - not a field inside
// the message - is what separates them. A message signed under the apply
// domain simply does not verify under the admin domain.
//
// The message shape is a contract with Grainlify-Backend's
// handlers.BountyActionMessage: change both or neither.

import { createPublicKey, verify } from 'node:crypto';

export const SESSION_APPLY_DOMAIN = 'grainlify-bounty-apply:v1\n';
export const SESSION_ADMIN_DOMAIN = 'grainlify-bounty-admin:v1\n';
export const SESSION_ACTION_MAX_WINDOW_MS = 10 * 60_000;
const CLOCK_SKEW_MS = 60_000;
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

// Six lines. Subject carries what the action is about - a bounty id, a setting
// key - and is constrained here rather than left free-text, so nothing a
// caller writes can add a line to the message.
const MESSAGE = new RegExp(
  [
    '^Grainlify: (apply for a bounty|admin action)',
    'Action: ([a-z][a-z0-9_]{0,63})',
    'GitHub: ([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})) \\(id ([1-9][0-9]{0,15})\\)',
    'Subject: ([A-Za-z0-9_.:-]{0,128})',
    'Nonce: ([0-9a-f]{32})',
    'Issued: (\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z)',
    'Expires: (\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z)$',
  ].join('\\n'),
);

export interface SessionActionFields {
  kind: 'apply' | 'admin';
  action: string;
  login: string;
  githubUserId: number;
  subject: string;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
}

export function parseSessionActionMessage(message: string): SessionActionFields | null {
  const m = MESSAGE.exec(message);
  if (!m) return null;
  const [, headline, action, login, id, subject, nonce, issued, expires] = m as unknown as string[];
  const githubUserId = Number(id);
  const issuedAt = new Date(issued!);
  const expiresAt = new Date(expires!);
  if (!Number.isSafeInteger(githubUserId) || Number.isNaN(issuedAt.getTime()) || Number.isNaN(expiresAt.getTime())) return null;
  return {
    kind: headline === 'apply for a bounty' ? 'apply' : 'admin',
    action: action!,
    login: login!,
    githubUserId,
    subject: subject!,
    nonce: nonce!,
    issuedAt,
    expiresAt,
  };
}

export type SessionActionRefusal = 'malformed' | 'bad_countersignature' | 'not_yet_valid' | 'expired' | 'bad_window' | 'wrong_domain';
export type SessionActionResult = { ok: true; fields: SessionActionFields } | { ok: false; code: SessionActionRefusal; reason: string };

/**
 * @param expect which domain the caller requires. An apply endpoint passes
 *   'apply' and an admin endpoint passes 'admin'; neither ever accepts both,
 *   which is what makes the separation real rather than advisory.
 */
export function verifySessionAction(
  input: { message: unknown; countersignature: unknown },
  countersignPublicKeyB64: string,
  expect: 'apply' | 'admin',
  now: Date,
): SessionActionResult {
  const { message, countersignature } = input;
  if (typeof message !== 'string' || typeof countersignature !== 'string') {
    return { ok: false, code: 'malformed', reason: 'message and countersignature are required' };
  }
  const fields = parseSessionActionMessage(message);
  if (!fields) return { ok: false, code: 'malformed', reason: 'the message is not a Grainlify bounty action message' };
  // Checked before the signature so a message of the wrong kind is refused as
  // the wrong kind, rather than as a bad signature - they need different
  // answers, and conflating them has cost a round of diagnosis before.
  if (fields.kind !== expect) {
    return { ok: false, code: 'wrong_domain', reason: `this is ${fields.kind === 'apply' ? 'an apply' : 'an admin'} message; this endpoint needs ${expect === 'apply' ? 'an apply' : 'an admin'} one` };
  }
  const domain = expect === 'apply' ? SESSION_APPLY_DOMAIN : SESSION_ADMIN_DOMAIN;
  if (!verifyCountersignature(domain, message, countersignature, countersignPublicKeyB64)) {
    return { ok: false, code: 'bad_countersignature', reason: 'Grainlify did not sign this message for this purpose' };
  }
  const t = now.getTime();
  if (fields.issuedAt.getTime() > t + CLOCK_SKEW_MS) return { ok: false, code: 'not_yet_valid', reason: 'the message is issued in the future' };
  if (fields.expiresAt.getTime() - fields.issuedAt.getTime() > SESSION_ACTION_MAX_WINDOW_MS || fields.expiresAt <= fields.issuedAt) {
    return { ok: false, code: 'bad_window', reason: 'the message has an impossible validity window' };
  }
  if (t > fields.expiresAt.getTime()) return { ok: false, code: 'expired', reason: 'the message expired; try again' };
  return { ok: true, fields };
}

function verifyCountersignature(domain: string, message: string, sigB64: string, pubB64: string): boolean {
  try {
    const pub = Buffer.from(pubB64, 'base64');
    const sig = Buffer.from(sigB64, 'base64');
    if (pub.length !== 32 || sig.length !== 64) return false;
    const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, pub]), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(domain + message, 'utf8'), key, sig);
  } catch {
    return false;
  }
}
