import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isTwoGoNotFound, normalizeTwoGoNumber, parseTwoGo, PROVIDER, TWO_GO_MAX_BYTES, twoGoRedirect } from './parser.js';

/** The lookup the tracker on track.2go.com.ph makes for the number its `/status/` page opens. */
export const TWO_GO_API = 'https://9or1cb84ae.execute-api.ap-southeast-1.amazonaws.com/prod/tracking/';
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
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, '2GO Express answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, '2GO Express returned a reply that is not JSON', { cause });
  }
}

export class TwoGoTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  /** One lookup's reply. A rate limit or server error is the shared HTTP error for its status. */
  private async request(number: string, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
    const { response, bytes } = await fetchBounded(`${TWO_GO_API}${encodeURIComponent(number)}`, { method: 'GET', signal, headers: {
      Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: TWO_GO_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 410] });
    if (REDIRECTS.includes(response.status) || response.status === 410) {
      throw new TransportError(PROVIDER, '2GO Express tracking lookup is unavailable', { status: response.status });
    }
    const body = decodeText(bytes);
    if (response.status === 403) {
      if (NO_ROUTE.test(body.slice(0, 4_000))) throw new TransportError(PROVIDER, '2GO Express tracking lookup is unavailable', { status: 403 });
      throw new ChallengeError(PROVIDER, '2GO Express refused the lookup', { status: 403 });
    }
    const payload = json(body);
    // The tracker answers a number it does not hold with HTTP 404 and its own message.
    if (response.status === 404) {
      if (isTwoGoNotFound(payload)) throw new NotFoundError(PROVIDER);
      throw new SchemaError(PROVIDER, '2GO Express returned an unexpected 404 reply', { status: 404 });
    }
    return payload;
  }

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const deadline = Date.now() + timeoutMs;
    const payload = await this.request(number, signal, timeoutMs);
    const shipment = twoGoRedirect(payload);
    if (shipment === null) return parseTwoGo(payload, number);
    // A reference the tracker holds as a shipment's attachment: the page opens
    // that shipment's number next, whose reply must list the reference whole.
    if (shipment === number) throw new SchemaError(PROVIDER, '2GO Express redirected the number to itself');
    let followed: unknown;
    try {
      followed = await this.request(shipment, signal, Math.max(1, deadline - Date.now()));
    } catch (error) {
      if (error instanceof NotFoundError) throw new IndeterminateError(PROVIDER, '2GO Express redirected to a shipment it does not hold', { cause: error });
      throw error;
    }
    if (twoGoRedirect(followed) !== null) throw new SchemaError(PROVIDER, '2GO Express redirected the lookup twice');
    return parseTwoGo(followed, number, shipment);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeTwoGoNumber(raw);
    // A read that fails to reach 2GO, or hangs, is sent once more: the first
    // try gets half of the budget.
    return runSteps({ carrier: '2go', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new TwoGoTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: '2go', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeTwoGoNumber(number))),
  };
};
