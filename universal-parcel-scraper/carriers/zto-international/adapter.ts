import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeZtoInternationalNumber, parseZtoInternational, PROVIDER, ZTO_INTERNATIONAL_MAX_BYTES } from './parser.js';

/** The lookup the tracking page on m.ztoglobal.com makes for the number in its address. */
export const ZTO_INTERNATIONAL_API = 'https://taurus-api.ztoglobal.com/applet/track/queryFromMainSite';
const ORIGIN = 'https://m.ztoglobal.com';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /acw_sc__v2|aliyun_waf|_____tmd_____|<title>\s*(?:Just a moment|Attention Required|Access Denied|滑动验证|验证码)|_cf_chl_opt|cf-turnstile|g-recaptcha|hcaptcha/i;

export class ZtoInternationalTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeZtoInternationalNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // The page's own body. It also sends a signature of it, which the
      // service does not check, so none is sent.
      const body = JSON.stringify({ data: { data: [number], uuid: '', verificationCode: '' }, timestamp: Date.now(), version: '3.78.0', countryCode: 'LA' });
      const { response, bytes } = await fetchBounded(ZTO_INTERNATIONAL_API, { method: 'POST', signal, body, headers: {
        Accept: 'application/json', 'Content-Type': 'application/json', Origin: ORIGIN, Referer: `${ORIGIN}/`,
        'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: ZTO_INTERNATIONAL_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'ZTO International redirected its tracking lookup', { status: response.status });
      // Every waybill gets HTTP 200; a missing route is a moved service, not a missing waybill.
      if (!response.ok) throw new TransportError(PROVIDER, 'ZTO International tracking lookup is unavailable', { status: response.status });
      const text = decodeText(bytes);
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch (cause) {
        if (CHALLENGE.test(text.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'ZTO International answered with a browser check', { cause });
        throw new SchemaError(PROVIDER, 'ZTO International returned a reply that is not JSON', { cause });
      }
      return parseZtoInternational(payload, number);
    };
    // A request that fails to reach the service, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'zto-international', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ZtoInternationalTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'zto-international', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeZtoInternationalNumber(number))),
  };
};
