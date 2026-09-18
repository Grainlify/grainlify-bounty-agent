import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { signApproval, verifyApproval, type PayoutTerms } from '../src/approval.ts';
import { publicKeyOf, signDetached } from '../src/ed25519.ts';
import { linkMessage, parseAndVerifyLinkComment } from '../src/link.ts';

const now = new Date('2026-09-20T12:00:00Z');

describe('wallet link comments', () => {
  const kp = Keypair.generate();
  const wallet = kp.publicKey.toBase58();
  const issuedAt = '2026-09-20T11:00:00.000Z';
  const signed = (login: string, at = issuedAt) => signDetached(kp.secretKey, linkMessage({ githubLogin: login, wallet, issuedAt: at }));

  it('links when the comment author signed for their own login', () => {
    const r = parseAndVerifyLinkComment(`/grainlify link ${wallet} ${signed('Alice')} ${issuedAt}`, 'alice', now);
    expect(r).toMatchObject({ ok: true, wallet });
  });

  it('ignores comments that are not link commands', () => {
    expect(parseAndVerifyLinkComment('great PR! /grainlify is cool', 'alice', now)).toBeNull();
  });

  it("refuses a signature made for someone else's account", () => {
    const r = parseAndVerifyLinkComment(`/grainlify link ${wallet} ${signed('alice')} ${issuedAt}`, 'mallory', now);
    expect(r).toMatchObject({ ok: false });
  });

  it('refuses stale, future-dated, malformed and wrong-wallet links', () => {
    const old = '2026-09-18T00:00:00.000Z';
    expect(parseAndVerifyLinkComment(`/grainlify link ${wallet} ${signed('alice', old)} ${old}`, 'alice', now)).toMatchObject({ ok: false, reason: expect.stringMatching(/24 hours/) });
    const future = '2026-09-21T00:00:00.000Z';
    expect(parseAndVerifyLinkComment(`/grainlify link ${wallet} ${signed('alice', future)} ${future}`, 'alice', now)).toMatchObject({ ok: false, reason: expect.stringMatching(/future/) });
    expect(parseAndVerifyLinkComment(`/grainlify link notawallet ${signed('alice')} ${issuedAt}`, 'alice', now)).toMatchObject({ ok: false });
    const other = Keypair.generate().publicKey.toBase58();
    expect(parseAndVerifyLinkComment(`/grainlify link ${other} ${signed('alice')} ${issuedAt}`, 'alice', now)).toMatchObject({ ok: false });
  });
});

describe('payout approvals', () => {
  const approver = Keypair.generate();
  const approverAddr = publicKeyOf(approver.secretKey);
  const terms: PayoutTerms = {
    payout_id: 'p1', bounty_id: 'b1', repo: 'Grainlify/grainlify-agent-sandbox', issue_number: 3, pr_number: 7, author_login: 'contributor',
    recipient: Keypair.generate().publicKey.toBase58(), amount_minor: '20000000', currency: 'USDC', mint: 'Mint111', network: 'solana-devnet',
  };

  it('verifies an approval from a trusted approver', () => {
    const a = signApproval(terms, approver.secretKey, approverAddr, now);
    expect(verifyApproval(a, [approverAddr], now)).toEqual({ ok: true });
  });

  it('refuses an untrusted approver, an expired approval, and any altered term', () => {
    const a = signApproval(terms, approver.secretKey, approverAddr, now);
    expect(verifyApproval(a, ['Someone111'], now).ok).toBe(false);
    expect(verifyApproval(a, [approverAddr], new Date(now.getTime() + 2 * 3600_000)).ok).toBe(false);
    for (const [k, v] of [['recipient', Keypair.generate().publicKey.toBase58()], ['amount_minor', '50000000'], ['mint', 'Other'], ['network', 'solana-mainnet'], ['bounty_id', 'b2']] as const) {
      expect(verifyApproval({ ...a, terms: { ...a.terms, [k]: v } }, [approverAddr], now)).toMatchObject({ ok: false, reason: expect.stringMatching(/signature/) });
    }
  });

  it('refuses an approval whose lifetime was stretched', () => {
    const a = signApproval(terms, approver.secretKey, approverAddr, now);
    expect(verifyApproval({ ...a, expires_at: new Date(now.getTime() + 10 * 3600_000).toISOString() }, [approverAddr], now).ok).toBe(false);
  });
});
