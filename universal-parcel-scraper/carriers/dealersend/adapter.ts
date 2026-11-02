import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, MaintenanceError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CARRIER, DEALERSEND_MAX_BYTES, normalizeDealerSendNumber, parseDealerSend, PROVIDER } from './parser.js';

/** The lookup DealerSend's tracking page makes; it takes several numbers, and the adapter asks for one. */
export const DEALERSEND_TRACKING_API = 'https://dealer-send.com/myapi/trackings/track';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied)|captcha/i;
const DEFAULT_BUDGET_MS = 15_000;

/** The lookup's address for one number. */
export function dealerSendTrackingUrl(number: string): string {
  return `${DEALERSEND_TRACKING_API}?trackingNumbers=${encodeURIComponent(number)}`;
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'DealerSend answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'DealerSend returned a reply that is not JSON', { cause });
  }
}

export class DealerSendTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; now?: () => number } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(dealerSendTrackingUrl(number), { method: 'GET', signal, headers: {
      Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: DEALERSEND_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 410, 503] });
    const { status } = response;
    // The tracker answers an unknown number with HTTP 200 and null: a 404 or a redirect is a moved route, not a missing parcel.
    if (REDIRECTS.includes(status) || status === 404 || status === 410) {
      throw new TransportError(PROVIDER, 'DealerSend tracking lookup is unavailable', { status });
    }
    if (status === 403) throw new ChallengeError(PROVIDER, 'DealerSend refused the lookup', { status });
    if (status === 503) {
      if (CHALLENGE.test(decodeText(bytes).slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'DealerSend answered with a browser check', { status });
      throw new MaintenanceError(PROVIDER, 'DealerSend tracking is unavailable for now', { status });
    }
    return parseDealerSend(json(decodeText(bytes)), number, this.options.now?.());
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeDealerSendNumber(raw);
    // A read that fails to reach DealerSend, or hangs, is sent once more: the
    // first try gets half of the budget.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new DealerSendTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeDealerSendNumber(number))),
  };
};
