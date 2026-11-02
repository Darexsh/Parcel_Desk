import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { COLLIVERY_MAX_BYTES, normalizeColliveryNumber, parseCollivery, PROVIDER } from './parser.js';

/** The lookup collivery.net's tracking page makes for the waybill typed in. */
export const COLLIVERY_TRACKING = 'https://collivery.net/ajax/waybill/tracking/';
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 410];
const DEFAULT_BUDGET_MS = 15_000;
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|AwsWafIntegration|awswaf\.com/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Collivery answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Collivery returned a reply that is not JSON', { cause });
  }
}

export class ColliveryTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // The page asks for JSON; without it, an unknown waybill gets the site's HTML 404 page.
    const { response, bytes } = await fetchBounded(`${COLLIVERY_TRACKING}${number}`, { method: 'GET', signal, headers: {
      Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: COLLIVERY_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE] });
    if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Collivery redirected its tracking lookup', { status: response.status });
    const body = decodeText(bytes);
    if (GONE.includes(response.status)) {
      // A waybill Collivery has no record of is HTTP 404 with this message, which
      // the page reports as not found; a missing route answers 404 with an empty one.
      let reply: unknown;
      try {
        reply = JSON.parse(body);
      } catch {
        reply = null;
      }
      if (response.status === 404 && isRecord(reply) && reply.message === 'Document not found') throw new NotFoundError(PROVIDER);
      throw new TransportError(PROVIDER, 'Collivery tracking lookup is unavailable', { status: response.status });
    }
    return parseCollivery(json(body), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeColliveryNumber(raw);
    // A read that fails to reach Collivery, or hangs, is sent once more: the
    // first try gets half of the budget.
    return runSteps({ carrier: 'mds-collivery', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ColliveryTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'mds-collivery', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeColliveryNumber(number))),
  };
};
