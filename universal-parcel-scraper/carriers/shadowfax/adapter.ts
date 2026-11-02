import { accepted, recognizeFromLookup, type AdapterFactory, type Recognition, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, NoHistoryError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { NO_DELIVERY, normalizeShadowfaxNumber, parseShadowfax, PROVIDER, SHADOWFAX_MAX_BYTES, shadowfaxMessage, shadowfaxUnknown } from './parser.js';

const API = 'https://saruman.shadowfax.in';
/** The delivery service's history of one AWB, which the tracker reads once it has opened the parcel. */
export const SHADOWFAX_TRACK_API = `${API}/web_app/delivery/track/`;
/** The tracker's own lookup of a typed number, which tells a number Shadowfax does not know. */
export const SHADOWFAX_LOOKUP_API = `${API}/awb/awb_to_unique_code/`;
// The token the tracker's script and the website's track page send with
// every lookup, the same for every visitor.
const TRACKER_TOKEN = 'cePcVR7z7FIETB4PxguHC2YJGk6NncHnByrJttgRIUqNxfWezuzAUvtALyqcHJEC'; // gitleaks:allow
const REDIRECTS = [301, 302, 303, 307, 308];
// The services answer a number they do not know with HTTP 400 and a message.
const REFUSED = 400;
// A missing route is not a missing parcel.
const GONE = [404, 410];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access denied)|captcha/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Shadowfax answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Shadowfax returned a reply that is not JSON', { cause });
  }
}

export class ShadowfaxTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeShadowfaxNumber(raw);
    // One attempt reads the delivery service's history. For a number it has
    // no delivery request under, the tracker's own lookup says whether
    // Shadowfax knows the number at all.
    const attempt = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      const get = async (url: string) => {
        signal.throwIfAborted();
        const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
          Accept: 'application/json', Authorization: `Token ${TRACKER_TOKEN}`, 'User-Agent': userAgentOf(this.options.userAgent),
        } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(deadline - performance.now())), maxBytes: SHADOWFAX_MAX_BYTES,
          redirect: 'manual', allowHttpStatuses: [...REDIRECTS, REFUSED, ...GONE], fetcher: this.options.fetcher });
        if (REDIRECTS.includes(response.status)) throw new IndeterminateError(PROVIDER, 'Shadowfax moved its tracking service');
        if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'Shadowfax tracking service is unavailable');
        return { status: response.status, payload: json(decodeText(bytes)) };
      };
      const track = await get(`${SHADOWFAX_TRACK_API}${number}/`);
      if (track.status !== REFUSED) return parseShadowfax(track.payload, number);
      if (shadowfaxMessage(track.payload) !== NO_DELIVERY) throw new IndeterminateError(PROVIDER, 'Shadowfax refused the lookup');
      const lookup = await get(`${SHADOWFAX_LOOKUP_API}?${new URLSearchParams({ order_id: number })}`);
      return shadowfaxUnknown(lookup.status, lookup.payload, number);
    };
    // A request that fails to reach Shadowfax, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest. An
    // HTTP status, a rate limit included, is never sent again.
    return runSteps({ carrier: 'shadowfax', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => attempt(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => attempt(signal, remainingMs)),
    ]);
  }

  /** A record that names the number is a parcel Shadowfax knows, with scans or without. */
  async recognize(number: string, context: TrackingContext = {}): Promise<Recognition> {
    try {
      return await recognizeFromLookup(() => this.fetch(number, context), () => accepted(() => normalizeShadowfaxNumber(number)));
    } catch (error) {
      if (error instanceof NoHistoryError) return { known: true, lastActivityAt: null };
      throw error;
    }
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ShadowfaxTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'shadowfax', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => tracker.recognize(number, context),
  };
};
