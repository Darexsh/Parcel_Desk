import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { normalizeQuiqupNumber, parseQuiqup, PROVIDER, QUIQUP_MAX_BYTES } from './parser.js';

/** The lookup the tracking page on track-parcel.quiqup.com makes for an order number typed in. */
export const QUIQUP_API = 'https://ex-api.quiqup.com/order_management/tracking';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required)|AwsWafIntegration|awswaf\.com|captcha/i;

/** The lookup's address for one order number, without the phone number the page adds only to see more. */
export function quiqupLookupUrl(number: string): string {
  return `${QUIQUP_API}?order_id=${encodeURIComponent(normalizeQuiqupNumber(number))}`;
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Quiqup answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Quiqup returned a reply that is not JSON', { cause });
  }
}

/** The service's own answer to an order number it does not know: `{"error":"Incorrect order id or phone number"}`. */
function unknownOrder(reply: unknown): boolean {
  return isRecord(reply) && typeof reply.error === 'string' && /incorrect order id/i.test(reply.error);
}

export class QuiqupTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeQuiqupNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(quiqupLookupUrl(number), { method: 'GET', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: QUIQUP_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410, 422] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Quiqup redirected its tracking lookup');
      // The service reads a missing order from a 422 reply; a 404 is a moved route.
      if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'Quiqup tracking lookup is unavailable', { status: response.status });
      const reply = json(decodeText(bytes));
      if (response.status === 422) {
        if (unknownOrder(reply)) throw new NotFoundError(PROVIDER);
        throw new SchemaError(PROVIDER, 'Quiqup refused the lookup', { status: 422 });
      }
      return parseQuiqup(reply, number);
    };
    return runSteps({ carrier: 'quiqup', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, remainingMs) },
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new QuiqupTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'quiqup', recordsSteps: true, steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
