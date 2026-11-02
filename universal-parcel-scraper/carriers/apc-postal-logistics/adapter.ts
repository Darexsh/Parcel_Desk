import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { isRecord } from '../../core/types.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { APC_MAX_BYTES, CARRIER, normalizeApcNumber, parseApcPostalLogistics, PROVIDER } from './parser.js';

/** The lookup the tracker page on tracking.apc-pli.com makes, anonymously, for the number in its address. */
export const APC_API = 'https://tracking.apc-pli.com/api/track?id=';
// Bot checks and firewall pages a CDN could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|captcha|_Incapsula_Resource|datadome/i;
// What the lookup answers, with HTTP 500, when it has nothing to show.
const FAILED = 'Failed to fetch tracking data';

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'APC answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'APC returned a reply that is not JSON', { cause });
  }
}

/** A reply other than a parcel. None of them says the parcel is missing. */
function refusal(status: number, body: string): never {
  if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'APC answered with a browser check', { status });
  if (status === 500) {
    let reply: unknown;
    try {
      reply = JSON.parse(body);
    } catch {
      reply = undefined;
    }
    // The lookup gives this one answer for numbers it does not have, for labels
    // it has not received yet and for lookups that failed, so it is not an absence.
    if (isRecord(reply) && reply.error === true && reply.statusMessage === FAILED) {
      throw new IndeterminateError(PROVIDER, 'APC\'s tracker found nothing it could show for the number', { status });
    }
    throw new IndeterminateError(PROVIDER, 'APC returned HTTP 500', { status });
  }
  // The route needs nothing but the number; a 404 is a moved route.
  throw new TransportError(PROVIDER, 'APC tracking lookup is unavailable', { status });
}

export class ApcPostalLogisticsTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeApcNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(`${APC_API}${encodeURIComponent(number)}`, { method: 'GET', signal,
        headers: { Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) } },
      { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: APC_MAX_BYTES,
        fetcher: this.options.fetcher, allowHttpStatuses: [404, 410, 500] });
      const body = decodeText(bytes);
      if (response.status !== 200) refusal(response.status, body);
      return parseApcPostalLogistics(json(body), number);
    };
    // A request that fails to reach APC, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ApcPostalLogisticsTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
