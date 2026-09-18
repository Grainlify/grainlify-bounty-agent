// Linking a GitHub account to a Solana wallet.
//
// The contributor signs a message with their wallet and posts it as a comment
// on an allowlisted repo:
//
//   /grainlify link <wallet> <signature> <issued-at ISO>
//
// GitHub proves who wrote the comment; the signature proves they control the
// wallet. We rebuild the message from the comment AUTHOR's login, so a
// signature made for someone else's account never verifies for yours.

import { isSolanaAddress, verifyDetached } from './ed25519.ts';

export const LINK_COMMAND = /^\/grainlify\s+link\s+(\S+)\s+(\S+)\s+(\S+)\s*$/m;
/** A signed link message is accepted for this long after it was issued. */
export const LINK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function linkMessage(args: { githubLogin: string; wallet: string; issuedAt: string }): string {
  return [
    'Grainlify bounty agent: link this wallet to my GitHub account',
    `GitHub: ${args.githubLogin.toLowerCase()}`,
    `Wallet: ${args.wallet}`,
    `Issued: ${args.issuedAt}`,
  ].join('\n');
}

export type LinkParse =
  | { ok: true; wallet: string; signature: string; issuedAt: string; message: string }
  | { ok: false; reason: string };

export function parseAndVerifyLinkComment(body: string, commentAuthorLogin: string, now: Date): LinkParse | null {
  const m = LINK_COMMAND.exec(body);
  if (!m) return null; // not a link command at all
  const [, wallet, signature, issuedAt] = m as unknown as [string, string, string, string];
  if (!isSolanaAddress(wallet)) return { ok: false, reason: 'that is not a Solana address' };
  const issued = Date.parse(issuedAt);
  if (Number.isNaN(issued)) return { ok: false, reason: 'the issued-at time is not a valid ISO timestamp' };
  if (issued > now.getTime() + 5 * 60_000) return { ok: false, reason: 'the issued-at time is in the future' };
  if (now.getTime() - issued > LINK_MAX_AGE_MS) return { ok: false, reason: 'the signed message is more than 24 hours old; sign a new one' };
  const message = linkMessage({ githubLogin: commentAuthorLogin, wallet, issuedAt });
  if (!verifyDetached(wallet, message, signature)) {
    return { ok: false, reason: `the signature does not verify for GitHub account ${commentAuthorLogin} and that wallet` };
  }
  return { ok: true, wallet, signature, issuedAt, message };
}
