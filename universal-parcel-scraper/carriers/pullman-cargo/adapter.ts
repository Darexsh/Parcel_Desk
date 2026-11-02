import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizePullmanCargoNumber, parsePullmanCargo, PROVIDER, PULLMAN_CARGO_MAX_BYTES } from './parser.js';

/** The tracking page on pullmancargo.cl; `/{odt}/__data.json` is the data its client loads for one ODT. */
export const PULLMAN_CARGO_PAGE = 'https://pullmancargo.cl/seguimiento/';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied)|captcha/i;
const DEFAULT_BUDGET_MS = 15_000;

/** The page's data request for one ODT, as its client sends it when the form opens the ODT's page. */
export function pullmanCargoDataUrl(number: string): string {
  return `${PULLMAN_CARGO_PAGE}${encodeURIComponent(number)}/__data.json?x-sveltekit-invalidated=01`;
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Pullman Cargo answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Pullman Cargo returned a reply that is not JSON', { cause });
  }
}

export class PullmanCargoTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(pullmanCargoDataUrl(number), { method: 'GET', signal, headers: {
      Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: PULLMAN_CARGO_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
    // The page reads a missing ODT from a 200 reply; a 404 is a moved route.
    if (REDIRECTS.includes(response.status) || response.status === 404 || response.status === 410) {
      throw new TransportError(PROVIDER, 'Pullman Cargo tracking lookup is unavailable', { status: response.status });
    }
    return parsePullmanCargo(json(decodeText(bytes)), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizePullmanCargoNumber(raw);
    // A read that fails to reach Pullman Cargo, or hangs, is sent once more:
    // the first try gets half of the budget.
    return runSteps({ carrier: 'pullman-cargo', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new PullmanCargoTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'pullman-cargo', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizePullmanCargoNumber(number))),
  };
};
