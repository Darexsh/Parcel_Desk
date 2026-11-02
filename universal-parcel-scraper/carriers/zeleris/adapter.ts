import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { trawlPageStep } from '../../core/transport/trawlPage.js';
import type { TrawlClient } from '../../core/transport/trawl.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeZelerisNumber, parseZeleris, parseZelerisRedirect, PROVIDER, ZELERIS_MAX_BYTES, ZELERIS_ORIGIN } from './parser.js';

// The page Zeleris's tracking form opens with the number as `tracking_number`.
export const ZELERIS_ENDPOINT = `${ZELERIS_ORIGIN}/detalle-de-envio/`;
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing page is not a missing shipment: Zeleris redirects unknown numbers.
const GONE = [404, 410];

export class ZelerisTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; trawl?: TrawlClient | null } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeZelerisNumber(raw);
    const url = `${ZELERIS_ENDPOINT}?${new URLSearchParams({ tracking_number: number })}`;
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // The site renders the shipment on the server, or redirects to its
      // search page with a flag; the redirect is the answer, so it is not followed.
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'es-ES,es;q=0.9',
        'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: ZELERIS_MAX_BYTES,
        redirect: 'manual', allowHttpStatuses: [...REDIRECTS, ...GONE], fetcher: this.options.fetcher });
      if (REDIRECTS.includes(response.status)) return parseZelerisRedirect(response.headers.get('location'), number);
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'Zeleris tracking page is unavailable');
      const html = decodeText(bytes);
      if (!html.trim()) throw new IndeterminateError(PROVIDER, 'Zeleris returned an empty page');
      return parseZeleris(html, number);
    };
    // A request that fails to reach Zeleris, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'zeleris', budgetMs: context.budgetMs ?? (this.options.trawl ? 60_000 : 15_000), signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(this.options.trawl ? Math.min(15_000, remainingMs) : remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, this.options.trawl ? Math.min(7_500, remainingMs) : remainingMs)),
      trawlPageStep({ ...this.options, provider: PROVIDER, url, maxBytes: ZELERIS_MAX_BYTES,
        parseRedirect: (redirected, html) => parseZelerisRedirect(redirected, number, html), parse: html => parseZeleris(html, number) }),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ZelerisTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent, trawl: environment.trawl });
  const http = new ZelerisTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'zeleris', recordsSteps: true, steps: ['direct', 'retry', 'trawl'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => http.fetch(number, context),
      () => accepted(() => normalizeZelerisNumber(number))),
  };
};
