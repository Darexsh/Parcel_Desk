import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeSpeedafNumber, parseSpeedaf, PROVIDER, SPEEDAF_MAX_BYTES } from './parser.js';

/** The lookup the tracking page on www.speedaf.com makes for the numbers typed in. */
export const SPEEDAF_API = 'https://www.speedaf.com/publicservice/v1/api/express/track/listExpressTrack';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply. The site sits behind Aliyun's firewall.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|_____tmd_____|<title>\s*(?:滑动验证|验证码|安全验证)/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Speedaf answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Speedaf returned a reply that is not JSON', { cause });
  }
}

export class SpeedafTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeSpeedafNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(SPEEDAF_API, { method: 'POST', signal, headers: {
        Accept: 'application/json', 'Content-Type': 'application/json; charset=UTF-8', 'User-Agent': userAgentOf(this.options.userAgent),
      }, body: JSON.stringify({ mailNoList: [number] }) }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
        maxBytes: SPEEDAF_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Speedaf redirected its tracking lookup');
      // The service answers every number with HTTP 200; a 404 is a moved route, not an unknown parcel.
      if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'Speedaf tracking lookup is unavailable');
      return parseSpeedaf(json(decodeText(bytes)), number);
    };
    // A request that fails to reach the site, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'speedaf', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new SpeedafTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'speedaf', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeSpeedafNumber(number))),
  };
};
