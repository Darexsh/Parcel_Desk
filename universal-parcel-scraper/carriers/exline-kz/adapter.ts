import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CARRIER, EXLINE_MAX_BYTES, normalizeExlineNumber, parseExline, PROVIDER, readExlineError } from './parser.js';

/** The lookup the tracking page on exline.kz makes for the number in its address or form. */
export const EXLINE_API = 'https://apiv1.exline.kz/api/v1/track/detail';
const REDIRECTS = [301, 302, 303, 307, 308];
// The tracker answers an unknown number in an error body: a missing route is not a missing parcel.
const GONE = [404, 405, 410];
// The API's own check of the request, which a ten-digit number passes.
const REJECTED = [400, 422];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|_cf_chl_opt|cf-turnstile|captcha/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Exline answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Exline returned a reply that is not JSON', { cause });
  }
}

export class ExlineTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeExlineNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(EXLINE_API, { method: 'POST', signal, headers: {
        Accept: 'application/json', 'Accept-Language': 'ru', 'Content-Type': 'application/json',
        'User-Agent': userAgentOf(this.options.userAgent),
      }, body: JSON.stringify({ orderno: number }) }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
        maxBytes: EXLINE_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
        allowHttpStatuses: [...REDIRECTS, ...GONE, ...REJECTED, 403, 502] });
      const status = response.status;
      if (REDIRECTS.includes(status) || GONE.includes(status)) throw new TransportError(PROVIDER, 'Exline tracking lookup is unavailable', { status });
      if (status === 403) throw new ChallengeError(PROVIDER, 'Exline refused the lookup', { status });
      const body = decodeText(bytes).replace(/^\uFEFF/, '').trim();
      if (REJECTED.includes(status)) throw new SchemaError(PROVIDER, 'Exline rejected the lookup request', { status });
      if (status === 502) {
        // MeaSoft's answer without an order comes as a JSON error; a gateway page is a failure.
        if (!body.startsWith('{')) throw new IndeterminateError(PROVIDER, 'Exline’s tracking gateway failed', { status });
        return readExlineError(json(body));
      }
      if (!body) throw new IndeterminateError(PROVIDER, 'Exline returned an empty reply');
      return parseExline(json(body), number);
    };
    // A lookup that fails to reach the tracker, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ExlineTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeExlineNumber(number))),
  };
};
