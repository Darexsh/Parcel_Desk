import { onTestFinished, vi } from 'vitest';

/** Real event-loop turns given to a lookup between two timers, so it reaches its next await. */
const TURNS = 3;
/** More timers than any lookup's budget schedules: a loop past it is a test that never settles. */
const MAX_TIMERS = 1_000;

export interface BudgetClock {
  /** Fires the faked timers in order until `pending` settles, then returns it. */
  settle<T>(pending: Promise<T>): Promise<T>;
}

/**
 * Puts the current test's lookup budgets on Vitest's fake clock: timers, `performance.now()`,
 * `Date` and `AbortSignal.timeout`, which Node runs on a timer fake timers do not drive.
 * A request that hangs then times out when the test moves the clock, so a busy suite cannot fire
 * the first attempt's timeout after the budget it left for a retry. The real clock comes back
 * when the test ends.
 */
export function fakeBudgetClock(): BudgetClock {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => { controller.abort(new DOMException('The operation timed out', 'TimeoutError')); }, ms);
    return controller.signal;
  });
  onTestFinished(() => {
    timeout.mockRestore();
    vi.useRealTimers();
  });
  return {
    async settle<T>(pending: Promise<T>): Promise<T> {
      let settled = false;
      pending.then(() => { settled = true; }, () => { settled = true; });
      for (let fired = 0; !settled && fired < MAX_TIMERS; fired += 1) {
        for (let turn = 0; turn < TURNS && !settled; turn += 1) await new Promise((resolve) => { setImmediate(resolve); });
        if (!settled) await vi.advanceTimersToNextTimerAsync();
      }
      return pending;
    },
  };
}
