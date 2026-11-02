import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, RateLimitedError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { ARAMEX_AU_MAX_BYTES, normalizeAramexAuNumber, parseAramexAu, PROVIDER } from './parser.js';

export const ARAMEX_AU_ORIGIN = 'https://www.aramex.com.au';
// The service the tracking page asks, without an account, key, cookie or
// CAPTCHA token. Aramex New Zealand runs it on its own host.
const ENDPOINT_PATH = '/umbraco/api/TrackingApi/GetTrackingData';
export const ARAMEX_AU_ENDPOINT = `${ARAMEX_AU_ORIGIN}${ENDPOINT_PATH}`;
// A missing route is not a missing parcel: an unknown number is the service's own error.
const GONE = [404, 410];
// A CDN's or firewall's block page instead of the service's JSON.
const CHALLENGE = /<title>\s*(?:Just a moment|Attention Required|Access denied|403 Forbidden)|cf-turnstile|_cf_chl_opt|captcha|The requested URL was rejected/i;

/** One Aramex network's tracking site: its host and how it reads a number. */
export interface AramexSite {
  readonly carrier: string;
  readonly provider: string;
  readonly origin: string;
  readonly language: string;
  readonly normalize: (raw: string) => string;
  readonly parse: (payload: unknown, raw: string) => CarrierResult;
}

const AUSTRALIA: AramexSite = {
  carrier: 'aramex-au', provider: PROVIDER, origin: ARAMEX_AU_ORIGIN, language: 'en-AU,en;q=0.8',
  normalize: normalizeAramexAuNumber, parse: parseAramexAu,
};

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after')?.trim();
  return header && /^\d{1,6}$/.test(header) ? Number(header) * 1000 : undefined;
}

/** The address a network's tracking page asks for one number. */
export function aramexTrackingUrl(site: AramexSite, raw: string): string {
  const url = new URL(`${site.origin}${ENDPOINT_PATH}`);
  url.searchParams.set('LabelNo', site.normalize(raw));
  url.searchParams.set('dataFormat', 'json');
  return url.toString();
}

/** The address the tracking page asks for one number. */
export function aramexAuUrl(raw: string): string {
  return aramexTrackingUrl(AUSTRALIA, raw);
}

/** One lookup on an Aramex network's tracking service, sent once more after a network failure. */
export class AramexRegionalTracker {
  constructor(private readonly site: AramexSite,
    private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const { site } = this;
    const url = aramexTrackingUrl(site, raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        // The service answers JSON under a JavaScript content type.
        Accept: 'application/json, text/javascript, */*;q=0.1', 'Accept-Language': site.language,
        Referer: `${site.origin}/tools/track/`, 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: site.provider, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: ARAMEX_AU_MAX_BYTES,
        fetcher: this.options.fetcher, allowHttpStatuses: [...GONE, 429] });
      const text = decodeText(bytes);
      if (response.status === 429) throw new RateLimitedError(site.provider, retryAfterMs(response));
      if (GONE.includes(response.status)) throw new TransportError(site.provider, `${site.provider} tracking service is unavailable`);
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch (cause) {
        if (CHALLENGE.test(text.slice(0, 64_000))) throw new ChallengeError(site.provider, `${site.provider} answered with a block page`, { cause });
        throw new SchemaError(site.provider, `${site.provider} returned a reply that is not JSON`, { cause });
      }
      return site.parse(payload, raw);
    };
    // A request that fails to reach Aramex, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: site.carrier, budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export class AramexAuTracker extends AramexRegionalTracker {
  constructor(options: ConstructorParameters<typeof AramexRegionalTracker>[1] = {}) { super(AUSTRALIA, options); }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new AramexAuTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'aramex-au', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeAramexAuNumber(number))),
  };
};
