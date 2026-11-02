import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, RateLimitedError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { FEDEX_FREIGHT_MAX_BYTES, normalizeFedexFreightNumber, parseFedexFreight, PROVIDER } from './parser.js';

// The gateway the Detailed Tracking page asks for a visitor who is not signed
// in, without a key, cookie or CAPTCHA token.
export const FEDEX_FREIGHT_ENDPOINT = 'https://api.ltl.tech/fxf-external-tracking-auth4/fxfgw/route/track/v2/track-shipments';
// A firewall's or CDN's page instead of the gateway's JSON.
const CHALLENGE = /<title>\s*(?:Just a moment|Attention Required|Access denied|Access Denied|Request Rejected|403 Forbidden)|cf-turnstile|_cf_chl_opt|The requested URL was rejected|errors\.edgesuite\.net|captcha/i;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after')?.trim();
  return header && /^\d{1,6}$/.test(header) ? Number(header) * 1000 : undefined;
}

/** The body the tracking page posts for one PRO number. */
export function fedexFreightRequestBody(raw: string): string {
  return JSON.stringify({
    appDeviceType: 'WTRK', appType: 'WTRK', summaryView: false, supportHTML: true, supportCurrentLocation: true,
    trackingInfo: [{ trackNumberInfo: { trackingCarrier: '', trackingNumber: normalizeFedexFreightNumber(raw), trackingQualifier: '' } }],
    uniqueKey: '', guestAuthenticationToken: '',
  });
}

export class FedexFreightTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const body = fedexFreightRequestBody(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(FEDEX_FREIGHT_ENDPOINT, { method: 'POST', body, signal, headers: {
        Accept: 'application/json', 'Content-Type': 'application/json',
        'X-client-id': 'FDXFWEB', 'X-locale': 'en_US', 'X-version': '1.0.0',
        'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: FEDEX_FREIGHT_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 400, 403, 404, 410, 429] });
      if (response.status === 429) throw new RateLimitedError(PROVIDER, retryAfterMs(response));
      const text = decodeText(bytes);
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'FedEx Freight refused the request');
      // The gateway answers a request it cannot read with a 400 and an empty
      // envelope; the request is the page's, so the service has changed.
      if (response.status === 400) throw new SchemaError(PROVIDER, 'FedEx Freight refused the request');
      if (REDIRECTS.has(response.status) || response.status === 404 || response.status === 410) {
        throw new TransportError(PROVIDER, 'FedEx Freight tracking service is unavailable');
      }
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch (cause) {
        if (CHALLENGE.test(text.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'FedEx Freight answered with a block page', { cause });
        throw new SchemaError(PROVIDER, 'FedEx Freight returned a reply that is not JSON', { cause });
      }
      return parseFedexFreight(payload, raw);
    };
    // A request that fails to reach FedEx Freight, or hangs, gets one more
    // try: the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'fedex-freight', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new FedexFreightTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'fedex-freight', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
