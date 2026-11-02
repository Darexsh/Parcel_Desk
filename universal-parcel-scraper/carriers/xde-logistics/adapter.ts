import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isXdeLogisticsNotFound, normalizeXdeLogisticsNumber, parseXdeLogistics, PROVIDER, XDE_LOGISTICS_MAX_BYTES } from './parser.js';

/** The lookup the tracker on www.xde.com.ph makes for the number typed in or given in `tn`. */
export const XDE_LOGISTICS_API = 'https://xdelogistics.com/api/v2/client/public/services/shipment/';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied)|AwsWafIntegration|awswaf\.com|gokuProps|captcha/i;
const DEFAULT_BUDGET_MS = 15_000;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'XDE Logistics answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'XDE Logistics returned a reply that is not JSON', { cause });
  }
}

export class XdeLogisticsTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(`${XDE_LOGISTICS_API}${encodeURIComponent(number)}/history`, { method: 'GET', signal, headers: {
      Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: XDE_LOGISTICS_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
    if (REDIRECTS.includes(response.status) || response.status === 410) {
      throw new TransportError(PROVIDER, 'XDE Logistics tracking lookup is unavailable', { status: response.status });
    }
    const body = decodeText(bytes);
    if (response.status === 404) {
      // The lookup answers a number it does not hold with HTTP 404 and
      // `{"code":404,"message":"Invalid"}`; the site's HTML page for a missing
      // route is a moved route.
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'XDE Logistics answered with a browser check', { status: 404 });
        throw new TransportError(PROVIDER, 'XDE Logistics tracking lookup is unavailable', { status: 404 });
      }
      if (isXdeLogisticsNotFound(payload)) throw new NotFoundError(PROVIDER);
      throw new SchemaError(PROVIDER, 'XDE Logistics returned an unexpected 404 reply', { status: 404 });
    }
    return parseXdeLogistics(json(body), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeXdeLogisticsNumber(raw);
    // A read that fails to reach XDE, or hangs, is sent once more: the first
    // try gets half of the budget. An HTTP status is never sent again.
    return runSteps({ carrier: 'xde-logistics', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new XdeLogisticsTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'xde-logistics', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
