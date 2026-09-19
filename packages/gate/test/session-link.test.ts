import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { signDetached } from '../src/ed25519.ts';
import { parseSessionLinkMessage, verifySessionLink } from '../src/session-link.ts';
import { countersign, grainlifyKey, linkMessage, linkRequest } from './session-support.ts';

const now = new Date('2026-09-19T14:05:00Z');
const issued = new Date('2026-09-19T14:02:11Z');

describe('wallet link from a Grainlify session', () => {
  const key = grainlifyKey();
  const wallet = Keypair.generate();
  const ok = () => linkRequest(key, wallet, { login: 'Octocat', id: 583231, issued });

  // The exact string Grainlify-Backend's TestBountyLinkMessage_Shape pins.
  it('parses the message the backend writes, byte for byte', () => {
    const msg =
      'Grainlify: link this wallet to my GitHub account\nGitHub: Octocat (id 583231)\nWallet: TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA\nNonce: 3f9c1a0be27d4c853f9c1a0be27d4c85\nIssued: 2026-09-19T14:02:11Z\nExpires: 2026-09-19T14:12:11Z';
    expect(parseSessionLinkMessage(msg)).toMatchObject({ login: 'Octocat', githubUserId: 583231, wallet: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', nonce: '3f9c1a0be27d4c853f9c1a0be27d4c85' });
  });

  it('accepts a countersigned, wallet-signed, unexpired message', () => {
    const r = verifySessionLink(ok(), key.publicB64, now);
    expect(r).toMatchObject({ ok: true, fields: { login: 'Octocat', githubUserId: 583231, wallet: wallet.publicKey.toBase58() } });
  });

  it('refuses anything that is not exactly the six-line message', () => {
    const good = ok().message;
    for (const bad of [good + '\n', 'x' + good, good.replace('Nonce: ', 'Nonce:'), good.replace(/Nonce: .*/, 'Nonce: NOTHEX'), good.replace(/\nExpires: .*/, ''), good.replace('Octocat', 'bad login!')]) {
      const r = verifySessionLink({ ...ok(), message: bad }, key.publicB64, now);
      expect(r).toMatchObject({ ok: false, code: 'malformed' });
    }
    expect(verifySessionLink({ message: 1, countersignature: null, walletSignature: undefined }, key.publicB64, now)).toMatchObject({ ok: false, code: 'malformed' });
  });

  it('refuses a message Grainlify did not countersign', () => {
    const r = ok();
    expect(verifySessionLink(r, grainlifyKey().publicB64, now)).toMatchObject({ ok: false, code: 'bad_countersignature' }); // another key
    expect(verifySessionLink({ ...r, countersignature: countersign(key, r.message, '') }, key.publicB64, now)).toMatchObject({ ok: false, code: 'bad_countersignature' }); // no domain
    expect(verifySessionLink({ ...r, countersignature: 'AAAA' }, key.publicB64, now)).toMatchObject({ ok: false, code: 'bad_countersignature' });
    // Swapping the GitHub account after Grainlify signed breaks it, even with a fresh wallet signature.
    const swapped = r.message.replace('Octocat (id 583231)', 'mallory (id 1)');
    expect(verifySessionLink({ ...r, message: swapped, walletSignature: signDetached(wallet.secretKey, swapped) }, key.publicB64, now)).toMatchObject({ ok: false, code: 'bad_countersignature' });
  });

  it('refuses expired, not-yet-valid and over-long windows', () => {
    expect(verifySessionLink(ok(), key.publicB64, new Date('2026-09-19T14:12:12Z'))).toMatchObject({ ok: false, code: 'expired' });
    expect(verifySessionLink(ok(), key.publicB64, new Date('2026-09-19T14:00:00Z'))).toMatchObject({ ok: false, code: 'not_yet_valid' });
    const long = linkRequest(key, wallet, { login: 'Octocat', id: 583231, issued, ttlMs: 20 * 60_000 });
    expect(verifySessionLink(long, key.publicB64, now)).toMatchObject({ ok: false, code: 'bad_window' });
  });

  it('refuses a wallet signature from another key or over another message', () => {
    const r = ok();
    expect(verifySessionLink({ ...r, walletSignature: signDetached(Keypair.generate().secretKey, r.message) }, key.publicB64, now)).toMatchObject({ ok: false, code: 'bad_wallet_signature' });
    expect(verifySessionLink({ ...r, walletSignature: signDetached(wallet.secretKey, linkMessage({ login: 'Octocat', id: 583231, wallet: wallet.publicKey.toBase58(), issued })) }, key.publicB64, now)).toMatchObject({ ok: false, code: 'bad_wallet_signature' });
  });
});
