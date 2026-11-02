import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { GTL_MAX_BYTES, gtlRequestNumber, normalizeGtlNumber, parseGtl, PROVIDER } from './parser.js';

/** The lookup the tracking page on gtl.id makes for the number in its address. */
export const GTL_API = 'https://gtl.id/api/csms/shipment/v2/shipment/tracking';
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route is not a missing parcel: the lookup answers unknown numbers with HTTP 422.
const GONE = [404, 410];
/**
 * TikTok's gateway, which serves the site, asks for its captcha by naming it
 * in this header; the page then shows the captcha and asks again.
 */
const CAPTCHA_HEADER = 'bdturing-verify';
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /captcha|_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Access Denied)/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'GoTo Logistics answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'GoTo Logistics returned a reply that is not JSON', { cause });
  }
}

export class GtlTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeGtlNumber(raw);
    const body = JSON.stringify({ awb: gtlRequestNumber(number) });
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(GTL_API, { method: 'POST', signal, headers: {
        Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      }, body }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: GTL_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 400, 422] });
      if (response.headers.has(CAPTCHA_HEADER)) {
        throw new ChallengeError(PROVIDER, 'GoTo Logistics asked for its captcha', { status: response.status });
      }
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'GoTo Logistics redirected its tracking lookup', { status: response.status });
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'GoTo Logistics tracking lookup is unavailable', { status: response.status });
      // The lookup's own refusal of a request it cannot read: the request has changed.
      if (response.status === 400) throw new SchemaError(PROVIDER, 'GoTo Logistics refused the lookup request', { status: 400 });
      return parseGtl(json(decodeText(bytes)), number);
    };
    // A read that fails to reach GTL, or hangs, gets one more: the first gets
    // half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'gtl-goto', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new GtlTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'gtl-goto', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeGtlNumber(number))),
  };
};
