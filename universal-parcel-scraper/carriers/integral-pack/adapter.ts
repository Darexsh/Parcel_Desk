import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { INTEGRAL_PACK_MAX_BYTES, normalizeIntegralPackGuide, parseIntegralPack, PROVIDER } from './parser.js';

/** The lookup the tracking page on integralpack.com.ar makes for the guide typed in. */
export const INTEGRAL_PACK_API = 'https://www.integralpack.com.ar/api/seguimiento/buscar';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|g-recaptcha|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|captcha/i;
const DEFAULT_BUDGET_MS = 15_000;

/** The lookup's address for one guide, in the form the tracking page sends it. */
export function integralPackLookupUrl(guide: string): string {
  return `${INTEGRAL_PACK_API}?codigo=${encodeURIComponent(normalizeIntegralPackGuide(guide).code)}`;
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Integral Pack answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Integral Pack returned a reply that is not JSON', { cause });
  }
}

export class IntegralPackTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(guide: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(integralPackLookupUrl(guide), { method: 'GET', signal, headers: {
      Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: INTEGRAL_PACK_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
    // The lookup reads a guide it does not know from a 200 reply; a redirect or a 404 is a moved route.
    if (REDIRECTS.includes(response.status) || response.status === 404 || response.status === 410) {
      throw new TransportError(PROVIDER, 'Integral Pack tracking lookup is unavailable', { status: response.status });
    }
    return parseIntegralPack(json(decodeText(bytes)), guide);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const guide = normalizeIntegralPackGuide(raw).code;
    // A read that fails to reach the site, or hangs, is sent once more:
    // the first try gets half of the budget.
    return runSteps({ carrier: 'integral-pack', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(guide, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(guide, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new IntegralPackTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'integral-pack', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeIntegralPackGuide(number))),
  };
};
