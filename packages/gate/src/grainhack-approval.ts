// A human approval for one GrainHack payout, signed on the approver's machine.
//
// The same envelope as a bounty approval (approval.ts) under a different
// domain, so an approval given for one can never be presented as the other:
// a bounty approval does not verify here and a GrainHack approval does not
// verify on the bounty route. One approval pays one winner; there is no batch.

import { signEnvelope, verifyEnvelope, type ApprovalCheck, type Envelope } from './approval.ts';
import { isSolanaAddress } from './ed25519.ts';

export const GRAINHACK_APPROVAL_DOMAIN = 'grainlify-grainhack-payout-approval:v1\n';

export interface GrainhackTerms {
  payout_id: string;
  statement_id: string;
  statement_sha256: string;
  hackathon_id: string;
  pool: string;
  github_user_id: number;
  login: string;
  recipient: string;
  amount_minor: string;
  currency: string;
  mint: string;
  network: string;
}

export type GrainhackApproval = Envelope<GrainhackTerms>;

export const GRAINHACK_TERM_KEYS = [
  'amount_minor', 'currency', 'github_user_id', 'hackathon_id', 'login', 'mint', 'network', 'payout_id', 'pool', 'recipient', 'statement_id', 'statement_sha256',
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Exactly these keys with these types; null when they are. A bounty
 * approval's terms (repo, bounty_id, pr_number...) fail here before anything
 * else is looked at, and say so.
 */
export function checkGrainhackTermsShape(t: unknown): string | null {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return 'missing approval terms';
  const o = t as Record<string, unknown>;
  if ('bounty_id' in o || 'repo' in o || 'escrow' in o) return 'this approval is for a bounty payout, not a GrainHack payout';
  const keys = Object.keys(o).sort();
  if (keys.length !== GRAINHACK_TERM_KEYS.length || keys.some((k, i) => k !== GRAINHACK_TERM_KEYS[i])) return `approval terms must be exactly ${GRAINHACK_TERM_KEYS.join(', ')}`;
  for (const k of ['payout_id', 'statement_id', 'hackathon_id'] as const) if (typeof o[k] !== 'string' || !UUID.test(o[k] as string)) return `${k} is not a uuid`;
  if (typeof o.statement_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(o.statement_sha256)) return 'statement_sha256 is not a sha256 hex digest';
  if (typeof o.github_user_id !== 'number' || !Number.isSafeInteger(o.github_user_id) || o.github_user_id <= 0) return 'github_user_id is not a positive integer';
  if (typeof o.amount_minor !== 'string' || !/^[1-9][0-9]{0,29}$/.test(o.amount_minor)) return 'amount_minor is not a positive decimal integer string';
  for (const k of ['pool', 'login', 'recipient', 'currency', 'mint', 'network'] as const) if (typeof o[k] !== 'string' || !(o[k] as string)) return `${k} is missing`;
  if (!isSolanaAddress(o.mint as string)) return 'mint is not a Solana address';
  return null;
}

export function signGrainhackApproval(terms: GrainhackTerms, approverSecret64: Uint8Array, approverAddress: string, now: Date): GrainhackApproval {
  return signEnvelope(GRAINHACK_APPROVAL_DOMAIN, terms, approverSecret64, approverAddress, now);
}

export function verifyGrainhackApproval(a: GrainhackApproval, trustedApprovers: string[], now: Date): ApprovalCheck {
  return verifyEnvelope(GRAINHACK_APPROVAL_DOMAIN, a, trustedApprovers, now);
}

/** Order-independent comparison of two sets of terms. */
export function sameGrainhackTerms(a: GrainhackTerms, b: GrainhackTerms): boolean {
  const canon = (t: GrainhackTerms) => JSON.stringify(Object.keys(t).sort().map((k) => [k, t[k as keyof GrainhackTerms]]));
  return canon(a) === canon(b);
}
