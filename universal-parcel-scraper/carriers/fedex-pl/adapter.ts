import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { FEDEX_PL_MAX_BYTES, normalizeFedexPlNumber, parseFedexPl, PROVIDER } from './parser.js';

/** The lookup the domestic tracking app on fds2tracking.emea.fedex.com makes for one number. */
export const FEDEX_PL_API = 'https://poland.fedex.com/fds2-tracking/trck-v1/info';
const REDIRECTS = [301, 302, 303, 307, 308];
// The page's answers besides a shipment: an unknown number, and one it does not show.
const UNKNOWN = 204;
const WITHHELD = 240;
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|<title>\s*Access Denied|errors\.edgesuite\.net|_Incapsula_Resource|captcha/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'FedEx Poland answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'FedEx Poland returned a reply that is not JSON', { cause });
  }
}

/** The service's refusal of a number it does not accept, as `{"code":"trck-1400",…}`. */
function refusal(body: string): never {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    payload = null;
  }
  if (isRecord(payload) && payload.code === 'trck-1400') throw new InvalidInputError(PROVIDER, 'FedEx Poland rejected the number', { reason: 'wrong_number' });
  throw new TransportError(PROVIDER, 'FedEx Poland rejected the tracking request', { status: 400 });
}

export class FedexPlTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeFedexPlNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const url = `${FEDEX_PL_API}?trackingKey=${number}`;
      const { response, bytes } = await fetchBounded(url, { signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: FEDEX_PL_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 400, 404, 410] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'FedEx Poland redirected its tracking lookup');
      // The page reads an unknown number from an empty 204: a 404 is a moved route.
      if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'FedEx Poland tracking lookup is unavailable');
      const body = decodeText(bytes);
      if (response.status === 400) refusal(body);
      if (response.status === UNKNOWN && !body.trim()) throw new NotFoundError(PROVIDER);
      // The page tells the visitor to call customer service: the number may exist.
      if (response.status === WITHHELD) throw new IndeterminateError(PROVIDER, 'FedEx Poland does not show this number and refers to its customer service');
      if (response.status !== 200) throw new IndeterminateError(PROVIDER, `FedEx Poland answered HTTP ${response.status}`);
      return parseFedexPl(json(body), number);
    };
    // A request that fails to reach the service, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'fedex-pl', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new FedexPlTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'fedex-pl', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeFedexPlNumber(number))),
  };
};
