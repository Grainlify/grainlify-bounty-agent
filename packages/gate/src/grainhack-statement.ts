// The GrainHack results statement: what Grainlify-Backend says each winner of
// an event is owed, signed with a key only the backend holds
// (GRAINHACK_RESULTS_SIGNING_KEY). This repository holds the public half
// (GRAINHACK_RESULTS_PUBKEY) and never takes the statement's word for anything
// it has not verified here.
//
// The format is a contract with the backend (drafts/grainhack-payout-contract.md
// §1): canonical JSON - keys sorted at every level, no whitespace, money as
// decimal strings - signed as UTF-8 of RESULTS_DOMAIN + canonical_json, Ed25519,
// base64 signature and base64 public key, the same encoding the backend's
// wallet-link countersignature uses (session-link.ts).
//
// Strict on purpose. A statement that is not byte-for-byte canonical, has a key
// this version does not know, or whose lines do not add up to its pool is
// refused rather than interpreted: the signer pays from this document.

import { createHash, createPublicKey, verify } from 'node:crypto';

export const RESULTS_DOMAIN = 'grainlify-grainhack-results:v1\n';
export const STATEMENT_NETWORKS = ['solana-devnet', 'solana-mainnet'] as const;
export const STATEMENT_POOLS = ['contributor'] as const;

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MINOR = /^(0|[1-9][0-9]{0,29})$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

export type LineStatus = 'payable' | 'held_kyc';

export interface StatementLine {
  github_user_id: number;
  login: string;
  amount_minor: string;
  status: LineStatus;
}

export interface ResultsStatement {
  v: 1;
  kind: 'grainhack_results';
  statement_id: string;
  supersedes: string | null;
  hackathon_id: string;
  hackathon_name: string;
  pool: string;
  computation_id: string;
  currency: string;
  network: string;
  pool_minor: string;
  lines: StatementLine[];
  issued_at: string;
}

/** JSON.stringify with object keys sorted at every level and no whitespace. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') {
    const s = JSON.stringify(v);
    if (s === undefined) throw new Error('canonicalJson: value has no JSON form');
    return s;
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

export function statementSha256(statementJson: string): string {
  return createHash('sha256').update(statementJson, 'utf8').digest('hex');
}

export function resultsMessage(statementJson: string): string {
  return RESULTS_DOMAIN + statementJson;
}

const TOP_KEYS = ['computation_id', 'currency', 'hackathon_id', 'hackathon_name', 'issued_at', 'kind', 'lines', 'network', 'pool', 'pool_minor', 'statement_id', 'supersedes', 'v'];
const LINE_KEYS = ['amount_minor', 'github_user_id', 'login', 'status'];
const sameKeys = (o: object, keys: string[]) => {
  const k = Object.keys(o).sort();
  return k.length === keys.length && k.every((x, i) => x === keys[i]);
};

/** Shape and arithmetic only; no signature. Returns the reason it is refused, or null. */
export function checkStatementShape(s: unknown): string | null {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return 'statement is not an object';
  const o = s as Record<string, unknown>;
  if (!sameKeys(o, TOP_KEYS)) return `statement keys are not exactly ${TOP_KEYS.join(', ')}`;
  if (o.v !== 1) return 'statement version is not 1';
  if (o.kind !== 'grainhack_results') return 'statement kind is not grainhack_results';
  for (const k of ['statement_id', 'hackathon_id', 'computation_id'] as const) {
    if (typeof o[k] !== 'string' || !UUID.test(o[k] as string)) return `${k} is not a lowercase uuid`;
  }
  if (o.supersedes !== null && (typeof o.supersedes !== 'string' || !UUID.test(o.supersedes))) return 'supersedes is neither null nor a uuid';
  if (o.supersedes === o.statement_id) return 'a statement cannot supersede itself';
  if (typeof o.hackathon_name !== 'string' || !o.hackathon_name.trim() || o.hackathon_name.length > 200) return 'hackathon_name is missing';
  if (!STATEMENT_POOLS.includes(o.pool as never)) return `pool ${String(o.pool)} is not one this version pays`;
  if (typeof o.currency !== 'string' || !/^[A-Z][A-Z0-9]{1,9}$/.test(o.currency)) return 'currency is malformed';
  if (!STATEMENT_NETWORKS.includes(o.network as never)) return `network ${String(o.network)} is not a statement network`;
  if (typeof o.pool_minor !== 'string' || !MINOR.test(o.pool_minor)) return 'pool_minor is not a decimal integer string';
  if (typeof o.issued_at !== 'string' || !RFC3339_UTC.test(o.issued_at) || Number.isNaN(Date.parse(o.issued_at))) return 'issued_at is not RFC3339 UTC';
  if (!Array.isArray(o.lines)) return 'lines is not an array';
  let sum = 0n;
  let prev = 0;
  for (const [i, l] of (o.lines as unknown[]).entries()) {
    if (!l || typeof l !== 'object' || Array.isArray(l) || !sameKeys(l, LINE_KEYS)) return `line ${i}: keys are not exactly ${LINE_KEYS.join(', ')}`;
    const line = l as Record<string, unknown>;
    if (typeof line.github_user_id !== 'number' || !Number.isSafeInteger(line.github_user_id) || line.github_user_id <= 0) return `line ${i}: github_user_id is not a positive integer`;
    if (line.github_user_id <= prev) return `line ${i}: lines are not sorted by github_user_id ascending, or repeat one`;
    prev = line.github_user_id;
    if (typeof line.login !== 'string' || !LOGIN.test(line.login)) return `line ${i}: login is not a GitHub login`;
    if (typeof line.amount_minor !== 'string' || !MINOR.test(line.amount_minor)) return `line ${i}: amount_minor is not a decimal integer string`;
    if (line.status !== 'payable' && line.status !== 'held_kyc') return `line ${i}: status ${String(line.status)} is not payable or held_kyc`;
    sum += BigInt(line.amount_minor);
  }
  if (sum !== BigInt(o.pool_minor)) return `lines add up to ${sum}, not pool_minor ${o.pool_minor}`;
  return null;
}

