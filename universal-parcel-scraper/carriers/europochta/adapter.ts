import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, carrierErrorKind, ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { TRAWL_TRANSPORT_ALLOWANCE_MS, trawlBody, type TrawlClient } from '../../core/transport/trawl.js';
import { EUROPOCHTA_MAX_BYTES, europochtaJson, normalizeEuropochtaNumber, parseEuropochta, PROVIDER } from './parser.js';

/** globalRoutes.getTracking in evropochta.by's public page. */
export const EUROPOCHTA_API = 'https://evropochta.by/mvc/application/ops/tracking/';
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 405, 410];

export class EuropochtaTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; trawl?: TrawlClient | null } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeEuropochtaNumber(raw);
    const url = `${EUROPOCHTA_API}?${new URLSearchParams({ number })}`;
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: EUROPOCHTA_MAX_BYTES,
        redirect: 'manual', allowHttpStatuses: [...REDIRECTS, ...GONE, 403], fetcher: this.options.fetcher });
      if (REDIRECTS.includes(response.status) || GONE.includes(response.status)) throw new TransportError(PROVIDER, 'Europochta tracking lookup is unavailable', { status: response.status });
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'Europochta refused the lookup', { status: 403 });
      return parseEuropochta(europochtaJson(decodeText(bytes)), number);
    };
    return runSteps({ carrier: 'europochta', budgetMs: context.budgetMs ?? (this.options.trawl ? 60_000 : 15_000), signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(this.options.trawl ? Math.min(15_000, remainingMs) : remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, this.options.trawl ? Math.min(7_500, remainingMs) : remainingMs)),
      { id: 'trawl', enabled: Boolean(this.options.trawl), recovers: error => carrierErrorKind(error) === 'challenge',
        run: async ({ signal, remainingMs }) => {
          const timeoutMs = Math.floor(Math.min(30_000, remainingMs - TRAWL_TRANSPORT_ALLOWANCE_MS));
          if (timeoutMs < 1) throw new BudgetExceededError(PROVIDER, remainingMs);
          const page = await this.options.trawl!.scrape({ url, skipHttp: true, maxTier: 3, maxTimeout: timeoutMs }, {
            provider: PROVIDER, signal, timeoutMs, fetcher: this.options.fetcher, maxBytes: EUROPOCHTA_MAX_BYTES * 8 + 65_536,
          });
          signal.throwIfAborted();
          if (page.url !== url) throw new TransportError(PROVIDER, 'Europochta redirected the requested lookup');
          // The endpoint mislabels JSON as HTML. Read the final response bytes,
          // since interpreting its HTML-bearing descriptions as DOM changes JSON.
          const body = trawlBody(page.raw, EUROPOCHTA_MAX_BYTES);
          if (new TextEncoder().encode(body).byteLength > EUROPOCHTA_MAX_BYTES) throw new SchemaError(PROVIDER, 'Europochta returned excessive tracking data');
          return parseEuropochta(europochtaJson(body), number);
        } },
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new EuropochtaTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent, trawl: environment.trawl });
  const http = new EuropochtaTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'europochta', recordsSteps: true, steps: ['direct', 'retry', 'trawl'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => http.fetch(number, context), () => accepted(() => normalizeEuropochtaNumber(number))),
  };
};
