import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { A1_POST_MAX_BYTES, normalizeA1PostNumber, parseA1Post, PROVIDER } from './parser.js';

/** A1 POST's tracking page for one number, which the site renders on its server. */
export const A1_POST_PAGE = 'https://a1post.bg/track.php';
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing page is not a missing parcel: an unknown number is the page's own "Package not found".
const GONE = [404, 410];

/** The address of the page for one number, in English, as its English search page reads it. */
export function a1PostPageUrl(raw: string): string {
  const url = new URL(A1_POST_PAGE);
  url.searchParams.set('t', normalizeA1PostNumber(raw));
  url.searchParams.set('l', 'en');
  return url.href;
}

export class A1PostTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const url = a1PostPageUrl(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'text/html,application/xhtml+xml', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: A1_POST_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'A1 POST redirected its tracking page');
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'A1 POST tracking page is unavailable', { status: response.status });
      if (response.status !== 200) throw new IndeterminateError(PROVIDER, 'A1 POST did not answer with its tracking page');
      return parseA1Post(decodeText(bytes), raw);
    };
    // A read that fails to reach A1 POST, or hangs, gets one more: the first
    // gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'a1-post', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new A1PostTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'a1-post', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
