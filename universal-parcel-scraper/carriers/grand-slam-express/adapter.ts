import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { GRAND_SLAM_LOOKUP, GRAND_SLAM_MAX_BYTES, normalizeGrandSlamNumber, parseGrandSlam, PROVIDER } from './parser.js';

export { GRAND_SLAM_LOOKUP } from './parser.js';
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route is not a missing parcel: the lookup answers an unknown number with its message.
const GONE = [404, 410];
// Bot checks and firewall pages a CDN or the host could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|\/cdn-cgi\/challenge-platform\/|_Incapsula_Resource|errors\.edgesuite\.net|requested URL was rejected|g-recaptcha|h-captcha|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)/i;

function json(body: string): unknown {
  if (!body.trim()) throw new IndeterminateError(PROVIDER, 'Grand Slam Express returned an empty reply');
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Grand Slam Express answered with a block page', { cause });
    throw new SchemaError(PROVIDER, 'Grand Slam Express returned a reply that is not JSON', { cause });
  }
}

export class GrandSlamTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeGrandSlamNumber(raw);
    // The tracking page's script posts the number as `AwbNo`, as jQuery serializes a form.
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(GRAND_SLAM_LOOKUP, { method: 'POST', signal, headers: {
        Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'User-Agent': userAgentOf(this.options.userAgent),
      }, body: new URLSearchParams({ AwbNo: number }).toString() }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
        maxBytes: GRAND_SLAM_MAX_BYTES, redirect: 'manual', allowHttpStatuses: [...REDIRECTS, ...GONE], fetcher: this.options.fetcher });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Grand Slam Express redirected its tracking lookup');
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'Grand Slam Express tracking lookup is unavailable', { status: response.status });
      return parseGrandSlam(json(decodeText(bytes)), number);
    };
    // A request that fails to reach the lookup, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'grand-slam-express', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new GrandSlamTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'grand-slam-express', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
