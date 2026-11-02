import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { canadaPostLookupKind, normalizeCanadaPostNumber, parseCanadaPostTrackingResponse, resolveCanadaPostPin } from './parser.js';

export { normalizeCanadaPostNumber, parseCanadaPostTrackingResponse } from './parser.js';

const API_BASE = 'https://www.canadapost-postescanada.ca/track-reperage/rs/track/json/package';
const DEFAULT_TIMEOUT_MS = 15_000;

export function canadaPostTrackingUrl(trackingNumber: string): string {
  const url = new URL('https://www.canadapost-postescanada.ca/track-reperage/en/search');
  url.searchParams.set('searchFor', normalizeCanadaPostNumber(trackingNumber));
  return url.toString();
}

export interface CanadaPostTrackerOptions {
  timeoutMs?: number;
  fetcher?: typeof fetch;
  recorder?: StepRecorder;
  userAgent?: string;
}

export class CanadaPostTracker {
  readonly timeoutMs: number;
  readonly #options: CanadaPostTrackerOptions;
  readonly #userAgent: string;

  constructor(options: number | CanadaPostTrackerOptions = {}) {
    this.#options = typeof options === 'number' ? { timeoutMs: options } : options;
    this.timeoutMs = this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new TypeError('Canada Post timeout must be positive');
    this.#userAgent = userAgentOf(this.#options.userAgent);
  }

  async fetch(rawTrackingNumber: string, context: TrackingContext = {}) {
    const number = normalizeCanadaPostNumber(rawTrackingNumber);
    const budgetMs = context.budgetMs ?? this.timeoutMs;
    return runSteps({ carrier: 'canada-post', budgetMs, signal: context.signal,
      recorder: this.#options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const deadline = performance.now() + remainingMs;
      const request = async (url: URL): Promise<unknown> => {
        const requestBudget = deadline - performance.now();
        if (requestBudget <= 0) throw new BudgetExceededError('canada-post', budgetMs);
        signal.throwIfAborted();
        let bytes: Uint8Array;
        try {
          ({ bytes } = await fetchBounded(url, { signal, headers: {
            Accept: 'application/json, text/plain, */*',
            'Accept-Language': 'en-CA,en;q=0.9',
            // The public tracking application's interceptor sends empty Basic credentials.
            Authorization: 'Basic Og==',
            Referer: 'https://www.canadapost-postescanada.ca/track-reperage/en/home',
            'User-Agent': this.#userAgent,
            'X-Requested-With': 'XMLHttpRequest',
          } }, { provider: 'canada-post', timeoutMs: Math.max(1, Math.floor(requestBudget)),
            maxBytes: 1_000_000, fetcher: this.#options.fetcher }));
        } catch (error) {
          if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) {
            throw new TransportError('canada-post', 'Canada Post tracking endpoint is unavailable', { cause: error });
          }
          throw error;
        }
        try { return parseJsonBytes(bytes, 'canada-post'); }
        catch (cause) { throw new SchemaError('canada-post', 'Canada Post returned invalid tracking JSON', { cause }); }
      };
      const kind = canadaPostLookupKind(number);
      let pin = number;
      if (kind !== 'pin') {
        const url = new URL(API_BASE);
        url.searchParams.set(kind === 'dnc' ? 'dncs' : 'refNbrs', number);
        pin = resolveCanadaPostPin(await request(url), number, kind);
      }
      const result = parseCanadaPostTrackingResponse(await request(new URL(`${API_BASE}/${encodeURIComponent(pin)}/detail`)), pin);
      return { ...result, ...(pin !== number ? { canonical_tracking_number: pin } : {}),
        tracking_url: canadaPostTrackingUrl(number), tracking_source: 'structured-web-response' };
    } }]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new CanadaPostTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'canada-post', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => normalizeCanadaPostNumber(number))) };
};
