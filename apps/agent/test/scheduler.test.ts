import { describe, expect, it, vi } from 'vitest';
import { startDrawScheduler } from '../src/scheduler.ts';

const svc = (impl: () => Promise<{ drawn: string[]; extended: string[]; skipped: string[] }>) =>
  ({ closeDueWindows: impl }) as unknown as Parameters<typeof startDrawScheduler>[0];

describe('the draw scheduler', () => {
  it('sweeps on every tick', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const s = startDrawScheduler(svc(async () => { calls++; return { drawn: [], extended: [], skipped: [] }; }), 1000, () => {});
    await vi.advanceTimersByTimeAsync(3500);
    s.stop();
    vi.useRealTimers();
    expect(calls).toBe(3);
  });

  it('skips a tick rather than stacking sweeps behind a slow one', async () => {
    // Two sweeps overlapping would run the same window twice.
    vi.useFakeTimers();
    let started = 0;
    const holder: { release?: () => void } = {};
    const s = startDrawScheduler(
      svc(async () => {
        started++;
        await new Promise<void>((r) => { holder.release = r; });
        return { drawn: [], extended: [], skipped: [] };
      }),
      1000,
      () => {},
    );
    await vi.advanceTimersByTimeAsync(3500);
    expect(started).toBe(1);
    holder.release?.();
    s.stop();
    vi.useRealTimers();
  });

  it('a failing sweep is logged and retried, never thrown into the event loop', async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    let calls = 0;
    const s = startDrawScheduler(
      svc(async () => { calls++; throw new Error('database is asleep'); }),
      1000,
      (l) => lines.push(l),
    );
    await vi.advanceTimersByTimeAsync(2500);
    s.stop();
    vi.useRealTimers();
    expect(calls).toBe(2);
    expect(lines[0]).toContain('database is asleep');
  });
});
