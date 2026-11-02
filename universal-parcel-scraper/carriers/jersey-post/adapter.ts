import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { JERSEY_POST_MAX_BYTES, normalizeJerseyPostNumber, parseJerseyPost, PROVIDER } from './parser.js';

/** The lookup the tracking page on jerseypost.com makes for the number typed in. */
export const JERSEY_POST_API = 'https://www.jerseypost.com/Umbraco/Surface/Tools/Track/';
const REDIRECTS = [301, 302, 303, 307, 308];
// A firewall's or bot check's page in place of the reply, which can come with HTTP 200.
const BLOCKED = /<title>\s*(?:Request Rejected|Access Denied|Web Page Blocked|Attention Required|Just a moment)|requested URL was rejected|_cf_chl_opt|cf-turnstile|FortiGuard|FortiWeb|captcha/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (BLOCKED.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Jersey Post answered with a block page', { cause });
    throw new SchemaError(PROVIDER, 'Jersey Post returned a reply that is not JSON', { cause });
  }
}

export class JerseyPostTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeJerseyPostNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(JERSEY_POST_API, { method: 'POST', signal, headers: {
        Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      }, body: JSON.stringify({ query: number, sentFromJsy: '' }) }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
        maxBytes: JERSEY_POST_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
      // The page reads a missing item from a 200 reply; a 404 or a redirect is a moved route.
      if (!response.ok) throw new TransportError(PROVIDER, 'Jersey Post tracking lookup is unavailable');
      return parseJerseyPost(json(decodeText(bytes)), number);
    };
    // A read that fails to reach the site, or hangs, is sent once more: the first gets half of the budget.
    return runSteps({ carrier: 'jersey-post', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new JerseyPostTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'jersey-post', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeJerseyPostNumber(number))),
  };
};
