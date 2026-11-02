import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, NotFoundError, RateLimitedError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { normalizeParcelpointNumber, PARCELPOINT_MAX_BYTES, parseParcelpoint, PROVIDER } from './parser.js';

/** The lookup the tracking page on parcelpoint.com.au makes, through the site's own proxy. */
export const PARCELPOINT_API = 'https://parcelpoint.com.au/wp-json/parcelpoint/v1/track';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required)|sucuri_cloudproxy|Access Denied - Sucuri|captcha/i;

/** The lookup's address for a number, as the page builds it. */
export function parcelpointTrackUrl(number: string): string {
  return `${PARCELPOINT_API}?trackingId=${encodeURIComponent(number)}`;
}

/** Seconds in a Retry-After header, in milliseconds. */
function retryAfterMs(header: string | null): number | undefined {
  return header && /^\d{1,6}$/.test(header.trim()) ? Number(header.trim()) * 1000 : undefined;
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'ParcelPoint answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'ParcelPoint returned a reply that is not JSON', { cause });
  }
}

/** WordPress's error code in a JSON reply, if the reply is one. */
function errorCode(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    return isRecord(parsed) && typeof parsed.code === 'string' ? parsed.code : '';
  } catch {
    return '';
  }
}

export class ParcelpointTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeParcelpointNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(parcelpointTrackUrl(number), { method: 'GET', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: PARCELPOINT_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 410, 429] });
      const body = decodeText(bytes);
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'ParcelPoint redirected its tracking lookup');
      if (response.status === 429) {
        throw new RateLimitedError(PROVIDER, retryAfterMs(response.headers.get('retry-after')), 'ParcelPoint refused more lookups for now', { status: 429 });
      }
      if (response.status === 403) {
        const message = CHALLENGE.test(body.slice(0, 64_000)) ? 'ParcelPoint answered with a browser check' : 'ParcelPoint refused the lookup';
        throw new ChallengeError(PROVIDER, message, { status: 403 });
      }
      // The page reads a 404 from its proxy as a number it does not know. WordPress's own 404
      // for a route it lacks, or a 404 page, is a moved route.
      if (response.status === 404 || response.status === 410) {
        const code = errorCode(body);
        if (response.status === 404 && code && code !== 'rest_no_route') throw new NotFoundError(PROVIDER);
        throw new TransportError(PROVIDER, 'ParcelPoint tracking lookup is unavailable', { status: response.status });
      }
      return parseParcelpoint(json(body), number);
    };
    // A request that fails to reach the service, or hangs, gets one more try: the first gets
    // half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'parcelpoint', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ParcelpointTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'parcelpoint', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
