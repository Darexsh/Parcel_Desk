/**
 * Test helper for a request that hangs: a fetcher whose replies arrive after a delay, or never,
 * each request ending with its signal as a real one does. `fakeBudgetClock` in `testing/budgetClock.ts`
 * drives the delays.
 */
import { vi } from 'vitest';

export interface DelayedReply {
  /** When the reply comes; `Infinity` for a request that hangs until its signal ends it. */
  afterMs: number;
  reply?: () => Response;
  failure?: Error;
}

/** Answers each request with the next reply. `ended` lists the time each request ended, on the faked clock. */
export function delayedFetcher(replies: DelayedReply[]) {
  const ended: number[] = [];
  let next = 0;
  const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise<Response>((resolve, reject) => {
    const planned = replies[next++] ?? { afterMs: 0, failure: new TypeError('No reply was planned') };
    const signal = init?.signal;
    const abort = () => {
      clearTimeout(timer);
      ended.push(performance.now());
      reject(signal!.reason as Error);
    };
    const timer = Number.isFinite(planned.afterMs) ? setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      ended.push(performance.now());
      if (planned.failure) reject(planned.failure);
      else resolve(planned.reply ? planned.reply() : new Response(''));
    }, planned.afterMs) : undefined;
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  }));
  return { fetcher, ended };
}
