import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { BEX_MAX_BYTES, isBexUnknown, normalizeBexNumber, parseBex, PROVIDER } from './parser.js';

/** The history lookup the tracking page on bexexpress.rs makes for the number typed in. */
export const BEX_HISTORY_API = 'https://integrations.bexexpress.rs/api/Shipments/shipmentHistory';
// The token the tracking page's script sends with every lookup, the same for every visitor.
const PAGE_TOKEN = 'f45010c4-25d4-3g3d-a37b-iv3098355d49'; // gitleaks:allow
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required)|AwsWafIntegration|awswaf\.com|captcha/i;

/** The history lookup for one number, as the tracking page sends it. */
export function bexLookupUrl(raw: string): string {
  return `${BEX_HISTORY_API}?${new URLSearchParams({ trackingValue: normalizeBexNumber(raw) })}`;
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'BEX Express answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'BEX Express returned a reply that is not JSON', { cause });
  }
}

export class BexExpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeBexNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(bexLookupUrl(number), { method: 'GET', signal, headers: {
        Accept: 'application/json', 'X-Auth-Token': PAGE_TOKEN, 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: BEX_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 400, 401, 404, 410] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'BEX Express redirected its tracking lookup');
      // The service answers every number it reads; a 404 is a moved route.
      if (response.status === 404 || response.status === 410) {
        throw new TransportError(PROVIDER, 'BEX Express tracking lookup is unavailable', { status: response.status });
      }
      // A missing or refused token is HTTP 401, which no number changes.
      if (response.status === 401) throw new ChallengeError(PROVIDER, 'BEX Express refused the tracking page\'s token', { status: 401 });
      const payload = json(decodeText(bytes));
      // HTTP 400 carries the service's answer for an unknown number, or its refusal of the request.
      if (response.status === 400 && !isBexUnknown(payload)) throw new SchemaError(PROVIDER, 'BEX Express refused the lookup');
      return parseBex(payload, number);
    };
    // A request that fails to reach BEX, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'bex-express', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new BexExpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'bex-express', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeBexNumber(number))),
  };
};
