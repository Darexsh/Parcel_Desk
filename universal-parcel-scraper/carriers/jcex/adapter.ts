import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import type { Dispatcher } from 'undici';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, isNetworkFailure, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { JCEX_MAX_BYTES, normalizeJcexNumber, parseJcex, PROVIDER } from './parser.js';
import { withJcexOrigin } from './origin.js';

/** The lookup track.jcex.com makes for the numbers typed in. */
export const JCEX_API = 'https://track.jcex.com/api/track/tracking';
const JCEX_ORIGIN = 'https://track.jcex.com';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /acw_sc__v2|aliyun_waf|_____tmd_____|<title>\s*(?:Just a moment|Attention Required|Access Denied|滑动验证|验证码)|_cf_chl_opt|cf-turnstile|g-recaptcha|hcaptcha/i;

export class JcexTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeJcexNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number, dispatcher?: Dispatcher): Promise<CarrierResult> => {
      const request = { method: 'POST', signal, body: JSON.stringify({ numberList: [number] }), headers: {
        Accept: 'application/json', 'Content-Type': 'application/json', Origin: JCEX_ORIGIN, Referer: `${JCEX_ORIGIN}/`,
        'User-Agent': userAgentOf(this.options.userAgent),
      }, ...(dispatcher ? { dispatcher } : {}) };
      const { response, bytes } = await fetchBounded(JCEX_API, { ...request, signal }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: JCEX_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'JCEX redirected its tracking lookup', { status: response.status });
      // The route answers every number with HTTP 200; a missing route is a moved service, not a missing waybill.
      if (!response.ok) throw new TransportError(PROVIDER, 'JCEX tracking lookup is unavailable', { status: response.status });
      const body = decodeText(bytes);
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch (cause) {
        if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'JCEX answered with a browser check', { cause });
        throw new SchemaError(PROVIDER, 'JCEX returned a reply that is not JSON', { cause });
      }
      return parseJcex(payload, number);
    };
    // A failed CDN connection first tries the origin with verified TLS. A
    // second failed connection can still use the existing ordinary retry.
    return runSteps({ carrier: 'jcex', budgetMs: context.budgetMs ?? 30_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(Math.min(15_000, remainingMs))) },
      { id: 'origin', recovers: isNetworkFailure, run: ({ signal, remainingMs }) => {
        const timeoutMs = Math.max(1, Math.min(10_000, Math.floor(remainingMs)));
        return withJcexOrigin(signal, timeoutMs, dispatcher => read(signal, timeoutMs, dispatcher));
      } },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new JcexTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'jcex', recordsSteps: true, steps: ['direct', 'origin', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
