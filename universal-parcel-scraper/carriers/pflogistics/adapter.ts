import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { pflogisticsNumber } from './number.js';
import { parsePflogistics, PFLOGISTICS_MAX_BYTES, PROVIDER } from './parser.js';

export const PFLOGISTICS_RESULT = 'https://pflogistics.com.au/tracking-result';
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 410];

/** The parcel form's GET twin; its timezone field controls the rendered clocks. */
export function pflogisticsUrl(raw: string): string {
  return `${PFLOGISTICS_RESULT}?${new URLSearchParams({ tracking: pflogisticsNumber(raw), timezone: 'UTC' })}`;
}

export class PflogisticsTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const url = pflogisticsUrl(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal,
        headers: { Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent) } },
      { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: PFLOGISTICS_MAX_BYTES,
        redirect: 'manual', allowHttpStatuses: [...REDIRECTS, ...GONE], fetcher: this.options.fetcher }).catch((error: unknown) => {
        // An HTTP error can still render parcel details. Keep its failure
        // metadata and recognized signals without exposing the page to telemetry.
        if (error instanceof UpstreamHttpError) throw new UpstreamHttpError(PROVIDER, error.status, error.retryAfterMs,
          error.diagnostics ? { ...error.diagnostics, body_excerpt: undefined } : undefined, error.request);
        throw error;
      });
      if (REDIRECTS.includes(response.status)) throw new IndeterminateError(PROVIDER, 'PFL redirected the tracking lookup');
      // A missing route is no answer about a parcel: the carrier's missing-parcel notice is HTTP 200.
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'PFL tracking is unavailable');
      const html = decodeText(bytes);
      if (response.status !== 200 || !html.trim()) throw new IndeterminateError(PROVIDER, 'PFL returned an empty tracking reply');
      return parsePflogistics(html, raw);
    };
    return runSteps({ carrier: 'pflogistics', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new PflogisticsTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'pflogistics', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => pflogisticsNumber(number))),
  };
};
