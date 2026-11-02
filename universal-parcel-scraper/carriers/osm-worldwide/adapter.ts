import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import {
  ChallengeError, IndeterminateError, InvalidInputError, RateLimitedError, SchemaError, TransportError,
} from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isUspsNumber, normalizeOsmNumber, OSM_MAX_BYTES, parseOsmWorldwide, PROVIDER } from './parser.js';

// The service the tracking component on osmworldwide.com/tracking/ asks,
// without an account, key, cookie or CAPTCHA token.
export const OSM_ENDPOINT = 'https://prod.track-pub.osmworldwide.com/tracking/tracking-request';
// A missing route is not a missing parcel: an unknown number is the service's own `not-found`.
const GONE = [404, 410];
// CloudFront's or a firewall's block page instead of the service's JSON.
const CHALLENGE = /<title>\s*(?:Just a moment|Attention Required|Access denied|403 Forbidden|ERROR: The request could not be satisfied)|cf-turnstile|_cf_chl_opt|captcha/i;

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after')?.trim();
  return header && /^\d{1,6}$/.test(header) ? Number(header) * 1000 : undefined;
}

/** The address the tracker asks for one number; without an account it takes one at a time. */
export function osmTrackingUrl(raw: string): string {
  const url = new URL(OSM_ENDPOINT);
  url.searchParams.set('ids', normalizeOsmNumber(raw));
  return url.href;
}

export class OsmWorldwideTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const url = osmTrackingUrl(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // The service holds an anonymous reply for a few seconds before it answers.
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: OSM_MAX_BYTES,
        fetcher: this.options.fetcher, allowHttpStatuses: [400, ...GONE, 429] });
      const text = decodeText(bytes);
      if (response.status === 429) throw new RateLimitedError(PROVIDER, retryAfterMs(response));
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'OSM Worldwide tracking service is unavailable');
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch (cause) {
        if (CHALLENGE.test(text.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'OSM Worldwide answered with a block page', { cause });
        throw new SchemaError(PROVIDER, 'OSM Worldwide returned a reply that is not JSON', { cause });
      }
      // The service refuses a request it cannot read, such as more numbers than
      // an anonymous visitor may ask for, with HTTP 400; it says nothing about the number.
      if (response.status === 400) throw new IndeterminateError(PROVIDER, 'OSM Worldwide refused the tracking request');
      return parseOsmWorldwide(payload, raw);
    };
    // A request that fails to reach OSM Worldwide, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'osm-worldwide', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

/** Recognition never claims a USPS barcode: USPS issues it, whoever carries the parcel first. */
function recognizable(raw: string): string {
  const number = normalizeOsmNumber(raw);
  if (isUspsNumber(number)) throw new InvalidInputError(PROVIDER, 'USPS barcodes belong to USPS');
  return number;
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new OsmWorldwideTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'osm-worldwide', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => recognizable(number))),
  };
};
