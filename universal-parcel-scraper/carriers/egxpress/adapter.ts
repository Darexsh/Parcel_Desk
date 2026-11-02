import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { EGXPRESS_MAX_BYTES, normalizeEgxpressNumber, parseEgxpress, PROVIDER } from './parser.js';

/** The single-shipment request built by the official tracking page. */
export const EGXPRESS_API = 'https://www.egyptexpress.com.eg/umbraco/surface/home/GetDomesticTrack';
const REDIRECTS = [301, 302, 303, 307, 308];
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|<title>\s*Attention Required|captcha/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'EGXPRESS answered with a browser check');
    throw new SchemaError(PROVIDER, 'EGXPRESS returned a reply that is not JSON');
  }
}

export class EgxpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeEgxpressNumber(raw);
    const url = new URL(EGXPRESS_API);
    url.searchParams.set('_trackingID', number);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs, maxBytes: EGXPRESS_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
        allowHttpStatuses: [...REDIRECTS, 400, 404, 410] }).catch((error: unknown) => {
        // The API can include recipient details in its body. Retain HTTP
        // failure kinds and signals without carrying that body into telemetry.
        if (error instanceof UpstreamHttpError) throw new UpstreamHttpError(PROVIDER, error.status, error.retryAfterMs,
          error.diagnostics ? { ...error.diagnostics, body_excerpt: undefined } : undefined, error.request);
        throw error;
      });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'EGXPRESS redirected its tracking lookup');
      if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'EGXPRESS tracking lookup is unavailable');
      if (response.status === 400) throw new SchemaError(PROVIDER, 'EGXPRESS refused the tracking request', { status: 400 });
      return parseEgxpress(json(decodeText(bytes)), number);
    };
    return runSteps({ carrier: 'egxpress', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, Math.max(1, Math.floor(remainingMs)))),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new EgxpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'egxpress', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeEgxpressNumber(number))),
  };
};
