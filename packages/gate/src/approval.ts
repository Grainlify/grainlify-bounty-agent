// A human approval for one payout, signed with the approver's key.
//
// The approver key lives only on the approver's machine. The agent cannot
// produce an approval, and the payout signer refuses any payout that does not
// carry a valid one. The approval commits to every field that matters, so it
// cannot be replayed for a different recipient, amount, mint or bounty.

import { signDetached, verifyDetached } from './ed25519.ts';

export interface PayoutTerms {
  payout_id: string;
  bounty_id: string;
  repo: string;
  issue_number: number;
  pr_number: number;
  author_login: string;
  recipient: string;
  amount_minor: string; // decimal string: bigint-safe in JSON
  currency: string;
  mint: string;
  network: string;
  /**
   * The escrow account, for a maintainer-funded bounty. Absent on a payout
   * from the agent's own float. Covered by the signature like every other
   * field, so the payout signer can tell which of its two routes an approval
   * was given for.
   */
  escrow?: string;
}

export interface Approval {
  terms: PayoutTerms;
  approver: string;
  approved_at: string;
  expires_at: string;
  signature: string;
}

const PREFIX = 'grainlify-payout-approval:v1\n';
export const APPROVAL_TTL_MS = 60 * 60 * 1000;

/**
 * The signed envelope, shared by every kind of payout approval. The domain
 * prefix is what keeps one kind from being valid as another: a bounty approval
 * does not verify under the GrainHack domain, and the other way round.
 * Keys in a fixed order: the signed bytes must not depend on object construction.
 */
export function envelopeMessage(domain: string, terms: object, approvedAt: string, expiresAt: string): string {
  const t = terms as Record<string, unknown>;
  const ordered = Object.fromEntries(Object.keys(t).sort().map((k) => [k, t[k]]));
  return domain + JSON.stringify({ terms: ordered, approved_at: approvedAt, expires_at: expiresAt });
}

export interface Envelope<T> {
  terms: T;
  approver: string;
  approved_at: string;
  expires_at: string;
  signature: string;
}

export function signEnvelope<T extends object>(domain: string, terms: T, approverSecret64: Uint8Array, approverAddress: string, now: Date): Envelope<T> {
  const approved_at = now.toISOString();
  const expires_at = new Date(now.getTime() + APPROVAL_TTL_MS).toISOString();
  return { terms, approver: approverAddress, approved_at, expires_at, signature: signDetached(approverSecret64, envelopeMessage(domain, terms, approved_at, expires_at)) };
}

export type ApprovalCheck = { ok: true } | { ok: false; reason: string };

export function verifyEnvelope(domain: string, a: Envelope<object>, trustedApprovers: string[], now: Date): ApprovalCheck {
  if (!trustedApprovers.includes(a.approver)) return { ok: false, reason: `approver ${a.approver} is not trusted` };
  const exp = Date.parse(a.expires_at);
  if (Number.isNaN(exp) || exp <= now.getTime()) return { ok: false, reason: 'approval has expired' };
  if (exp - Date.parse(a.approved_at) > APPROVAL_TTL_MS) return { ok: false, reason: 'approval lifetime is longer than allowed' };
  if (!verifyDetached(a.approver, envelopeMessage(domain, a.terms, a.approved_at, a.expires_at), a.signature)) {
    return { ok: false, reason: 'approval signature does not verify' };
  }
  return { ok: true };
}

/** Keys in a fixed order: the signed bytes must not depend on object construction. */
export function approvalMessage(terms: PayoutTerms, approvedAt: string, expiresAt: string): string {
  return envelopeMessage(PREFIX, terms, approvedAt, expiresAt);
}

export function signApproval(terms: PayoutTerms, approverSecret64: Uint8Array, approverAddress: string, now: Date): Approval {
  return signEnvelope(PREFIX, terms, approverSecret64, approverAddress, now);
}

export function verifyApproval(a: Approval, trustedApprovers: string[], now: Date): ApprovalCheck {
  return verifyEnvelope(PREFIX, a, trustedApprovers, now);
}
