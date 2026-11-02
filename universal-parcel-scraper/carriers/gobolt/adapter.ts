import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { GOBOLT_MAX_BYTES, normalizeGoboltNumber, parseGobolt, PROVIDER } from './parser.js';

/** The lookup the tracking page on track.gobolt.com makes for the number in its address. */
export const GOBOLT_API = 'https://api.secondcloset.com/logistics/api/v1/bolt_shipping_labels/search';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks Cloudflare, in front of the service, could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|<title>\s*Attention Required|cf-error-details/i;

/** The lookup's address for one number. */
export function goboltLookupUrl(number: string): string {
  return `${GOBOLT_API}?tracking_number=${encodeURIComponent(normalizeGoboltNumber(number))}`;
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'GoBolt answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'GoBolt returned a reply that is not JSON', { cause });
  }
}

export class GoboltTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeGoboltNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(goboltLookupUrl(number), { method: 'GET', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: GOBOLT_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'GoBolt redirected its tracking lookup');
      if (response.status === 410) throw new TransportError(PROVIDER, 'GoBolt tracking lookup is unavailable');
      const body = decodeText(bytes);
      if (response.status === 404) {
        // The page reads an unknown or expired number from a 404 with its error reply; another 404 is a moved route.
        let payload: unknown;
        try {
          payload = JSON.parse(body);
        } catch {
          payload = null;
        }
        if (!isRecord(payload) || payload.type !== 'error') throw new TransportError(PROVIDER, 'GoBolt tracking lookup is unavailable');
        return parseGobolt(payload, number);
      }
      return parseGobolt(json(body), number);
    };
    // A request that fails to reach the service, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'gobolt', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new GoboltTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'gobolt', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeGoboltNumber(number))),
  };
};
