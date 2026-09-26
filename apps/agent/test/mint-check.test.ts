import { describe, expect, it, vi } from 'vitest';
import { assertMintsAgree, checkMintsAgainstSigner, compareMints } from '../src/mint-check.ts';

const USDC_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_DEVNET = 'DQNUbSmmakWcVKcdRXraNSgWdabZs5dMJyTVPFv21fNL';
const ANSEM = '9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump';

const agent = (mints: Record<string, { mint: string; decimals: number }>, network = 'solana-mainnet') => ({ network, mints });
const reply = (body: unknown, ok = true) => vi.fn().mockResolvedValue({ ok, json: async () => body }) as unknown as typeof fetch;

describe('comparing what the agent and the signer think they are paying', () => {
  it('agrees when both carry the same mints', () => {
    const both = { USDC: { mint: USDC_MAINNET, decimals: 6 }, ANSEM: { mint: ANSEM, decimals: 6 } };
    expect(compareMints(agent(both), agent(both))).toEqual([]);
  });

  // The exact mismatch that was live: the signer moved to mainnet USDC, the
  // agent kept the devnet mint, and the money sat in the right token next door.
  it('catches a devnet mint left on the agent while the signer is on mainnet', () => {
    const problems = compareMints(
      agent({ USDC: { mint: USDC_DEVNET, decimals: 6 } }),
      agent({ USDC: { mint: USDC_MAINNET, decimals: 6 } }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(USDC_DEVNET);
    expect(problems[0]).toContain(USDC_MAINNET);
  });

  it('catches a currency the agent can offer but the signer cannot pay', () => {
    const problems = compareMints(
      agent({ USDC: { mint: USDC_MAINNET, decimals: 6 }, ANSEM: { mint: ANSEM, decimals: 6 } }),
      agent({ USDC: { mint: USDC_MAINNET, decimals: 6 } }),
    );
    expect(problems).toEqual([expect.stringContaining('ANSEM')]);
  });

  // The other direction is fine: it only means that currency is not offered yet.
  it('does not complain when the signer knows a currency the agent does not offer', () => {
    expect(compareMints(
      agent({ USDC: { mint: USDC_MAINNET, decimals: 6 } }),
      agent({ USDC: { mint: USDC_MAINNET, decimals: 6 }, ANSEM: { mint: ANSEM, decimals: 6 } }),
    )).toEqual([]);
  });

  it('catches mismatched decimals, which would pay the wrong amount silently', () => {
    const problems = compareMints(
      agent({ USDC: { mint: USDC_MAINNET, decimals: 9 } }),
      agent({ USDC: { mint: USDC_MAINNET, decimals: 6 } }),
    );
    expect(problems).toEqual([expect.stringContaining('decimals')]);
  });

  it('catches the two services paying on different networks', () => {
    const m = { USDC: { mint: USDC_MAINNET, decimals: 6 } };
    expect(compareMints(agent(m, 'solana-mainnet'), agent(m, 'solana-devnet'))[0]).toContain('network');
  });
});

describe('the boot check', () => {
  const env = { PAYOUT_SIGNER_URL: 'http://signer:8788', PAYOUT_SIGNER_TOKEN: 't'.repeat(32) };

  it('passes and says what it is paying', async () => {
    const lines: string[] = [];
    const r = await assertMintsAgree(
      agent({ USDC: { mint: USDC_MAINNET, decimals: 6 } }),
      env,
      (l) => lines.push(l),
      reply({ network: 'solana-mainnet', mints: { USDC: { mint: USDC_MAINNET, decimals: 6 } } }),
    );
    expect(r.ok).toBe(true);
    // Which mint this service uses should be answerable from a log line.
    expect(lines.join('\n')).toContain(USDC_MAINNET);
    expect(lines.join('\n')).toContain('agent and payout signer agree');
  });

  it('refuses to boot on a mismatch', async () => {
    await expect(assertMintsAgree(
      agent({ USDC: { mint: USDC_DEVNET, decimals: 6 } }),
      env,
      () => {},
      reply({ network: 'solana-mainnet', mints: { USDC: { mint: USDC_MAINNET, decimals: 6 } } }),
    )).rejects.toThrow(/disagree about what they are paying/);
  });

  it('can be downgraded to a loud warning, but never to silence', async () => {
    const lines: string[] = [];
    const r = await assertMintsAgree(
      agent({ USDC: { mint: USDC_DEVNET, decimals: 6 } }),
      { ...env, MINT_MISMATCH: 'warn' },
      (l) => lines.push(l),
      reply({ network: 'solana-mainnet', mints: { USDC: { mint: USDC_MAINNET, decimals: 6 } } }),
    );
    expect(r.ok).toBe(false);
    expect(lines.filter((l) => l.startsWith('MINT MISMATCH'))).not.toHaveLength(0);
    expect(lines.join('\n')).toContain('keep the agent mint forever');
  });

  // A signer that is down or older than this check is a deployment to finish,
  // not a mismatch. It must not stop the agent serving the pages.
  it('boots, saying it could not verify, when the signer cannot be read', async () => {
    const lines: string[] = [];
    const r = await assertMintsAgree(
      agent({ USDC: { mint: USDC_MAINNET, decimals: 6 } }),
      env,
      (l) => lines.push(l),
      vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch,
    );
    expect(r).toMatchObject({ ok: true, unreachable: true });
    expect(lines.join('\n')).toContain('NOT verified against the signer');
  });

  it('treats a 404 from an older signer the same way', async () => {
    const r = await checkMintsAgainstSigner(agent({ USDC: { mint: USDC_MAINNET, decimals: 6 } }), 'http://s', 't', reply({}, false));
    expect(r).toMatchObject({ ok: true, unreachable: true });
  });

  it('skips when no payout signer is configured at all', async () => {
    const r = await assertMintsAgree(agent({}), {}, () => {}, reply({}));
    expect(r).toMatchObject({ ok: true, unreachable: true });
  });
});
