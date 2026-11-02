import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, isNetworkFailure } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { KAZPOST_MAX_BYTES, kazpostJson, normalizeKazpostNumber, parseKazpost, PROVIDER } from './parser.js';

/** The tracking API post.kz's tracking page reads: an item's summary, and its scans under `/events`. */
export const KAZPOST_TRACKING_API = 'https://post.kz/external-api/tracking/api/v2/';
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route is not a missing item: the API answers unknown numbers with a notice.
const GONE = [404, 410];
const GATEWAY = [502, 504];

/** A failure worth one more try: the request did not reach the API, or its gateway gave up. */
function retried(error: unknown): boolean {
  return isNetworkFailure(error) || (error instanceof UpstreamHttpError && GATEWAY.includes(error.status));
}

export function kazpostUrls(number: string): { summary: string; history: string } {
  const summary = `${KAZPOST_TRACKING_API}${encodeURIComponent(number)}`;
  return { summary, history: `${summary}/events` };
}

export class KazpostTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async #get(url: string, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
    const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
      // Russian, the language of the dictionary the scans are worded from.
      Accept: 'application/json', 'Accept-Language': 'ru', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs, maxBytes: KAZPOST_MAX_BYTES, redirect: 'manual',
      allowHttpStatuses: [...REDIRECTS, ...GONE, 403], fetcher: this.options.fetcher });
    if (REDIRECTS.includes(response.status)) throw new IndeterminateError(PROVIDER, 'Kazpost sent the lookup to another page');
    if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'Kazpost\'s tracking API is unavailable', { status: response.status });
    if (response.status === 403) throw new ChallengeError(PROVIDER, 'Kazpost refused the lookup', { status: 403 });
    const body = decodeText(bytes);
    if (!body.trim()) throw new IndeterminateError(PROVIDER, 'Kazpost returned an empty reply');
    return kazpostJson(body);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeKazpostNumber(raw);
    const urls = kazpostUrls(number);
    const read = async (signal: AbortSignal, remainingMs: number): Promise<CarrierResult> => {
      const timeoutMs = Math.max(1, Math.floor(remainingMs));
      // Both at once, as either can take seconds longer than usual. When one
      // fails, the other is not left running.
      const sibling = new AbortController();
      const both = AbortSignal.any([signal, sibling.signal]);
      try {
        const [summary, history] = await Promise.all([this.#get(urls.summary, both, timeoutMs), this.#get(urls.history, both, timeoutMs)]);
        return parseKazpost(summary, history, number);
      } finally {
        sibling.abort();
      }
    };
    // A request that fails to reach the API, hangs or meets its gateway's
    // timeout gets one more try: the first gets half of the budget, so the
    // retry fits in the rest.
    return runSteps({ carrier: 'kazpost', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      { id: 'retry', recovers: retried, run: ({ signal, remainingMs }) => read(signal, remainingMs) },
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new KazpostTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'kazpost', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeKazpostNumber(number))),
  };
};
