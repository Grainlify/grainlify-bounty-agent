import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  balanceEnvelope,
  bodyHash,
  decodeEnvelope,
  decodeQuoteHeader,
  encodeEnvelope,
  ProtocolError,
  selectUsdcRail,
  type Quote,
} from '../src/protocol.ts';

const recordedHeader = readFileSync(new URL('../../../fixtures/usepod/402-chat-completions.headers.txt', import.meta.url), 'utf8')
  .split('\n')
  .find((l) => l.toLowerCase().startsWith('payment-required:'))!
  .split(': ')[1]!
  .trim();

describe('decodeQuoteHeader', () => {
  it('decodes the quote the live gateway returned', () => {
    const q = decodeQuoteHeader(recordedHeader);
    expect(q.quote_id).toBe('24c7f4e2-e113-41c5-89df-52fb2f93681e');
    expect(q.accepts.map((a) => a.asset)).toEqual(['USDC', 'SOL', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913']);
    const usdc = q.accepts[0]!;
    expect(usdc.amount_microunits).toBe(35);
    expect(usdc.mode).toBe('cap-with-surplus-credit');
    expect(usdc.body_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a missing or malformed header', () => {
    expect(() => decodeQuoteHeader(null)).toThrow(ProtocolError);
    expect(() => decodeQuoteHeader('not base64 json')).toThrow(ProtocolError);
    expect(() => decodeQuoteHeader(Buffer.from('{"x":1}').toString('base64'))).toThrow(/quote_id/);
  });
});

describe('selectUsdcRail', () => {
  const path = '/proxy/x402/v1/chat/completions';
  const body = '{"model":"gpt-oss-120b","max_tokens":16,"messages":[]}';
  const quote = (over: Record<string, unknown> = {}): Quote => ({
    x402_version: 2,
    quote_id: 'q-1',
    accepts: [
      {
        quote_id: 'q-1', scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', pay_to: 'GXfqVnZENHzvim8rNN8TPwqxWXQe8EBbxhcEMYE8Z7BS',
        asset: 'USDC', amount_microunits: 12, path, body_hash: bodyHash('POST', path, body), ...over,
      },
    ],
  });
  const sent = { method: 'POST', path, body };

  it('accepts a quote bound to exactly the bytes we sent', () => {
    expect(selectUsdcRail(quote(), sent).amount_microunits).toBe(12);
  });

  it('refuses to pay an address that is not UsePod', () => {
    expect(() => selectUsdcRail(quote({ pay_to: 'Attacker1111111111111111111111111111111111' }), sent)).toThrow(/allowlist/);
  });

  it('refuses a quote for a different body', () => {
    expect(() => selectUsdcRail(quote(), { ...sent, body: body.replace('16', '17') })).toThrow(/body_hash/);
  });

  it('refuses a non-mainnet network, a zero amount, and a missing USDC rail', () => {
    expect(() => selectUsdcRail(quote({ network: 'solana:devnet' }), sent)).toThrow(/no Solana USDC rail/);
    expect(() => selectUsdcRail(quote({ amount_microunits: 0 }), sent)).toThrow(/positive/);
    expect(() => selectUsdcRail(quote({ asset: 'SOL' }), sent)).toThrow(/no Solana USDC rail/);
  });
});

describe('balance envelope', () => {
  it('puts the proof at the top level, where the live gateway reads it', () => {
    const rail = { quote_id: 'q-2', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', asset: 'USDC' as const, pay_to: 'x', scheme: 'exact', amount_microunits: 3 };
    const env = decodeEnvelope(encodeEnvelope(balanceEnvelope(rail, 'Wallet111', 'sig')));
    expect(env).toEqual({ quote_id: 'q-2', network: rail.network, asset: 'USDC', payer_wallet: 'Wallet111', scheme: 'balance', proof: 'sig' });
    expect(env).not.toHaveProperty('payload');
  });
});
