import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeWinitNumber, parseWinit, PROVIDER, WINIT_MAX_BYTES } from './parser.js';

/** The lookup WINIT's tracking pages make for the numbers in their address. */
export const WINIT_API = 'https://track.winit.com/tracking/Index/getTracking';
const REDIRECTS = [301, 302, 303, 307, 308];
// Huawei Cloud's firewall, in front of the tracker, can put its block page or check in place of the reply.
const CHALLENGE = /HWWAF|huaweicloud|hwclouds|访问被拦截|请求疑似|<title>\s*(?:403|Forbidden|Access denied|Request blocked|验证码|人机验证)|captcha/i;

export class WinitTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeWinitNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(WINIT_API, { method: 'POST', signal, headers: {
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': userAgentOf(this.options.userAgent),
      }, body: new URLSearchParams({ trackingNoString: number }).toString() }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
        maxBytes: WINIT_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 405, 410, 418] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'WINIT redirected its tracking lookup');
      // The lookup answers every number with HTTP 200; a missing route is a moved service.
      if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'WINIT tracking lookup is unavailable');
      if ([403, 405, 418].includes(response.status)) throw new ChallengeError(PROVIDER, 'WINIT refused the lookup', { status: response.status });
      const body = decodeText(bytes);
      let payload: unknown;
      try {
        payload = JSON.parse(body.replace(/^\uFEFF/, ''));
      } catch (cause) {
        if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'WINIT answered with its firewall\'s page', { cause });
        throw new SchemaError(PROVIDER, 'WINIT returned a reply that is not JSON', { cause });
      }
      return parseWinit(payload, number);
    };
    // A request that fails to reach WINIT, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'winit', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new WinitTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'winit', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeWinitNumber(number))),
  };
};
