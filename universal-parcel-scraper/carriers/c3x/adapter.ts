import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { isRecord } from '../../core/types.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { C3X_MAX_BYTES, normalizeC3xNumber, parseC3x, PROVIDER } from './parser.js';

/** The lookup the tracking field on c3xpress.com makes for an airwaybill. */
export const C3X_API = 'https://api.c3x.ae/api/Tracking';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|g-recaptcha|h-captcha|<title>\s*(?:Just a moment|Attention Required|Access Denied)/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    throw new SchemaError(PROVIDER, 'C3X returned a reply that is not JSON', { cause });
  }
}

/** Whether a 400 is the service's own error envelope, `{"statusCode":400,"message":…}`. */
function serviceError(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body);
    return isRecord(parsed) && parsed.statusCode === 400 && typeof parsed.message === 'string';
  } catch {
    return false;
  }
}

export class C3xTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeC3xNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(C3X_API, { method: 'POST', signal, headers: {
        Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      }, body: JSON.stringify({ TrackingAWB: [{ AirWayBillNo: number }] }) }, { provider: PROVIDER,
        timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: C3X_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
        allowHttpStatuses: [...REDIRECTS, 400, 403, 404, 410] });
      const body = decodeText(bytes);
      // A redirect would answer for another request, so for another parcel or none.
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'C3X redirected its tracking lookup', { status: response.status });
      if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'C3X answered with a browser check', { status: response.status });
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'C3X refused the lookup', { status: 403 });
      // The page reads a missing parcel from a 200 reply; a 404 is a moved route.
      if (response.status === 404 || response.status === 410) {
        throw new TransportError(PROVIDER, 'C3X tracking lookup is unavailable', { status: response.status });
      }
      if (response.status === 400) {
        // The service passes on a failure of C3X's own system with its message.
        if (serviceError(body)) throw new IndeterminateError(PROVIDER, 'C3X did not complete the lookup', { status: 400 });
        throw new TransportError(PROVIDER, 'C3X refused the lookup', { status: 400 });
      }
      return parseC3x(json(body), number);
    };
    // A lookup that fails to reach the service, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'c3x', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new C3xTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'c3x', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeC3xNumber(number))),
  };
};
