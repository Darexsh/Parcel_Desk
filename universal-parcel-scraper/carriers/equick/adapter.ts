import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { EQUICK_MAX_BYTES, normalizeEquickNumber, parseEquick, PROVIDER } from './parser.js';

/**
 * The lookup Equick's tracking page makes for the numbers typed in. The page
 * calls the same service on `api.equick.cn:8080` over plain HTTP; its HTTPS
 * host answers the same.
 */
export const EQUICK_API = 'https://api.equick.cn/api/traceQuery';
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route is not a missing parcel: an unknown number gets an empty result.
const GONE = [404, 405, 410];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied|403 Forbidden)|acw_sc__v2|aliyun_waf|_____tmd_____|captcha|<title>\s*(?:滑动验证|验证码|安全验证)/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Equick answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Equick returned a reply that is not JSON', { cause });
  }
}

export class EquickTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeEquickNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(EQUICK_API, { method: 'POST', signal, headers: {
        Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      }, body: JSON.stringify({ txtDanHao: number }) }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
        maxBytes: EQUICK_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Equick redirected its tracking lookup');
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'Equick tracking lookup is unavailable', { status: response.status });
      if (response.status !== 200) throw new IndeterminateError(PROVIDER, 'Equick did not answer with its tracking result');
      return parseEquick(json(decodeText(bytes)), number);
    };
    // A read that fails to reach Equick, or hangs, gets one more: the first gets
    // half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'equick', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new EquickTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'equick', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeEquickNumber(number))),
  };
};
