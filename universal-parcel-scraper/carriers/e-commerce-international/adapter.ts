import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CARRIER, ECI_MAX_BYTES, normalizeEciNumber, parseEci, PROVIDER } from './parser.js';

/** The tracking page; `/{number}/__data.json` is the data its client loads for one parcel. */
export const ECI_TRACKING_PAGE = 'https://ecommerce-system.com/track/';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied)|captcha/i;
const DEFAULT_BUDGET_MS = 15_000;

/** The page's data request for one parcel number. */
export function eciDataUrl(number: string): string {
  return `${ECI_TRACKING_PAGE}${encodeURIComponent(number)}/__data.json`;
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'E-Commerce International answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'E-Commerce International returned a reply that is not JSON', { cause });
  }
}

export class EciTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(eciDataUrl(number), { method: 'GET', signal, headers: {
      Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: ECI_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 410] });
    if (response.status === 403) throw new ChallengeError(PROVIDER, 'E-Commerce International refused the lookup', { status: 403 });
    // The page reads an unknown number from a 200 reply; a 404 is a moved route.
    if (REDIRECTS.includes(response.status) || response.status === 404 || response.status === 410) {
      throw new TransportError(PROVIDER, 'E-Commerce International tracking lookup is unavailable', { status: response.status });
    }
    return parseEci(json(decodeText(bytes)), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeEciNumber(raw);
    // A read that fails to reach the site, or hangs, is sent once more: the
    // first try gets half of the budget.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new EciTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeEciNumber(number))),
  };
};
