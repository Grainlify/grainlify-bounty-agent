import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  parseSessionActionMessage,
  SESSION_ADMIN_DOMAIN,
  SESSION_APPLY_DOMAIN,
  verifySessionAction,
} from '../src/session-action.ts';

const key = (() => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicB64: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64') };
})();

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const issued = new Date('2026-09-27T09:30:00Z');
const now = new Date('2026-09-27T09:32:00Z');

function message(a: { kind?: 'apply' | 'admin'; action?: string; login?: string; id?: number; subject?: string; nonce?: string; issued?: Date; ttlMs?: number }) {
  const at = a.issued ?? issued;
  return [
    `Grainlify: ${(a.kind ?? 'apply') === 'apply' ? 'apply for a bounty' : 'admin action'}`,
    `Action: ${a.action ?? 'apply'}`,
    `GitHub: ${a.login ?? 'Octocat'} (id ${a.id ?? 583231})`,
    `Subject: ${a.subject ?? 'b3f1a0be-27d4-4c85-9f9c-1a0be27d4c85'}`,
    `Nonce: ${a.nonce ?? randomBytes(16).toString('hex')}`,
    `Issued: ${iso(at)}`,
    `Expires: ${iso(new Date(at.getTime() + (a.ttlMs ?? 600_000)))}`,
  ].join('\n');
}
const signed = (msg: string, domain: string) => ({ message: msg, countersignature: sign(null, Buffer.from(domain + msg, 'utf8'), key.privateKey).toString('base64') });

describe('acting on behalf of a signed-in Grainlify user', () => {
  it('accepts a countersigned apply message', () => {
    const r = verifySessionAction(signed(message({}), SESSION_APPLY_DOMAIN), key.publicB64, 'apply', now);
    expect(r).toMatchObject({ ok: true, fields: { kind: 'apply', login: 'Octocat', githubUserId: 583231, action: 'apply' } });
  });

  it('accepts a countersigned admin message', () => {
    const msg = message({ kind: 'admin', action: 'run_draw' });
    expect(verifySessionAction(signed(msg, SESSION_ADMIN_DOMAIN), key.publicB64, 'admin', now)).toMatchObject({ ok: true, fields: { kind: 'admin', action: 'run_draw' } });
  });

  // The property the whole design rests on.
  it('an apply message cannot be presented as an admin one, even signed', () => {
    const msg = message({ kind: 'apply' });
    expect(verifySessionAction(signed(msg, SESSION_APPLY_DOMAIN), key.publicB64, 'admin', now)).toMatchObject({ ok: false, code: 'wrong_domain' });
  });

  it('an admin message cannot be presented as an apply one', () => {
    const msg = message({ kind: 'admin', action: 'set_setting' });
    expect(verifySessionAction(signed(msg, SESSION_ADMIN_DOMAIN), key.publicB64, 'apply', now)).toMatchObject({ ok: false, code: 'wrong_domain' });
  });

  it('a message signed under the wrong domain does not verify even with the right headline', () => {
    // Same bytes, same key, wrong prefix: this is what stops one signature
    // standing in for the other if the headline check is ever loosened.
    const msg = message({ kind: 'admin', action: 'run_draw' });
    expect(verifySessionAction(signed(msg, SESSION_APPLY_DOMAIN), key.publicB64, 'admin', now)).toMatchObject({ ok: false, code: 'bad_countersignature' });
  });

  it('refuses an unsigned or wrongly signed message', () => {
    const msg = message({});
    expect(verifySessionAction({ message: msg, countersignature: 'AA' }, key.publicB64, 'apply', now)).toMatchObject({ ok: false, code: 'bad_countersignature' });
    expect(verifySessionAction({ message: msg, countersignature: 123 }, key.publicB64, 'apply', now)).toMatchObject({ ok: false, code: 'malformed' });
  });

  it('refuses an expired message and one issued in the future', () => {
    const old = signed(message({ issued: new Date('2026-09-27T08:00:00Z') }), SESSION_APPLY_DOMAIN);
    expect(verifySessionAction(old, key.publicB64, 'apply', now)).toMatchObject({ ok: false, code: 'expired' });
    const future = signed(message({ issued: new Date('2026-09-27T11:00:00Z') }), SESSION_APPLY_DOMAIN);
    expect(verifySessionAction(future, key.publicB64, 'apply', now)).toMatchObject({ ok: false, code: 'not_yet_valid' });
  });

  it('refuses a window wider than the backend ever issues', () => {
    const wide = signed(message({ ttlMs: 24 * 3600_000 }), SESSION_APPLY_DOMAIN);
    expect(verifySessionAction(wide, key.publicB64, 'apply', now)).toMatchObject({ ok: false, code: 'bad_window' });
  });

  it('a subject cannot smuggle an extra line into the message', () => {
    expect(parseSessionActionMessage(message({ subject: 'x\nExpires: 2099-01-01T00:00:00Z' }))).toBeNull();
  });

  it('parses the exact string the backend writes, byte for byte', () => {
    const msg =
      'Grainlify: admin action\nAction: run_draw\nGitHub: Jagadeeshftw (id 583231)\nSubject: b3f1a0be-27d4-4c85-9f9c-1a0be27d4c85\nNonce: 3f9c1a0be27d4c853f9c1a0be27d4c85\nIssued: 2026-09-27T09:30:00Z\nExpires: 2026-09-27T09:40:00Z';
    expect(parseSessionActionMessage(msg)).toMatchObject({ kind: 'admin', action: 'run_draw', login: 'Jagadeeshftw', githubUserId: 583231 });
  });
});
