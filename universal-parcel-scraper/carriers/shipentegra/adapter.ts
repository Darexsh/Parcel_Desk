import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeShipentegraNumber, parseShipentegra, PROVIDER, SHIPENTEGRA_MAX_BYTES } from './parser.js';

/** The lookup the tracking page on track.shipentegra.com makes for each number typed in. */
export const SHIPENTEGRA_API = 'https://track.shipentegra.com/track_service.php';
const REDIRECTS = [301, 302, 303, 307, 308];
// A Cloudflare check, which could come in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required)/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'ShipEntegra answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'ShipEntegra returned a reply that is not JSON', { cause });
  }
}

export class ShipentegraTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeShipentegraNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // The page's own form: the nine digits as `tracking_number`.
      const body = new FormData();
      body.set('tracking_number', number);
      const { response, bytes } = await fetchBounded(SHIPENTEGRA_API, { method: 'POST', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      }, body }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: SHIPENTEGRA_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 400, 404, 410] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'ShipEntegra redirected its tracking lookup');
      // The tracker reads a missing parcel from a 200 reply; a 404 is a moved route.
      if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'ShipEntegra tracking lookup is unavailable');
      const payload = json(decodeText(bytes));
      // The lookup refuses a number shape it does not take with a 400 and {"status":false,"message":"…"}.
      if (response.status === 400) throw new SchemaError(PROVIDER, 'ShipEntegra refused the number');
      return parseShipentegra(payload, number);
    };
    // A request that fails to reach ShipEntegra, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'shipentegra', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ShipentegraTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'shipentegra', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeShipentegraNumber(number))),
  };
};
