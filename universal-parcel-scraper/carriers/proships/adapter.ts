import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeProshipsNumber, parseProships, parseProshipsNonce, PROSHIPS_MAX_BYTES, PROSHIPS_PAGE_MAX_BYTES, PROVIDER } from './parser.js';

/** The tracking page, whose script looks up the number in its address with a nonce. */
export const PROSHIPS_PAGE = 'https://proships.com/tracking/';
/** The WordPress endpoint that script posts the number to. */
export const PROSHIPS_API = 'https://proships.com/wp-admin/admin-ajax.php';
/** The tracking plugin's action. */
export const PROSHIPS_ACTION = 'get_tracking_info';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required|Access denied)/i;
// The plugin's answer to a nonce it does not accept, and WordPress's own.
const NONCE_REFUSED = /^(?:Error de seguridad|-1)$/;

function json(body: string): unknown {
  if (NONCE_REFUSED.test(body.trim())) throw new IndeterminateError(PROVIDER, 'ProShips refused the tracking page’s nonce', { reason: 'nonce_expired' });
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'ProShips answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'ProShips returned a reply that is not JSON', { cause });
  }
}

export class ProshipsTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeProshipsNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      const options = (maxBytes: number, allowed: readonly number[]) => ({ provider: PROVIDER, maxBytes, redirect: 'manual' as const,
        timeoutMs: Math.max(1, Math.floor(deadline - performance.now())), fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...allowed] });
      const userAgent = userAgentOf(this.options.userAgent);
      // The page for the number, as the tracking form opens it, carries the
      // nonce its lookup needs. It is read fresh for every lookup.
      const page = await fetchBounded(`${PROSHIPS_PAGE}?${new URLSearchParams({ tracking: number })}`, { method: 'GET', signal, headers: {
        Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'es-CO,es;q=0.9', 'User-Agent': userAgent,
      } }, options(PROSHIPS_PAGE_MAX_BYTES, [404, 410]));
      if (page.response.status !== 200) throw new TransportError(PROVIDER, 'ProShips tracking page is unavailable');
      const nonce = parseProshipsNonce(decodeText(page.bytes));
      const { response, bytes } = await fetchBounded(PROSHIPS_API, { method: 'POST', signal, headers: {
        Accept: 'application/json, text/javascript, */*', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'User-Agent': userAgent,
      }, body: new URLSearchParams({ action: PROSHIPS_ACTION, tracking_code: number, nonce }).toString() },
      options(PROSHIPS_MAX_BYTES, [400, 404, 410]));
      // The tracker answers every number with HTTP 200. WordPress answers an
      // action no plugin registers with HTTP 400 and `0`; a 404 is a moved route.
      if (response.status !== 200) throw new TransportError(PROVIDER, 'ProShips tracking lookup is unavailable');
      return parseProships(json(decodeText(bytes)), number);
    };
    // A read that fails to reach the site, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'proships', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ProshipsTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'proships', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
