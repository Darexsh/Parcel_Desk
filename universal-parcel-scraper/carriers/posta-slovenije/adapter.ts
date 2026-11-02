import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, parseJsonBytes } from '../../core/transport/index.js';
import { isNotFoundReply, normalizePostaSlovenijeNumber, parsePostaSlovenije, POSTA_SLOVENIJE_MAX_BYTES, PROVIDER } from './parser.js';

// The guest lookup of Pošta Slovenije's MojaPošta app and web tracker. The
// web tracker sends an invisible reCAPTCHA token with it; the app sends none,
// and the service answers a client that names itself as the app.
export const POSTA_SLOVENIJE_ENDPOINT = 'https://moja.posta.si/api/v1/parcels/track/';
// The app's own User-Agent, "MojaPosta/<version> (<platform>)". The service
// refuses other clients without a reCAPTCHA token.
export const POSTA_SLOVENIJE_USER_AGENT = 'MojaPosta/2.5.0 (android)';
// The service's own JSON refusals: an unknown number, and a client it does not let in.
const ANSWERS = [403, 404];
// An edge or firewall page, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Just a moment|Access Denied|Attention Required|403 Forbidden)|_cf_chl_opt|cf-turnstile|Azure Front Door|Request blocked/i;

export class PostaSlovenijeTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizePostaSlovenijeNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // No Content-Type: on a GET the service reads it as an empty JSON body and answers 400.
      const { response, bytes } = await fetchBounded(`${POSTA_SLOVENIJE_ENDPOINT}?TrackingNumber=${encodeURIComponent(number)}`, {
        signal, headers: { Accept: 'application/json', 'User-Agent': POSTA_SLOVENIJE_USER_AGENT },
      }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: POSTA_SLOVENIJE_MAX_BYTES,
        allowHttpStatuses: ANSWERS, fetcher: this.options.fetcher });
      let payload: unknown;
      try { payload = parseJsonBytes(bytes, PROVIDER); }
      catch (cause) {
        if (response.status === 403 || BLOCKED.test(decodeText(bytes.subarray(0, 64_000)))) {
          throw new ChallengeError(PROVIDER, 'Pošta Slovenije answered with a block page', { cause });
        }
        if (response.status === 404) throw new TransportError(PROVIDER, 'Pošta Slovenije tracking service is unavailable', { cause });
        throw new SchemaError(PROVIDER, 'Pošta Slovenije returned invalid tracking JSON', { cause });
      }
      if (response.status === 404) {
        // Only the service's own notice for this number is a missing parcel; a missing route is not.
        if (isNotFoundReply(payload, number)) throw new NotFoundError(PROVIDER);
        throw new TransportError(PROVIDER, 'Pošta Slovenije tracking service is unavailable');
      }
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'Pošta Slovenije refused the app\'s guest lookup');
      return parsePostaSlovenije(payload, number);
    };
    // A request that fails to reach Pošta Slovenije, or hangs, gets one more
    // try: the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'posta-slovenije', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new PostaSlovenijeTracker({ fetcher: environment.fetcher, recorder: environment.recorder });
  return {
    id: 'posta-slovenije', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizePostaSlovenijeNumber(number))),
  };
};
