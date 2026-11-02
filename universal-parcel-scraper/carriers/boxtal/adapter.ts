import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { BOXTAL_MAX_BYTES, CARRIER, isUnknownReference, normalizeBoxtalReference, parseBoxtal, PROVIDER } from './parser.js';

/** The lookup Boxtal's tracking page makes for one reference. */
export const BOXTAL_TRACKING_API = 'https://private-gateway.boxtal.com/v2.1/carrier/tracking/';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied)|captcha/i;
const DEFAULT_BUDGET_MS = 15_000;

/** The lookup's address for one reference. */
export function boxtalTrackingUrl(reference: string): string {
  return `${BOXTAL_TRACKING_API}${encodeURIComponent(reference)}`;
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Boxtal answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Boxtal returned a reply that is not JSON', { cause });
  }
}

export class BoxtalTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(reference: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(boxtalTrackingUrl(reference), { method: 'GET', signal, headers: {
      Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: BOXTAL_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 410] });
    const { status } = response;
    if (status === 403) throw new ChallengeError(PROVIDER, 'Boxtal refused the lookup', { status });
    if (status === 404) {
      // The tracker names a reference it does not know in a 404; any other 404 is a moved route.
      let payload: unknown;
      try {
        payload = JSON.parse(decodeText(bytes));
      } catch {
        payload = undefined;
      }
      if (isUnknownReference(payload, reference)) return parseBoxtal(payload, reference);
    }
    if (REDIRECTS.includes(status) || status === 404 || status === 410) {
      throw new TransportError(PROVIDER, 'Boxtal tracking lookup is unavailable', { status });
    }
    return parseBoxtal(json(decodeText(bytes)), reference);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const reference = normalizeBoxtalReference(raw);
    // A read that fails to reach Boxtal, or hangs, is sent once more: the
    // first try gets half of the budget.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(reference, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(reference, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new BoxtalTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeBoxtalReference(number))),
  };
};
