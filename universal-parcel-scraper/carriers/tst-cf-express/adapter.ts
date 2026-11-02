import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  checkTstCfLookup, normalizeTstCfNumber, parseTstCf, PROVIDER, TST_CF_MAX_BYTES, TST_CF_ORIGIN, TST_CF_RESULTS, tstCfLookupUrl,
} from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route is not a missing shipment: the results page answers an unknown PRO with a notice.
const GONE = [404, 410];
// The PHP session the lookup stores its answer in; the results page reads it.
const SESSION_COOKIE = /^PHPSESSID=([A-Za-z0-9,-]{16,128})(?:;|$)/;

/** The session the lookup opened, as a cookie header. */
function sessionOf(response: Response): string {
  for (const header of response.headers.getSetCookie()) {
    const match = SESSION_COOKIE.exec(header);
    if (match) return `PHPSESSID=${match[1]}`;
  }
  throw new IndeterminateError(PROVIDER, 'TST-CF Express did not open a session for the lookup', { reason: 'session_rejected' });
}

/** The address a redirect points to, or null when it leaves the tracker's host. */
function redirectTarget(response: Response): string | null {
  const location = response.headers.get('location');
  if (!location || location.length > 2_000) return null;
  try {
    const url = new URL(location, TST_CF_ORIGIN);
    return url.origin === TST_CF_ORIGIN ? `${url.origin}${url.pathname}${url.search}` : null;
  } catch {
    return null;
  }
}

/**
 * The same failure without the request and response details fetchBounded
 * attaches: they hold the session cookie.
 */
function withoutSession(error: unknown): unknown {
  if (error instanceof UpstreamHttpError) return new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
  if (error instanceof UpstreamNetworkError) return new UpstreamNetworkError(error.provider, error.cause);
  return error;
}

export class TstCfTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeTstCfNumber(raw);
    // One attempt sends the PRO to the URL tracing address, which stores the
    // lookup in a new session, and reads that session's results page.
    const attempt = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      // A request left without time fails as a timeout, which the retry can recover.
      const left = () => Math.max(1, Math.floor(deadline - performance.now()));
      const read = async (url: string, cookie?: string) => {
        const result = await fetchBounded(url, { method: 'GET', signal, headers: {
          Accept: 'text/html,application/xhtml+xml', 'User-Agent': userAgentOf(this.options.userAgent), ...(cookie ? { Cookie: cookie } : {}),
        } }, { provider: PROVIDER, timeoutMs: left(), maxBytes: TST_CF_MAX_BYTES, redirect: 'manual',
          allowHttpStatuses: [...REDIRECTS, ...GONE], fetcher: this.options.fetcher });
        if (GONE.includes(result.response.status)) throw new TransportError(PROVIDER, 'TST-CF Express tracing is unavailable');
        return result;
      };
      try {
        const lookup = await read(tstCfLookupUrl(number));
        // The lookup answers in its body and sends the browser on with a refresh;
        // a plain redirect must lead to the same results page.
        if (REDIRECTS.includes(lookup.response.status)) {
          if (redirectTarget(lookup.response) !== TST_CF_RESULTS) throw new SchemaError(PROVIDER, 'TST-CF Express redirected the lookup elsewhere');
        } else {
          checkTstCfLookup(decodeText(lookup.bytes));
        }
        const session = sessionOf(lookup.response);
        signal.throwIfAborted();
        const results = await read(TST_CF_RESULTS, session);
        // The results page sends a session without a lookup back to the tracing form.
        if (REDIRECTS.includes(results.response.status)) {
          throw new IndeterminateError(PROVIDER, 'TST-CF Express lost the lookup\'s session', { reason: 'session_rejected' });
        }
        return parseTstCf(decodeText(results.bytes), number);
      } catch (error) {
        throw withoutSession(error);
      }
    };
    // An attempt that fails to reach the tracker, or hangs, gets one more in a new
    // session: the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'tst-cf-express', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => attempt(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => attempt(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new TstCfTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  // Ten digits are shared by many carriers and no rule offers them, so the adapter recognizes nothing.
  return {
    id: 'tst-cf-express', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
