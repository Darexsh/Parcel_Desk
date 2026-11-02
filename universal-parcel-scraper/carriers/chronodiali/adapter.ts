import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CHRONODIALI_MAX_BYTES, normalizeChronodialiNumber, parseChronodiali, PROVIDER } from './parser.js';

/** The Shipsy lookup the tracking page on chronodiali.ma makes for the number typed in. */
export const CHRONODIALI_API = 'https://projectxuaeapi.shipsy.io/api/client/integration/consignment/track';
// The key the tracking page's script sends with every lookup, the same for every visitor.
// It is Chronodiali's own account, so the reply is Chronodiali's.
const KEY = '411b8664cdabe621fd945b8fa287e7'; // gitleaks:allow
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required)|AwsWafIntegration|awswaf\.com|captcha/i;

/** The tracker's lookup for one number, as the page sends it. */
export function chronodialiLookupUrl(raw: string): string {
  return `${CHRONODIALI_API}?${new URLSearchParams({ reference_number: normalizeChronodialiNumber(raw) })}`;
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Chronodiali answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Chronodiali returned a reply that is not JSON', { cause });
  }
}

export class ChronodialiTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeChronodialiNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(chronodialiLookupUrl(number), { method: 'GET', signal, headers: {
        Accept: 'application/json', 'api-key': KEY, 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: CHRONODIALI_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 400, 401, 404, 410] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Chronodiali redirected its tracking lookup');
      // An unknown number is HTTP 400 with the tracker's own message; a 404 is a moved route.
      if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'Chronodiali tracking lookup is unavailable');
      const payload = json(decodeText(bytes));
      // Shipsy refuses a missing or withdrawn key with HTTP 401, "Wrong API key".
      if (response.status === 401) throw new ChallengeError(PROVIDER, 'Chronodiali refused the tracking page\'s key', { status: 401 });
      return parseChronodiali(payload, number);
    };
    // A request that fails to reach the service, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'chronodiali', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ChronodialiTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'chronodiali', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeChronodialiNumber(number))),
  };
};
