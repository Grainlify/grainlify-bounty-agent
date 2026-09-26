import { describe, expect, it } from 'vitest';
import { SESSION_LINK_DOMAIN } from '../src/session-link.ts';
import { parseSessionReadMessage, SESSION_READ_DOMAIN, verifySessionRead } from '../src/session-read.ts';
import { countersign, grainlifyKey, linkMessage } from './session-support.ts';

const issued = new Date('2026-09-26T09:30:00Z');
const now = new Date('2026-09-26T09:32:00Z');

function readMessage(a: { login: string; id: number; issued: Date; ttlMs?: number; nonce?: string }) {
  const expires = new Date(a.issued.getTime() + (a.ttlMs ?? 10 * 60_000));
  const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return [
    'Grainlify: read my linked wallet',
    `GitHub: ${a.login} (id ${a.id})`,
    `Nonce: ${a.nonce ?? '3f9c1a0be27d4c853f9c1a0be27d4c85'}`,
    `Issued: ${iso(a.issued)}`,
    `Expires: ${iso(expires)}`,
  ].join('\n');
}
const req = (key: ReturnType<typeof grainlifyKey>, a: Parameters<typeof readMessage>[0]) => {
  const message = readMessage(a);
  return { message, countersignature: countersign(key, message, SESSION_READ_DOMAIN) };
};

describe('reading a wallet link from a Grainlify session', () => {
  const key = grainlifyKey();
  const ok = () => req(key, { login: 'Octocat', id: 583231, issued });

  // The exact string Grainlify-Backend's TestBountyReadMessage_Shape pins.
  it('parses the message the backend writes, byte for byte', () => {
    const msg =
      'Grainlify: read my linked wallet\nGitHub: Octocat (id 583231)\nNonce: 3f9c1a0be27d4c853f9c1a0be27d4c85\nIssued: 2026-09-26T09:30:00Z\nExpires: 2026-09-26T09:40:00Z';
    expect(parseSessionReadMessage(msg)).toMatchObject({ login: 'Octocat', githubUserId: 583231 });
  });

  it('accepts a countersigned, unexpired read challenge', () => {
    expect(verifySessionRead(ok(), key.publicB64, now)).toMatchObject({ ok: true, fields: { login: 'Octocat', githubUserId: 583231 } });
  });

  it('needs no wallet signature: reading your own link is not a privileged act', () => {
    // Deliberately absent from the input. If this ever starts failing, the
    // read path has grown a requirement it should not have.
    const r = verifySessionRead({ message: ok().message, countersignature: ok().countersignature }, key.publicB64, now);
    expect(r.ok).toBe(true);
  });

  it('refuses a message Grainlify did not sign', () => {
    const other = grainlifyKey();
    expect(verifySessionRead(ok(), other.publicB64, now)).toMatchObject({ ok: false, code: 'bad_countersignature' });
  });

  // The reason the two domains exist. Same key, same backend, different purpose.
  it('refuses a read challenge countersigned under the LINK domain', () => {
    const message = readMessage({ login: 'Octocat', id: 583231, issued });
    const wrong = { message, countersignature: countersign(key, message, SESSION_LINK_DOMAIN) };
    expect(verifySessionRead(wrong, key.publicB64, now)).toMatchObject({ ok: false, code: 'bad_countersignature' });
  });

  it('refuses a LINK message presented as a read, even correctly countersigned', () => {
    const message = linkMessage({ login: 'Octocat', id: 583231, wallet: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', issued });
    const asRead = { message, countersignature: countersign(key, message, SESSION_READ_DOMAIN) };
    expect(verifySessionRead(asRead, key.publicB64, now)).toMatchObject({ ok: false, code: 'malformed' });
  });

  it('refuses anything that is not exactly the five-line message', () => {
    const good = ok().message;
    for (const bad of [good + '\n', 'x' + good, good.replace(/Nonce: .*/, 'Nonce: NOTHEX'), good.replace(/\nExpires: .*/, ''), good.replace('Octocat', 'bad login!')]) {
      expect(verifySessionRead({ ...ok(), message: bad }, key.publicB64, now).ok).toBe(false);
    }
  });

  it('refuses an expired challenge and one issued in the future', () => {
    expect(verifySessionRead(ok(), key.publicB64, new Date('2026-09-26T09:41:00Z'))).toMatchObject({ ok: false, code: 'expired' });
    expect(verifySessionRead(ok(), key.publicB64, new Date('2026-09-26T09:20:00Z'))).toMatchObject({ ok: false, code: 'not_yet_valid' });
  });

  it('refuses a window wider than the backend ever issues', () => {
    const wide = req(key, { login: 'Octocat', id: 583231, issued, ttlMs: 60 * 60_000 });
    expect(verifySessionRead(wide, key.publicB64, now)).toMatchObject({ ok: false, code: 'bad_window' });
  });

  it('refuses a non-string message or countersignature', () => {
    expect(verifySessionRead({ message: 42, countersignature: 'x' }, key.publicB64, now)).toMatchObject({ ok: false, code: 'malformed' });
  });
});
