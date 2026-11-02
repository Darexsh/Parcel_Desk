import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  GEODIS_PL_MAX_BYTES, normalizeGeodisPlNumber, parseGeodisPlHistory, parseGeodisPlSummary, PROVIDER,
} from './parser.js';

/** The tracker's English page. Its search form posts, and the page answers the same search as a plain GET. */
export const GEODIS_PL_PAGE = 'https://strefaklienta.pekaes.geodis.pl/en/';
const REDIRECTS = [301, 302, 303, 307, 308];
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|<title>\s*Attention Required/i;

/** The search page for one number, as a person can open it. */
export function geodisPlSearchUrl(number: string): string {
  return `${GEODIS_PL_PAGE}?${new URLSearchParams({ ShNumber: normalizeGeodisPlNumber(number) })}`;
}

/** The history the page's "Details" link loads. */
export function geodisPlHistoryUrl(number: string): string {
  return `${GEODIS_PL_PAGE}?${new URLSearchParams({ ltlHistory: normalizeGeodisPlNumber(number) })}`;
}

function json(body: string): unknown {
  try {
    return JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'GEODIS Poland answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'GEODIS Poland returned a history that is not JSON', { cause });
  }
}

export class GeodisPlTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeGeodisPlNumber(raw);
    const budgetMs = context.budgetMs ?? 15_000;
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      const get = async (url: string, accept: string, headers: Record<string, string> = {}): Promise<string> => {
        // A request out of time fails as a timeout, which the retry step may take up.
        const left = Math.max(1, Math.floor(deadline - performance.now()));
        signal.throwIfAborted();
        const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
          ...headers, Accept: accept, 'Accept-Language': 'en', 'User-Agent': userAgentOf(this.options.userAgent),
        } }, { provider: PROVIDER, timeoutMs: left, maxBytes: GEODIS_PL_MAX_BYTES, redirect: 'manual',
          allowHttpStatuses: [...REDIRECTS, 404, 410], fetcher: this.options.fetcher });
        // A moved or missing page says nothing about the shipment.
        if (response.status !== 200) throw new TransportError(PROVIDER, 'GEODIS Poland tracking page is unavailable');
        return decodeText(bytes);
      };
      const summary = parseGeodisPlSummary(await get(geodisPlSearchUrl(number), 'text/html'), number);
      // The page's own request for the history, as its jQuery sends it.
      const history = await get(geodisPlHistoryUrl(number), 'application/json, text/javascript, */*; q=0.01',
        { 'X-Requested-With': 'XMLHttpRequest' });
      return parseGeodisPlHistory(json(history), summary, Date.now());
    };
    // A read that fails to reach the site, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'geodis-pl', budgetMs, signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new GeodisPlTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'geodis-pl', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeGeodisPlNumber(number))),
  };
};
