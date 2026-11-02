import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizePanduLogisticsNumber, PANDU_LOGISTICS_MAX_BYTES, parsePanduLogistics, PROVIDER } from './parser.js';

/** The WordPress lookup the tracking page on pandulogistics.com posts the number to. */
export const PANDU_LOGISTICS_ENDPOINT = 'https://pandulogistics.com/wp-admin/admin-ajax.php';
const REDIRECTS = [301, 302, 303, 307, 308];
// WordPress answers 400 with "0" when no plugin handles the action any more, and a missing route is no missing parcel.
const GONE = [400, 404, 410];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|\/cdn-cgi\/challenge-platform\/|<title>\s*(?:Just a moment|Attention Required|Access Denied)|captcha/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Pandu Logistics answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Pandu Logistics returned a reply that is not JSON', { cause });
  }
}

export class PanduLogisticsTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizePanduLogisticsNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(PANDU_LOGISTICS_ENDPOINT, { method: 'POST', signal, headers: {
        Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'User-Agent': userAgentOf(this.options.userAgent),
      }, body: new URLSearchParams({ action: 'awb_tracking', awb: number }).toString() }, { provider: PROVIDER,
        timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: PANDU_LOGISTICS_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Pandu Logistics redirected its tracking lookup');
      if (GONE.includes(response.status)) {
        throw new TransportError(PROVIDER, 'Pandu Logistics tracking lookup is unavailable', { status: response.status });
      }
      return parsePanduLogistics(json(decodeText(bytes)), number);
    };
    // A request that fails to reach Pandu, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'pandu-logistics', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new PanduLogisticsTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'pandu-logistics', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizePanduLogisticsNumber(number))),
  };
};
