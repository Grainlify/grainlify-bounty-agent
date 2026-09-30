// The quote the funding screen shows has to be the amount the chain charges.
// Two implementations of the same arithmetic is exactly the shape of bug that
// shows up as "you were charged more than it said", so these pin the TS side
// against the cases the on-chain tests cover.
import { describe, expect, it } from 'vitest';
import { quote } from '../src/escrow-service.ts';

const USDC = (n: number) => BigInt(Math.round(n * 1e6));
const FLOOR = USDC(0.25);

describe('what the funder pays', () => {
  it('charges the fee on top, so the contributor gets the advertised amount', () => {
    const q = quote(USDC(50), 250, FLOOR);
    expect(q.amountMinor).toBe(USDC(50));
    expect(q.feeAmountMinor).toBe(USDC(1.25));
    expect(q.totalMinor).toBe(USDC(51.25));
    expect(q.flooredByMinimum).toBe(false);
  });

  // The on-chain test `charges the minimum when the percentage falls below it`
  // asserts the same numbers against the program.
  it('applies the floor under the percentage', () => {
    const q = quote(USDC(1), 250, FLOOR);
    expect(q.feeAmountMinor).toBe(USDC(0.25));
    expect(q.totalMinor).toBe(USDC(1.25));
    expect(q.flooredByMinimum).toBe(true);
    // 25% of a $1 bounty - the number the screen has to show before signing.
    expect(q.effectiveRate).toBeCloseTo(0.25, 6);
  });

  it('takes the larger of the two at the crossover', () => {
    // 2.5% of $10 is exactly the 25c floor.
    expect(quote(USDC(10), 250, FLOOR).feeAmountMinor).toBe(USDC(0.25));
    expect(quote(USDC(10.01), 250, FLOOR).feeAmountMinor).toBeGreaterThan(USDC(0.25));
  });

  it('rounds the percentage up, as the program does', () => {
    // 2.5% of 3.333333 is 0.08333..., which must not round down to the
    // platform's disadvantage.
    const q = quote(USDC(3.333333), 250, 0n);
    expect(q.feeAmountMinor).toBe(83334n);
  });

  it('refuses a zero or negative amount rather than quoting one', () => {
    expect(() => quote(0n, 250, FLOOR)).toThrow(/greater than zero/);
    expect(() => quote(-1n, 250, FLOOR)).toThrow(/greater than zero/);
  });

  it('a zero fee is a legitimate quote, not a floor of nothing', () => {
    const q = quote(USDC(50), 0, 0n);
    expect(q.feeAmountMinor).toBe(0n);
    expect(q.totalMinor).toBe(USDC(50));
  });

  it('the effective rate is what a funder is actually charged, not the headline', () => {
    expect(quote(USDC(2), 250, FLOOR).effectiveRate).toBeCloseTo(0.125, 6);
    expect(quote(USDC(1000), 250, FLOOR).effectiveRate).toBeCloseTo(0.025, 6);
  });
});
