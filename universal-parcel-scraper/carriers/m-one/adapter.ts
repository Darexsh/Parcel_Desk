import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, NotFoundError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { M_ONE_MAX_BYTES, normalizeMOneNumber, parseMOne, PROVIDER } from './parser.js';

/** The lookup the tracker on M-ONE's home page makes, with the number appended. */
export const M_ONE_API = 'https://api.m-one.rs/api/statushistory/';
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required|Access denied)/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'M-ONE answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'M-ONE returned a reply that is not JSON', { cause });
  }
}

/**
 * The tracker's answer for a number it does not hold: HTTP 404 with no
 * content type and a body that never ends. The bounded transport reads only a
 * short prefix of a refused body, so the answer comes at once. A 404 with a
 * page or JSON in it is a moved route.
 */
function isUnknownNumber(error: UpstreamHttpError): boolean {
  return error.status === 404 && error.diagnostics?.content_type === 'missing' && error.diagnostics.bytes_inspected === 0;
}

export class MOneTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeMOneNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      try {
        const { bytes } = await fetchBounded(`${M_ONE_API}${encodeURIComponent(number)}`, { method: 'GET', signal, headers: {
          Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
        } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: M_ONE_MAX_BYTES, fetcher: this.options.fetcher });
        return parseMOne(json(decodeText(bytes)), number);
      } catch (error) {
        if (error instanceof UpstreamHttpError && (error.status === 404 || error.status === 410)) {
          if (isUnknownNumber(error)) throw new NotFoundError(PROVIDER, undefined, { cause: error });
          throw new TransportError(PROVIDER, 'M-ONE tracking lookup is unavailable', { cause: error });
        }
        throw error;
      }
    };
    // A read that fails to reach the API, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'm-one', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new MOneTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'm-one', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeMOneNumber(number))),
  };
};
