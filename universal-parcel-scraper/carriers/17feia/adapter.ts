import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeSeventeenFeiaNumber, parseSeventeenFeia, PROVIDER, SEVENTEENFEIA_MAX_BYTES } from './parser.js';

/** The lookup the tracking page on www.17feia.com makes for each number. */
export const SEVENTEENFEIA_API = 'https://www.17feia.com/public/v1/ordeSearch/listTrackInfos/';
const REDIRECTS = [301, 302, 303, 307, 308];
// The site's cookie check (cc.html sets `ccok` and reloads) and Aliyun's bot checks, which can come instead of the reply.
const CHALLENGE = /ccok=|acw_sc__v2|aliyun_waf|_____tmd_____|<title>\s*(?:Checking|滑动验证|验证码)/i;

export class SeventeenFeiaTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeSeventeenFeiaNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(`${SEVENTEENFEIA_API}${number}`, { method: 'GET', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: SEVENTEENFEIA_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
      if (REDIRECTS.includes(response.status)) {
        if (/\/cc\.html(?:[?#]|$)/.test(response.headers.get('location') ?? '')) throw new ChallengeError(PROVIDER, '17FEIA sent the lookup to its cookie check');
        throw new TransportError(PROVIDER, '17FEIA redirected its tracking lookup');
      }
      // The route answers every number; a missing route is a moved service, not a missing order.
      if (!response.ok) throw new TransportError(PROVIDER, '17FEIA tracking lookup is unavailable');
      const body = decodeText(bytes);
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch (cause) {
        if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, '17FEIA answered with a browser check', { cause });
        throw new SchemaError(PROVIDER, '17FEIA returned a reply that is not JSON', { cause });
      }
      return parseSeventeenFeia(payload, number);
    };
    // A request that fails to reach 17FEIA, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: '17feia', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new SeventeenFeiaTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: '17feia', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeSeventeenFeiaNumber(number))),
  };
};
