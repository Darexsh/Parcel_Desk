import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { GOGO_XPRESS_MAX_BYTES, isGogoXpressNotFound, normalizeGogoXpressNumber, parseGogoXpress, PROVIDER } from './parser.js';

/** The lookup the tracker on app.gogoxpress.com makes for the number in its `/track/` path. */
export const GOGO_XPRESS_API = 'https://api.gogoxpress.com/v1/track/';
const REDIRECTS = [301, 302, 303, 307, 308];
// API Gateway's answer for a route it does not have.
const NO_ROUTE = /Missing Authentication Token/i;
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied|ERROR: The request could not be satisfied)|AwsWafIntegration|awswaf\.com|gokuProps|captcha/i;
const DEFAULT_BUDGET_MS = 15_000;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'GoGo Xpress answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'GoGo Xpress returned a reply that is not JSON', { cause });
  }
}

export class GogoXpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(`${GOGO_XPRESS_API}${encodeURIComponent(number)}`, { method: 'GET', signal, headers: {
      Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: GOGO_XPRESS_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 400, 403, 404, 410] });
    if (REDIRECTS.includes(response.status) || response.status === 404 || response.status === 410) {
      throw new TransportError(PROVIDER, 'GoGo Xpress tracking lookup is unavailable', { status: response.status });
    }
    const body = decodeText(bytes);
    if (response.status === 403) {
      if (NO_ROUTE.test(body.slice(0, 4_000))) throw new TransportError(PROVIDER, 'GoGo Xpress tracking lookup is unavailable', { status: 403 });
      throw new ChallengeError(PROVIDER, 'GoGo Xpress refused the lookup', { status: 403 });
    }
    const payload = json(body);
    // The tracker answers a number it does not know with HTTP 400 and "Order Not Found".
    if (response.status === 400) {
      if (isGogoXpressNotFound(payload)) throw new NotFoundError(PROVIDER);
      throw new SchemaError(PROVIDER, 'GoGo Xpress returned an unexpected 400 reply', { status: 400 });
    }
    return parseGogoXpress(payload, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeGogoXpressNumber(raw);
    // A read that fails to reach GoGo Xpress, or hangs, is sent once more: the
    // first try gets half of the budget.
    return runSteps({ carrier: 'gogo-xpress', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new GogoXpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'gogo-xpress', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeGogoXpressNumber(number))),
  };
};
