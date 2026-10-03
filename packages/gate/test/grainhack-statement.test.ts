import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { approvalMessage, signApproval, verifyApproval, type PayoutTerms } from '../src/approval.ts';
import {
  checkGrainhackTermsShape, GRAINHACK_APPROVAL_DOMAIN, signGrainhackApproval, verifyGrainhackApproval, type GrainhackTerms,
} from '../src/grainhack-approval.ts';
import { canonicalJson, statementSha256, verifyStatement } from '../src/grainhack-statement.ts';
import { resultsKey, signed, statement } from './grainhack-support.ts';

// Our own golden vector, until the backend publishes theirs for a cross-check.
// Key: Ed25519 seed 0x01..0x20. Signed message: UTF-8 of
// "grainlify-grainhack-results:v1\n" + STATEMENT. Signature and key in base64.
const VECTOR = {
  seedHex: '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20',
  pubkey: 'ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ=',
  statement:
    '{"computation_id":"9b2f4e6a-1c3d-4e5f-8a7b-6c5d4e3f2a1b","currency":"USDC","hackathon_id":"0d6e8a3c-7b1f-4c5e-9a2d-4e5f6a7b8c9d",' +
    '"hackathon_name":"GrainHack Test Event","issued_at":"2026-10-03T08:00:00Z","kind":"grainhack_results","lines":[' +
    '{"amount_minor":"4000000","github_user_id":101,"login":"alice","status":"payable"},' +
    '{"amount_minor":"3500000","github_user_id":202,"login":"bob","status":"held_kyc"},' +
    '{"amount_minor":"2500000","github_user_id":303,"login":"carol","status":"payable"}],' +
    '"network":"solana-devnet","pool":"contributor","pool_minor":"10000000","statement_id":"6f9a1c52-6a4e-4f4b-9b8e-1d2c3b4a5f60","supersedes":null,"v":1}',
  signature: '/r8tXPWjpvDEpFqiPd9qFaWl8wFwzrskRWEMzjxlMxsCGVfX6SGXgQUnzagsnAsliotoH3xNwWFPxFfYrhu3Cg==',
  sha256: '269b1485cee41394d882fd3b7728ac80e6a65ca036118136328784b0f7a9752d',
};

const key = resultsKey(Buffer.from(VECTOR.seedHex, 'hex'));

describe('GrainHack results statement', () => {
  it('reproduces the golden vector: canonical form, key, signature and sha256', () => {
    expect(key.pubkeyB64).toBe(VECTOR.pubkey);
    expect(canonicalJson(statement())).toBe(VECTOR.statement);
    expect(key.sign(VECTOR.statement)).toBe(VECTOR.signature);
    expect(statementSha256(VECTOR.statement)).toBe(VECTOR.sha256);
    const r = verifyStatement(VECTOR.statement, VECTOR.signature, VECTOR.pubkey);
    expect(r).toMatchObject({ ok: true, sha256: VECTOR.sha256, statement: { pool_minor: '10000000' } });
  });

  it('refuses a signature from another key, over other bytes, or in the wrong encoding', () => {
    const other = resultsKey(Buffer.alloc(32, 9));
    expect(verifyStatement(VECTOR.statement, other.sign(VECTOR.statement), VECTOR.pubkey)).toMatchObject({ ok: false, reason: expect.stringMatching(/signature/) });
    expect(verifyStatement(VECTOR.statement.replace('4000000', '4000001'), VECTOR.signature, VECTOR.pubkey)).toMatchObject({ ok: false });
    expect(verifyStatement(VECTOR.statement, Buffer.from(VECTOR.signature, 'base64').toString('hex'), VECTOR.pubkey)).toMatchObject({ ok: false });
    expect(verifyStatement(VECTOR.statement, VECTOR.signature, 'not-a-key')).toMatchObject({ ok: false });
    expect(verifyStatement(undefined, VECTOR.signature, VECTOR.pubkey)).toMatchObject({ ok: false });
  });

  it('refuses a correctly signed statement that is not in canonical form', () => {
    const pretty = JSON.stringify(statement(), null, 1);
    expect(verifyStatement(pretty, key.sign(pretty), VECTOR.pubkey)).toMatchObject({ ok: false, reason: 'statement is not in canonical form' });
    const unsorted = JSON.stringify(statement());
    expect(verifyStatement(unsorted, key.sign(unsorted), VECTOR.pubkey)).toMatchObject({ ok: false, reason: 'statement is not in canonical form' });
  });

  it('refuses correctly signed statements whose content breaks the contract', () => {
    const lines = statement().lines;
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ pool_minor: '10000001' }, /add up/],
      [{ lines: [lines[1], lines[0], lines[2]] }, /sorted/],
      [{ lines: [lines[0], lines[0], lines[2]] }, /sorted/],
      [{ lines: [{ ...lines[0], status: 'paid' }, lines[1], lines[2]] }, /status/],
      [{ lines: [{ ...lines[0], amount_minor: 4000000 }, lines[1], lines[2]] }, /amount_minor/],
      [{ lines: [{ ...lines[0], wallet: 'x' }, lines[1], lines[2]] }, /keys/],
      [{ network: 'base-sepolia' }, /network/],
      [{ pool: 'maintainer' }, /pool/],
      [{ v: 2 }, /version/],
      [{ kind: 'grainhack_other' }, /kind/],
      [{ statement_id: 'NOT-A-UUID' }, /statement_id/],
      [{ supersedes: '6f9a1c52-6a4e-4f4b-9b8e-1d2c3b4a5f60' }, /itself/],
      [{ issued_at: '2026-10-03 08:00' }, /issued_at/],
      [{ extra: true }, /keys/],
    ];
    for (const [over, why] of cases) {
      const s = signed(key, { ...statement(), ...over } as never);
      expect(verifyStatement(s.statement, s.signature, VECTOR.pubkey), JSON.stringify(over)).toMatchObject({ ok: false, reason: expect.stringMatching(why) });
    }
  });
});

