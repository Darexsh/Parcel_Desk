/**
 * One more try at a carrier's own read after a network failure or a timeout, inside the lookup's
 * budget. The first attempt's request gets at most half of the time left, so a request that hangs
 * leaves time for the second, which gets the rest. Only a failure to reach the carrier is tried
 * again: an HTTP status, a reply that does not parse and a definite answer stand, and so does any
 * failure once the lookup's own signal has ended. Reads only: a request that changes something, or
 * one bound to a session the failure may have spent, is not replayed.
 *
 * Steps run by `runSteps` add `networkRetryStep` after the first and give it `firstAttemptMs` of
 * what is left, so the retry is recorded as a step of its own. A read outside the runner wraps its
 * request in `withNetworkRetry`.
 */
import { UpstreamNetworkError } from '../errors/index.js';
import type { StepContext, StepSpec } from './index.js';

const MAX_CAUSE_DEPTH = 8;

/** Whether an error is, or wraps, a request that did not reach the carrier, including one that timed out. */
export function isNetworkFailure(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error && !seen.has(current); depth += 1) {
    seen.add(current);
    if (current instanceof UpstreamNetworkError) return true;
    current = current.cause;
  }
  return false;
}

/** The time a first attempt's request gets out of what is left: half, so a retry still fits. */
export function firstAttemptMs(remainingMs: number): number {
  return Math.max(1, Math.floor(remainingMs / 2));
}

/** A step that runs the read again after the step before it failed to reach the carrier. */
export function networkRetryStep<T>(run: (context: StepContext) => Promise<T>): StepSpec<T> {
  return { id: 'retry', recovers: isNetworkFailure, run };
}

/**
 * `attempt` with the time its request may take, then once more after a network failure or a
 * timeout, while the budget has time left and its signal has not ended.
 */
export async function withNetworkRetry<T>(
  budget: { signal?: AbortSignal; remainingMs: () => number },
  attempt: (timeoutMs: number) => Promise<T>,
): Promise<T> {
  try {
    return await attempt(firstAttemptMs(budget.remainingMs()));
  } catch (error) {
    if (!isNetworkFailure(error) || budget.signal?.aborted) throw error;
    const left = budget.remainingMs();
    if (left <= 1) throw error;
    return await attempt(left);
  }
}
