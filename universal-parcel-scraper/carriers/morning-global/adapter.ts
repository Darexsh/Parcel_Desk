import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  MORNING_GLOBAL_ACTION, MORNING_GLOBAL_API, MORNING_GLOBAL_MAX_BYTES, MORNING_GLOBAL_PAGE_MAX_BYTES, normalizeMorningGlobalNumber,
  parseMorningGlobal, parseMorningGlobalNonce, PROVIDER,
} from './parser.js';

export { MORNING_GLOBAL_ACTION, MORNING_GLOBAL_API } from './parser.js';
/** The tracker page, whose script looks up the number in its address with a nonce. */
export const MORNING_GLOBAL_PAGE = 'https://www.morninglobal.com/trace-track/';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required|Access denied)/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Morning Global answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Morning Global returned a reply that is not JSON', { cause });
  }
}

export class MorningGlobalTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeMorningGlobalNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      const options = (maxBytes: number, allowed: readonly number[]) => ({ provider: PROVIDER, maxBytes, redirect: 'manual' as const,
        timeoutMs: Math.max(1, Math.floor(deadline - performance.now())), fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...allowed] });
      const userAgent = userAgentOf(this.options.userAgent);
      // The tracker page for the number, as its links open it, carries the
      // nonce its lookup needs. It is read fresh for every lookup.
      const page = await fetchBounded(`${MORNING_GLOBAL_PAGE}?${new URLSearchParams({ tracking_number: number })}`, { method: 'GET', signal,
        headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': userAgent } }, options(MORNING_GLOBAL_PAGE_MAX_BYTES, [404, 410]));
      if (page.response.status !== 200) throw new TransportError(PROVIDER, 'Morning Global tracker page is unavailable', { status: page.response.status });
      const nonce = parseMorningGlobalNonce(decodeText(page.bytes));
      const { response, bytes } = await fetchBounded(MORNING_GLOBAL_API, { method: 'POST', signal, headers: {
        Accept: 'application/json, */*', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'User-Agent': userAgent,
      }, body: new URLSearchParams({ action: MORNING_GLOBAL_ACTION, nonce, tracking_number: number, mg_tr_website: '' }).toString() },
      options(MORNING_GLOBAL_MAX_BYTES, [400, 403, 404, 410, 422]));
      const body = decodeText(bytes);
      // WordPress answers a nonce it does not accept with HTTP 403 and `-1`,
      // and an action no plugin registers with HTTP 400 and `0`.
      if (response.status === 403) {
        if (body.trim() === '-1') throw new IndeterminateError(PROVIDER, 'Morning Global refused the tracker page’s nonce', { reason: 'nonce_expired' });
        throw new ChallengeError(PROVIDER, 'Morning Global refused the lookup', { status: 403 });
      }
      if (response.status === 400 && body.trim() === '0') throw new TransportError(PROVIDER, 'Morning Global tracking lookup is unavailable', { status: 400 });
      if (REDIRECTS.includes(response.status) || response.status === 404 || response.status === 410) {
        throw new TransportError(PROVIDER, 'Morning Global tracking lookup is unavailable', { status: response.status });
      }
      // The plugin's own refusals (HTTP 400 or 422) carry `success: false`.
      return parseMorningGlobal(json(body), number);
    };
    // A read that fails to reach the site, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'morning-global', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new MorningGlobalTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'morning-global', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeMorningGlobalNumber(number))),
  };
};
