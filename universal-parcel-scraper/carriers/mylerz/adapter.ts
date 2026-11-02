import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { MYLERZ_MAX_BYTES, normalizeMylerzNumber, parseMylerz, PROVIDER } from './parser.js';

/**
 * The tracking API of each country's Mylerz instance. Each knows only its own
 * country's parcels. Egypt's, the one the tracker on mylerz.net asks, goes
 * first. Tunisia's host accepts no connection, so it is not asked.
 */
export const MYLERZ_HOSTS = ['api.mylerz.net', 'api.morocco.mylerz.net', 'api.algeria.mylerz.net', 'api.jordan.mylerz.net'] as const;
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|AwsWafIntegration|awswaf\.com|Microsoft-Azure-Application-Gateway|The request is blocked/i;

/** The lookup each instance's tracker makes for a barcode. */
export function mylerzTrackingUrl(host: (typeof MYLERZ_HOSTS)[number], number: string): string {
  return `https://${host}/api/package/GetPackageTrackingDetailsByBarCode?barcode=${encodeURIComponent(number)}`;
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Mylerz answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Mylerz returned a reply that is not JSON', { cause });
  }
}

type Answer = { result: CarrierResult } | { error: unknown };
const settle = (lookup: Promise<CarrierResult>): Promise<Answer> => lookup.then((result) => ({ result }), (error: unknown) => ({ error }));

export class MylerzTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async #lookup(host: (typeof MYLERZ_HOSTS)[number], number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(mylerzTrackingUrl(host, number), { method: 'GET', signal, headers: {
      Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs, maxBytes: MYLERZ_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
      allowHttpStatuses: [...REDIRECTS, 403, 404, 410] });
    if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Mylerz redirected its tracking lookup');
    // The API reads a missing barcode from a 200 reply; a 404 is a moved route.
    if (response.status === 404 || response.status === 410) {
      throw new TransportError(PROVIDER, 'Mylerz tracking lookup is unavailable', { status: response.status });
    }
    if (response.status === 403) throw new ChallengeError(PROVIDER, 'Mylerz refused the lookup', { status: 403 });
    return parseMylerz(json(decodeText(bytes)), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeMylerzNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      const left = () => Math.max(1, Math.floor(deadline - performance.now()));
      const [home, ...abroad] = MYLERZ_HOSTS;
      const first = await settle(this.#lookup(home, number, signal, left()));
      if ('result' in first) return first.result;
      if (signal.aborted) throw first.error;
      // A barcode Egypt does not know can be another country's. Those are asked
      // at once; only every instance's not-found is a missing parcel, and any
      // other failure leaves the answer open.
      const answers = [first, ...await Promise.all(abroad.map((host) => settle(this.#lookup(host, number, signal, left()))))];
      const found = answers.flatMap((answer) => ('result' in answer ? [answer.result] : []));
      if (found.length > 1) throw new IndeterminateError(PROVIDER, 'Mylerz has the barcode in more than one country');
      if (found.length === 1) return found[0]!;
      const failure = answers.find((answer) => 'error' in answer && !(answer.error instanceof NotFoundError));
      if (failure && 'error' in failure) throw failure.error;
      throw new NotFoundError(PROVIDER);
    };
    // A lookup that fails to reach an instance or hangs gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'mylerz', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new MylerzTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'mylerz', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeMylerzNumber(number))),
  };
};
