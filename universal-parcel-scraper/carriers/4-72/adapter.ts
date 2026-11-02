import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { FOUR_SEVENTY_TWO_MAX_BYTES, normalizeFourSeventyTwoNumber, parseFourSeventyTwo, PROVIDER } from './parser.js';

/** The routes 4-72's tracking page asks for the guía typed in: the shipment's card, then its scans. */
export const FOUR_SEVENTY_TWO_TRACEABILITY = 'https://svc2.sipost.co/TrazabilidadWeb/Traceability';
const REDIRECTS = [301, 302, 303, 307, 308];
// The search answers an unknown guía in its reply: a missing route is not a missing item.
const GONE = [404, 405, 410];

export function fourSeventyTwoLookupUrl(route: 'Search' | 'Events', number: string): string {
  return `${FOUR_SEVENTY_TWO_TRACEABILITY}/${route}?${new URLSearchParams({ guia: number })}`;
}

export class FourSeventyTwoTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async get(route: 'Search' | 'Events', number: string, signal: AbortSignal, timeoutMs: number): Promise<string> {
    const { response, bytes } = await fetchBounded(fourSeventyTwoLookupUrl(route, number), { method: 'GET', signal, headers: {
      Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: FOUR_SEVENTY_TWO_MAX_BYTES,
      redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 403] });
    if (response.status === 403) throw new ChallengeError(PROVIDER, '4-72 refused the lookup', { status: 403 });
    if (REDIRECTS.includes(response.status) || GONE.includes(response.status)) {
      throw new TransportError(PROVIDER, '4-72 tracking lookup is unavailable', { status: response.status });
    }
    return decodeText(bytes).replace(/^\uFEFF/, '');
  }

  /**
   * Both replies at once, as the page asks for the scans as soon as the card
   * is in. When one fails, the other is cancelled.
   */
  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const sibling = new AbortController();
    const both = AbortSignal.any([signal, sibling.signal]);
    const settle = (route: 'Search' | 'Events') => this.get(route, number, both, timeoutMs).catch((error: unknown) => {
      sibling.abort(error);
      throw error;
    });
    const [search, events] = await Promise.all([settle('Search'), settle('Events')]);
    return parseFourSeventyTwo(search, events, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeFourSeventyTwoNumber(raw);
    // A lookup that fails to reach the tracker, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: '4-72', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new FourSeventyTwoTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: '4-72', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeFourSeventyTwoNumber(number))),
  };
};
