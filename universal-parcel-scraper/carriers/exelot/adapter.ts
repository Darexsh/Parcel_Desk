import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { EXELOT_MAX_BYTES, normalizeExelotNumber, parseExelot, PROVIDER } from './parser.js';

/** The lookup the tracker page on go.exelot.com makes, anonymously, for the numbers in its address. */
export const EXELOT_API = 'https://apiv2p.exelot.com/api/v2/parcels/tracking/details/';
// Bot checks and firewall pages a CDN could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|captcha|_Incapsula_Resource|datadome/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Exelot answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Exelot returned a reply that is not JSON', { cause });
  }
}

export class ExelotTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeExelotNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(`${EXELOT_API}${encodeURIComponent(number)}?lang=en`, { method: 'GET', signal,
        headers: { Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) } },
      { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: EXELOT_MAX_BYTES,
        fetcher: this.options.fetcher, allowHttpStatuses: [404, 410] });
      // The lookup answers an unknown number with HTTP 200; a 404 is a moved route.
      if (response.status !== 200) throw new TransportError(PROVIDER, 'Exelot tracking lookup is unavailable', { status: response.status });
      return parseExelot(json(decodeText(bytes)), number);
    };
    // A request that fails to reach Exelot, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'exelot', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ExelotTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'exelot', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeExelotNumber(number))),
  };
};
