import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeSkroutzNumber, parseSkroutz, PROVIDER, SKROUTZ_MAX_BYTES } from './parser.js';

/** The lookup Skroutz Last Mile's tracking page makes for the voucher in its address. */
export const SKROUTZ_API = 'https://api.sendx.gr/user/hp/';
const REDIRECTS = [301, 302, 303, 307, 308];
// The service answers an unknown voucher with HTTP 400: a missing route is not a missing parcel.
const GONE = [404, 405, 410];
// The service's whole answer for a voucher it does not know.
const UNKNOWN = 'Package not found';
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /<title>\s*(?:Just a moment|Attention Required|Access Denied)|_cf_chl_opt|cf-turnstile|captcha/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Skroutz Last Mile answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Skroutz Last Mile returned a reply that is not JSON', { cause });
  }
}

export class SkroutzTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeSkroutzNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(`${SKROUTZ_API}${number}`, { method: 'GET', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: SKROUTZ_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 400, 403] });
      if (REDIRECTS.includes(response.status) || GONE.includes(response.status)) {
        throw new TransportError(PROVIDER, 'Skroutz Last Mile tracking lookup is unavailable', { status: response.status });
      }
      const body = decodeText(bytes).replace(/^\uFEFF/, '').trim();
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'Skroutz Last Mile refused the lookup', { status: 403 });
      if (response.status === 400) {
        if (body === UNKNOWN) throw new NotFoundError(PROVIDER);
        if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Skroutz Last Mile answered with a browser check', { status: 400 });
        throw new TransportError(PROVIDER, 'Skroutz Last Mile refused the lookup request', { status: 400 });
      }
      if (!body) throw new IndeterminateError(PROVIDER, 'Skroutz Last Mile returned an empty reply');
      return parseSkroutz(json(body), number);
    };
    // A lookup that fails to reach the service, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'skroutz-last-mile', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new SkroutzTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'skroutz-last-mile', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeSkroutzNumber(number))),
  };
};
