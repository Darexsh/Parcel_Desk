import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { JUMPPOINT_MAX_BYTES, normalizeJumppointNumber, parseJumppoint, PROVIDER } from './parser.js';

/** The lookup Jumppoint's tracking page makes for the numbers typed in. */
export const JUMPPOINT_API = 'https://tracking-api.jumppoint.io/shipment/tracking/';
const REDIRECTS = [301, 302, 303, 307, 308];
// The service words its refusals in JSON with these statuses.
const REFUSALS = [400, 401, 403];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|AwsWafIntegration|awswaf\.com|gokuProps|g-recaptcha|hcaptcha\.com/i;

/** The address the tracking page asks for one whole number, without the page's reCAPTCHA token. */
export function jumppointLookupUrl(raw: string): string {
  return `${JUMPPOINT_API}?${new URLSearchParams({ 'trackingNumbers[]': normalizeJumppointNumber(raw) })}`;
}

function json(body: string, status: number): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (status === 403 || CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Jumppoint answered with a browser check', { cause, status });
    throw new SchemaError(PROVIDER, 'Jumppoint returned a reply that is not JSON', { cause, status });
  }
}

export class JumppointTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeJumppointNumber(raw);
    const url = jumppointLookupUrl(number);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: JUMPPOINT_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...REFUSALS, 404, 410] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Jumppoint redirected its tracking lookup');
      // The service answers every number with HTTP 200; a 404 is a moved route, not an unknown parcel.
      if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'Jumppoint tracking lookup is unavailable', { status: response.status });
      const payload = json(decodeText(bytes), response.status);
      // A refusal must say why; one that claims success is a changed reply.
      if (REFUSALS.includes(response.status) && (payload as { success?: unknown } | null)?.success !== false) {
        throw new SchemaError(PROVIDER, `Jumppoint answered HTTP ${response.status}`, { status: response.status });
      }
      return parseJumppoint(payload, number);
    };
    // A request that fails to reach the service, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'jumppoint', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new JumppointTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'jumppoint', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeJumppointNumber(number))),
  };
};
