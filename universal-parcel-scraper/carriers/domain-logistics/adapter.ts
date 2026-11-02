import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, NotFoundError, RateLimitedError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { DOMAIN_LOGISTICS_MAX_BYTES, normalizeDomainLogisticsNumber, parseDomainLogistics, PROVIDER } from './parser.js';

/** The lookup the tracking page on domainlogistics.ca makes, on Domain's tracking service. */
export const DOMAIN_LOGISTICS_API = 'https://api.domainlogistics.ca/domaintracking/api/tracking/';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks Cloudflare, in front of the service, could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required)/i;

/** The lookup's address for a number, as the page builds it. */
export function domainLogisticsTrackUrl(number: string): string {
  return `${DOMAIN_LOGISTICS_API}${encodeURIComponent(number)}`;
}

/** Seconds in a Retry-After header, in milliseconds. */
function retryAfterMs(header: string | null): number | undefined {
  return header && /^\d{1,6}$/.test(header.trim()) ? Number(header.trim()) * 1000 : undefined;
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Domain Logistics answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Domain Logistics returned a reply that is not JSON', { cause });
  }
}

export class DomainLogisticsTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeDomainLogisticsNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(domainLogisticsTrackUrl(number), { method: 'GET', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: DOMAIN_LOGISTICS_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 400, 403, 404, 410, 429] });
      const body = decodeText(bytes);
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Domain Logistics redirected its tracking lookup');
      if (response.status === 429) {
        throw new RateLimitedError(PROVIDER, retryAfterMs(response.headers.get('retry-after')), 'Domain Logistics refused more lookups for now', { status: 429 });
      }
      if (response.status === 403) {
        const message = CHALLENGE.test(body.slice(0, 64_000)) ? 'Domain Logistics answered with a browser check' : 'Domain Logistics refused the lookup';
        throw new ChallengeError(PROVIDER, message, { status: 403 });
      }
      // The service's own 404 names a route it does not have: the lookup moved.
      if (response.status === 404 || response.status === 410) {
        throw new TransportError(PROVIDER, 'Domain Logistics tracking lookup is unavailable', { status: response.status });
      }
      if (response.status === 400) {
        // An order the service does not hold is an empty HTTP 400, which the page reads as an invalid tracking code.
        if (!body.trim()) throw new NotFoundError(PROVIDER);
        if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Domain Logistics answered with a browser check', { status: 400 });
        throw new SchemaError(PROVIDER, 'Domain Logistics refused the lookup with an unexpected reply', { status: 400 });
      }
      if (response.status !== 200) throw new SchemaError(PROVIDER, 'Domain Logistics returned an unexpected reply', { status: response.status });
      return parseDomainLogistics(json(body));
    };
    // A request that fails to reach the service, or hangs, gets one more try: the first gets
    // half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'domain-logistics', budgetMs: context.budgetMs ?? 30_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new DomainLogisticsTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'domain-logistics', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