export type StatementCheck =
  | { ok: true; statement: ResultsStatement; sha256: string }
  | { ok: false; reason: string };

/**
 * Verifies the backend's signature over the exact statement string, then that
 * the string is the canonical form of what it parses to, then its shape.
 * `statementJson` is used byte for byte; it is never re-serialised for signing.
 */
export function verifyStatement(statementJson: unknown, signatureB64: unknown, resultsPubkeyB64: string): StatementCheck {
  if (typeof statementJson !== 'string' || typeof signatureB64 !== 'string') return { ok: false, reason: 'statement and statement_signature must be strings' };
  if (!verifyResultsSignature(statementJson, signatureB64, resultsPubkeyB64)) return { ok: false, reason: 'statement signature does not verify against the results key' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(statementJson);
  } catch {
    return { ok: false, reason: 'statement is not JSON' };
  }
  let canon: string;
  try {
    canon = canonicalJson(parsed);
  } catch {
    return { ok: false, reason: 'statement has no canonical form' };
  }
  if (canon !== statementJson) return { ok: false, reason: 'statement is not in canonical form' };
  const bad = checkStatementShape(parsed);
  if (bad) return { ok: false, reason: bad };
  return { ok: true, statement: parsed as ResultsStatement, sha256: statementSha256(statementJson) };
}

function verifyResultsSignature(statementJson: string, sigB64: string, pubB64: string): boolean {
  try {
    const pub = Buffer.from(pubB64, 'base64');
    const sig = Buffer.from(sigB64, 'base64');
    if (pub.length !== 32 || sig.length !== 64) return false;
    const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, pub]), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(resultsMessage(statementJson), 'utf8'), key, sig);
  } catch {
    return false;
  }
}

/** Is `s` a valid base64 Ed25519 public key? For config checks at boot. */
export function isResultsPubkey(s: string | undefined): boolean {
  return typeof s === 'string' && Buffer.from(s, 'base64').length === 32;
}

export function lineFor(s: ResultsStatement, githubUserId: number): StatementLine | undefined {
  return s.lines.find((l) => l.github_user_id === githubUserId);
}
