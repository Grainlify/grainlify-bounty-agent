// The clock behind the automatic draw.
//
// It ticks every minute and asks the draw service which windows have closed.
// A minute rather than six hours on purpose: the tick is cheap (one indexed
// query when nothing is due), and a long tick means a service restarted at the
// wrong moment leaves a window hanging for hours. Nothing here decides
// anything - closeDueWindows() owns the rules, and it is the thing under test.
//
// The scheduler never throws into the event loop. A draw that fails is logged
// and retried on the next tick, because the alternative is an unhandled
// rejection taking down a service that is otherwise serving fine.

import type { DrawService } from './draw-service.ts';
import type { FundedService } from './funded-service.ts';

export const DRAW_TICK_MS = 60_000;

export function startDrawScheduler(draw: DrawService, tickMs = DRAW_TICK_MS, log = console.log, funded?: FundedService): { stop: () => void } {
  let running = false;
  const tick = async () => {
    // Skipping a tick rather than queueing one: a slow draw must not stack up
    // behind itself and run the same window twice.
    if (running) return;
    running = true;
    try {
      try {
        const r = await draw.closeDueWindows();
        if (r.drawn.length || r.extended.length || r.skipped.length || r.released.length) {
          log(`draw sweep: drawn=${r.drawn.length} extended=${r.extended.length} skipped=${r.skipped.length} released=${r.released.length}`);
        }
      } catch (e) {
        log(`draw sweep failed, will retry: ${e instanceof Error ? e.message : String(e)}`);
      }
      // Funded bounties have no clock of their own except two: a proposal to
      // unassign that nobody answered in seven days, and the chain changing
      // under us (a self-assign funder acting from their own wallet, or
      // taking the escrow back after its deadline). Separate from the draw
      // sweep so one failing never stops the other.
      if (funded) {
        try {
          const expired = await funded.expireProposals();
          const seen = await funded.reconcile();
          if (expired.length || seen.length) log(`funded sweep: accepted_by_silence=${expired.length} reconciled=${seen.map((x) => x.what).join(',')}`);
        } catch (e) {
          log(`funded sweep failed, will retry: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), tickMs);
  // Does not hold the process open by itself.
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
