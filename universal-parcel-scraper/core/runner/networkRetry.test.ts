import { describe, expect, it, vi } from 'vitest';
import { lookupBudget } from '../adapter/index.js';
import { NotFoundError, SchemaError, UpstreamHttpError, UpstreamNetworkError } from '../errors/index.js';
import { delayedFetcher } from '../testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { fetchBounded } from '../transport/index.js';
import { runSteps } from './index.js';
import { firstAttemptMs, isNetworkFailure, networkRetryStep, withNetworkRetry } from './networkRetry.js';

const read = (fetcher: typeof fetch, signal: AbortSignal, timeoutMs: number) =>
  fetchBounded('https://carrier.test/track', { signal }, { provider: 'Carrier', timeoutMs, fetcher });

describe('one network retry inside the budget', () => {
  it('tells a failure to reach the carrier from an answer', () => {
    expect(isNetworkFailure(new UpstreamNetworkError('Carrier', new TypeError('fetch failed')))).toBe(true);
    expect(isNetworkFailure(new SchemaError('Carrier', 'Wrapped', { cause: new UpstreamNetworkError('Carrier', null) }))).toBe(true);
    for (const answer of [new UpstreamHttpError('Carrier', 503), new NotFoundError('Carrier'), new SchemaError('Carrier'), new TypeError('x')]) {
      expect(isNetworkFailure(answer)).toBe(false);
    }
    expect(firstAttemptMs(15_000)).toBe(7_500);
    expect(firstAttemptMs(1)).toBe(1);
  });

  it('gives a request that hangs half the budget, and the retry the rest', async () => {
    fakeBudgetClock();
    const { fetcher, ended } = delayedFetcher([{ afterMs: Infinity }, { afterMs: 400, reply: () => new Response('ok') }]);
    const budget = lookupBudget({}, 15_000);
    const answer = withNetworkRetry(budget, timeoutMs => read(fetcher, budget.signal, timeoutMs));
    await vi.advanceTimersByTimeAsync(7_900);
    await expect(answer).resolves.toMatchObject({ response: { status: 200 } });
    expect(ended).toEqual([7_500, 7_900]);
  });

  it('retries once, and never an answer or a lookup that ended', async () => {
    fakeBudgetClock();
    const twice = delayedFetcher([{ afterMs: 10, failure: new TypeError('reset') }, { afterMs: 10, failure: new TypeError('reset') }]);
    const budget = lookupBudget({}, 15_000);
    const failure = expect(withNetworkRetry(budget, timeoutMs => read(twice.fetcher, budget.signal, timeoutMs))).rejects.toBeInstanceOf(UpstreamNetworkError);
    await vi.advanceTimersByTimeAsync(20);
    await failure;
    expect(twice.fetcher).toHaveBeenCalledTimes(2);

    const missing = delayedFetcher([{ afterMs: 10, reply: () => new Response('', { status: 404 }) }]);
    const answered = expect(withNetworkRetry(budget, timeoutMs => read(missing.fetcher, budget.signal, timeoutMs))).rejects.toMatchObject({ kind: 'not_found' });
    await vi.advanceTimersByTimeAsync(10);
    await answered;
    expect(missing.fetcher).toHaveBeenCalledOnce();

    const controller = new AbortController();
    const cancelled = delayedFetcher([{ afterMs: Infinity }]);
    const stopped = lookupBudget({ signal: controller.signal }, 15_000);
    const pending = expect(withNetworkRetry(stopped, timeoutMs => read(cancelled.fetcher, stopped.signal, timeoutMs))).rejects.toBeInstanceOf(UpstreamNetworkError);
    controller.abort(new Error('Cancelled'));
    await pending;
    expect(cancelled.fetcher).toHaveBeenCalledOnce();
  });

  it('records the retry as a step of its own', async () => {
    fakeBudgetClock();
    const { fetcher, ended } = delayedFetcher([{ afterMs: Infinity }, { afterMs: 300, reply: () => new Response('ok') }]);
    const steps: Array<[string, string]> = [];
    const run = ({ signal, remainingMs }: { signal: AbortSignal; remainingMs: number }) => read(fetcher, signal, remainingMs);
    const answer = runSteps({ carrier: 'carrier', budgetMs: 10_000, recorder: { step: (record) => { steps.push([record.step, record.outcome]); }, lookup() {} } }, [
      { id: 'direct', run: (context) => run({ ...context, remainingMs: firstAttemptMs(context.remainingMs) }) },
      networkRetryStep(run),
    ]);
    await vi.advanceTimersByTimeAsync(5_300);
    await expect(answer).resolves.toMatchObject({ response: { status: 200 } });
    expect(ended).toEqual([5_000, 5_300]);
    expect(steps).toEqual([['direct', 'transport'], ['retry', 'ok']]);
  });
});
