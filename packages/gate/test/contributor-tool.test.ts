// The standalone contributor tool must produce comments the agent accepts.

import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs tool, no type declarations
import { linkComment, linkMessage as toolMessage } from '../../../tools/grainlify-contributor.mjs';
import { linkMessage, parseAndVerifyLinkComment } from '../src/link.ts';

describe('tools/grainlify-contributor.mjs', () => {
  it('signs exactly the message the agent verifies', () => {
    const args = { githubLogin: 'Friend-Dev', wallet: 'W', issuedAt: '2026-09-20T00:00:00.000Z' };
    expect(toolMessage('Friend-Dev', 'W', args.issuedAt)).toBe(linkMessage(args));
  });

  it('produces a link comment the agent accepts for that GitHub account only', () => {
    const kp = Keypair.generate();
    const comment = linkComment(kp.secretKey, 'friend-dev') as string;
    expect(parseAndVerifyLinkComment(comment, 'friend-dev', new Date())).toMatchObject({ ok: true, wallet: kp.publicKey.toBase58() });
    expect(parseAndVerifyLinkComment(comment, 'someone-else', new Date())).toMatchObject({ ok: false });
  });
});
