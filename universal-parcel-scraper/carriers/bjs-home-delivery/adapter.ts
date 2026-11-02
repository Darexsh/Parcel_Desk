import { accepted, type AdapterFactory, type Recognition, type TrackingContext } from '../../core/adapter/index.js';
import { carrierErrorKind, ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { BJS_MAX_BYTES, normalizeBjsNumber, parseBjs, printedBjsNumber, PROVIDER } from './parser.js';

/** The lookup the tracker's mini-track page makes for the number typed in. */
export const BJS_MINI_TRACK = 'https://api.bjshomedelivery.com/v1/website/mini_track';
// The key the tracker's page script sends with every lookup, the same for every visitor.
const KEY = '9D4754746BC27BFEAC96EDA2B3525'; // gitleaks:allow
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route is not a missing order: an unknown reference gets the tracker's own notice.
const GONE = [404, 410];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required)|AwsWafIntegration|awswaf\.com|captcha/i;

/** The mini tracker's lookup for one consignment, as its page sends it. */
export function bjsLookupUrl(raw: string): string {
  return `${BJS_MINI_TRACK}?${new URLSearchParams({ OrderReference: printedBjsNumber(raw) })}`;
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'BJS answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'BJS returned a reply that is not JSON', { cause });
  }
}

export class BjsHomeDeliveryTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; now?: () => number } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeBjsNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(bjsLookupUrl(number), { method: 'GET', signal, headers: {
        Accept: 'application/json', Key: KEY, OrderReference: printedBjsNumber(number), 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: BJS_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 400, 401] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'BJS redirected its tracking lookup');
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'BJS tracking lookup is unavailable', { status: response.status });
      const payload = json(decodeText(bytes));
      // The API refuses a request without the page's key with HTTP 401, "Unauthorised. Invalid 'Key'".
      if (response.status === 401) throw new ChallengeError(PROVIDER, 'BJS refused the tracker\'s key', { status: 401 });
      // HTTP 400 carries the tracker's answer to an unknown reference; a found order is HTTP 200.
      if (response.status === 400 && !(isRecord(payload) && payload.success === false)) {
        throw new SchemaError(PROVIDER, 'BJS returned an order with HTTP 400');
      }
      return parseBjs(payload, number, (this.options.now ?? Date.now)());
    };
    // A request that fails to reach BJS, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'bjs-home-delivery', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }

  /**
   * The lookup answers only the orders BJS holds, so a row for the whole
   * consignment is known whatever its status. Its day is a UK calendar day,
   * which cannot date the last activity.
   */
  async recognize(number: string, context: TrackingContext = {}): Promise<Recognition> {
    if (!accepted(() => normalizeBjsNumber(number))) return { known: false };
    try {
      await this.fetch(number, context);
    } catch (error) {
      if (['not_found', 'invalid_input'].includes(carrierErrorKind(error) ?? '')) return { known: false };
      throw error;
    }
    return { known: true, lastActivityAt: null };
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new BjsHomeDeliveryTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'bjs-home-delivery', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => tracker.recognize(number, context),
  };
};
