import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { EPARCEL_KR_MAX_BYTES, normalizeEparcelKrNumber, parseEparcelKr, PROVIDER } from './parser.js';

/** The page the lookup on eParcel Korea's home page lands on. */
export const EPARCEL_KR_RESULT = 'https://www.eparcel.kr/Track/Result';
const REDIRECTS = [301, 302, 303, 307, 308];
// The page answers an unknown number with HTTP 200; a missing route is not a missing parcel.
const GONE = [404, 410];

/**
 * The page's address for one whole registration number: the one the home
 * page's lookup redirects to, with its branch, and the English the old search
 * page asked for.
 */
export function eparcelKrResultUrl(number: string): string {
  return `${EPARCEL_KR_RESULT}?${new URLSearchParams({ mode: '0', ids: normalizeEparcelKrNumber(number), branch: '00066', lang: 'en-US' })}`;
}

export class EparcelKrTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeEparcelKrNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(eparcelKrResultUrl(number), { method: 'GET', signal, headers: {
        Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.8', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: EPARCEL_KR_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE] });
      if (REDIRECTS.includes(response.status)) {
        // The server sends a lookup it fails, such as one without a language, to its error page.
        if (/^(?:https:\/\/(?:www\.)?eparcel\.kr)?\/Error\//i.test(response.headers.get('location') ?? '')) {
          throw new IndeterminateError(PROVIDER, 'eParcel Korea could not run the lookup', { status: response.status });
        }
        throw new TransportError(PROVIDER, 'eParcel Korea redirected its tracking page', { status: response.status });
      }
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'eParcel Korea tracking page is unavailable', { status: response.status });
      return parseEparcelKr(decodeText(bytes), number);
    };
    // A request that fails to reach the site, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'eparcel-kr', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new EparcelKrTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'eparcel-kr', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeEparcelKrNumber(number))),
  };
};
