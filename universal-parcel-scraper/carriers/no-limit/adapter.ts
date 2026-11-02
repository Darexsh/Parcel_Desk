import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CARRIER, NO_LIMIT_MAX_BYTES, NO_LIMIT_TRACKER, noLimitFormFields, normalizeNoLimitNumber, parseNoLimit, PROVIDER } from './parser.js';

export { NO_LIMIT_TRACKER } from './parser.js';

const ORIGIN = new URL(NO_LIMIT_TRACKER).origin;
const REDIRECTS = [301, 302, 303, 307, 308];
// The page answers every number with HTTP 200: a missing route is not a missing shipment.
const GONE = [404, 410];
const DEFAULT_BUDGET_MS = 20_000;
const COOKIE_NAME = /^[\w.%-]{1,128}$/;
const COOKIE_VALUE = /^[^\s;,]{0,2048}$/;

/** The cookies the form's page sets, as the browser sends them back with the form: the site's load balancer's and firewall's. */
function cookiesOf(response: Response): string {
  return response.headers.getSetCookie().map((header) => header.split(';', 1)[0]!.trim()).filter((pair) => {
    const separator = pair.indexOf('=');
    return separator > 0 && COOKIE_NAME.test(pair.slice(0, separator)) && COOKIE_VALUE.test(pair.slice(separator + 1));
  }).join('; ');
}

export class NoLimitTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeNoLimitNumber(raw);
    // One attempt opens the English tracking page and posts its form back with
    // the shipment number, as its search button does, with the cookies the
    // page set. No token, key or browser is needed.
    const attempt = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      // A request left without time fails as a timeout, which the retry can recover.
      const left = () => Math.max(1, Math.floor(deadline - performance.now()));
      const headers = { Accept: 'text/html,application/xhtml+xml', 'User-Agent': userAgentOf(this.options.userAgent) };
      const read = async (init: RequestInit): Promise<{ response: Response; html: string }> => {
        const { response, bytes } = await fetchBounded(NO_LIMIT_TRACKER, { ...init, signal }, { provider: PROVIDER, timeoutMs: left(),
          maxBytes: NO_LIMIT_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 403] });
        const status = response.status;
        if (status === 403) throw new ChallengeError(PROVIDER, 'No Limit refused the lookup', { status });
        if (REDIRECTS.includes(status) || GONE.includes(status)) throw new TransportError(PROVIDER, 'No Limit tracking page is unavailable', { status });
        return { response, html: decodeText(bytes) };
      };
      const form = await read({ method: 'GET', headers });
      const fields = noLimitFormFields(form.html, number);
      const cookies = cookiesOf(form.response);
      signal.throwIfAborted();
      const answer = await read({ method: 'POST', body: fields.toString(), headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded',
        Origin: ORIGIN, Referer: NO_LIMIT_TRACKER, ...(cookies ? { Cookie: cookies } : {}) } });
      return parseNoLimit(answer.html, number);
    };
    // An attempt that fails to reach the site, or hangs, gets one more: the
    // first gets half of the budget, so the retry fits in the rest. An HTTP
    // status, a rate limit included, is never sent again.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => attempt(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => attempt(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new NoLimitTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeNoLimitNumber(number))),
  };
};