describe('approval domains', () => {
  const approver = Keypair.generate();
  const addr = approver.publicKey.toBase58();
  const now = new Date('2026-10-03T09:00:00Z');
  const gh: GrainhackTerms = {
    payout_id: '11111111-2222-4333-8444-555555555555', statement_id: '6f9a1c52-6a4e-4f4b-9b8e-1d2c3b4a5f60', statement_sha256: VECTOR.sha256,
    hackathon_id: '0d6e8a3c-7b1f-4c5e-9a2d-4e5f6a7b8c9d', pool: 'contributor', github_user_id: 101, login: 'alice',
    recipient: Keypair.generate().publicKey.toBase58(), amount_minor: '4000000', currency: 'USDC', mint: Keypair.generate().publicKey.toBase58(), network: 'solana-devnet',
  };
  const bounty: PayoutTerms = {
    payout_id: 'p1', bounty_id: 'b1', repo: 'o/r', issue_number: 1, pr_number: 2, author_login: 'alice', recipient: gh.recipient, amount_minor: '4000000',
    currency: 'USDC', mint: gh.mint, network: 'solana-devnet',
  };

  it('keeps the bounty approval bytes exactly as they were', () => {
    const ordered = Object.fromEntries(Object.keys(bounty).sort().map((k) => [k, bounty[k as keyof PayoutTerms]]));
    const before = 'grainlify-payout-approval:v1\n' + JSON.stringify({ terms: ordered, approved_at: 'A', expires_at: 'E' });
    expect(approvalMessage(bounty, 'A', 'E')).toBe(before);
  });

  it('a GrainHack approval verifies only under its own domain, and a bounty approval only under its own', () => {
    const g = signGrainhackApproval(gh, approver.secretKey, addr, now);
    expect(verifyGrainhackApproval(g, [addr], now)).toEqual({ ok: true });
    expect(verifyApproval(g as never, [addr], now)).toMatchObject({ ok: false, reason: expect.stringMatching(/signature/) });
    const b = signApproval(bounty, approver.secretKey, addr, now);
    expect(verifyApproval(b, [addr], now)).toEqual({ ok: true });
    expect(verifyGrainhackApproval(b as never, [addr], now)).toMatchObject({ ok: false, reason: expect.stringMatching(/signature/) });
    expect(GRAINHACK_APPROVAL_DOMAIN).toBe('grainlify-grainhack-payout-approval:v1\n');
  });

  it('names a bounty approval for what it is, and refuses terms with missing or extra keys', () => {
    expect(checkGrainhackTermsShape(bounty)).toMatch(/bounty payout/);
    expect(checkGrainhackTermsShape(gh)).toBeNull();
    expect(checkGrainhackTermsShape({ ...gh, extra: 1 })).toMatch(/exactly/);
    expect(checkGrainhackTermsShape({ ...gh, github_user_id: '101' })).toMatch(/github_user_id/);
    expect(checkGrainhackTermsShape({ ...gh, amount_minor: '0' })).toMatch(/amount_minor/);
  });
});
