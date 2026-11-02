import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CARRIER, ILYANG_MAX_BYTES, normalizeIlyangNumber, parseIlyang, PROVIDER } from './parser.js';

/** The lookup the tracking result page on www.ilyanglogis.co.kr makes for a waybill. */
export const ILYANG_API = 'https://www.ilyanglogis.co.kr/tracking/trackingByDeliNo.do';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required|Access Denied)|g-recaptcha|h-captcha|AwsWafIntegration|awswaf\.com/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Ilyang Logis answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Ilyang Logis returned a reply that is not JSON', { cause });
  }
}

export class IlyangLogisTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeIlyangNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // The page's form post: the waybill and its tracking type, with no session, token or key.
      const { response, bytes } = await fetchBounded(ILYANG_API, { method: 'POST', signal, headers: {
        Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
        'User-Agent': userAgentOf(this.options.userAgent),
      }, body: new URLSearchParams({ trackingType: '0', blNum: number }).toString() }, { provider: PROVIDER,
        timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: ILYANG_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
        allowHttpStatuses: [...REDIRECTS, 404, 405, 410] });
      // The lookup answers an unknown number with HTTP 200; anything else is a moved route.
      if (!response.ok) throw new TransportError(PROVIDER, 'Ilyang Logis tracking lookup is unavailable');
      return parseIlyang(json(decodeText(bytes)), number);
    };
    // A request that fails to reach the site, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new IlyangLogisTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeIlyangNumber(number))),
  };
};
