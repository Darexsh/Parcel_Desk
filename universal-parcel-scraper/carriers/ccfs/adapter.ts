import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CCFS_MAX_BYTES, normalizeCcfsNumber, parseCcfs, PROVIDER } from './parser.js';

/** The lookup the shipment page at `auth.ccfs.com/track/detail/{number}` makes for the number in its address. */
export const CCFS_ENDPOINT = 'https://auth.ccfs.com/api/web/V2/Consignments/Basics';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|<title>\s*Attention Required|AwsWafIntegration|awswaf\.com|captcha/i;

/** The lookup's address for one whole number, with the parameters the page sends. */
export function ccfsLookupUrl(number: string): string {
  const value = normalizeCcfsNumber(number);
  return `${CCFS_ENDPOINT}?${new URLSearchParams([['TrackingNum', value], ['TrackingNum', value], ['Descending', 'false']])}`;
}

export class CcfsTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeCcfsNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(ccfsLookupUrl(number), { method: 'GET', signal, headers: {
        Accept: 'application/json, text/plain, */*', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: CCFS_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'CCFS redirected its tracking lookup');
      if (response.status === 410) throw new TransportError(PROVIDER, 'CCFS tracking lookup is unavailable');
      const body = decodeText(bytes);
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch (cause) {
        if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'CCFS answered with a browser check', { cause });
        // A missing route can answer with a page of its own; only the JSON answer naming the number is not found.
        if (response.status === 404) throw new TransportError(PROVIDER, 'CCFS tracking lookup is unavailable', { cause });
        throw new SchemaError(PROVIDER, 'CCFS returned a reply that is not JSON', { cause });
      }
      return parseCcfs({ status: response.status, body: payload }, number);
    };
    // A request that fails to reach CCFS, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'ccfs', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new CcfsTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'ccfs', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeCcfsNumber(number))),
  };
};
