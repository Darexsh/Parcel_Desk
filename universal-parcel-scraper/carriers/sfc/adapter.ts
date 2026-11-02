import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeSfcNumber, parseSfc, PROVIDER, SFC_MAX_BYTES } from './parser.js';

/** The lookup the tracking page on www.sendfromchina.com makes for each number. */
export const SFC_API = 'https://www.sendfromchina.com/track/track/get-track-for-web';
const REDIRECTS = [301, 302, 303, 307, 308];
// Aliyun's firewall, in front of the site, can put its bot check or block page in place of the reply.
const CHALLENGE = /acw_sc__v2|aliyun_waf|_____tmd_____|potential threats to the server|<title>\s*(?:滑动验证|验证码)/i;

export class SfcTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeSfcNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(SFC_API, { method: 'POST', signal, headers: {
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': userAgentOf(this.options.userAgent),
      }, body: new URLSearchParams({ tracknumber: number }).toString() }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
        maxBytes: SFC_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 405, 410] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'SFC redirected its tracking lookup');
      // The lookup answers every number with HTTP 200; a missing route is a moved service.
      if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'SFC tracking lookup is unavailable');
      // Aliyun's firewall answers a refused client with 403 or 405 and its block page.
      if (response.status === 403 || response.status === 405) throw new ChallengeError(PROVIDER, 'SFC refused the lookup', { status: response.status });
      const body = decodeText(bytes);
      let payload: unknown;
      try {
        payload = JSON.parse(body.replace(/^\uFEFF/, ''));
      } catch (cause) {
        if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'SFC answered with a browser check', { cause });
        throw new SchemaError(PROVIDER, 'SFC returned a reply that is not JSON', { cause });
      }
      return parseSfc(payload, number);
    };
    // A request that fails to reach SFC, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'sfc', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new SfcTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'sfc', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeSfcNumber(number))),
  };
};
