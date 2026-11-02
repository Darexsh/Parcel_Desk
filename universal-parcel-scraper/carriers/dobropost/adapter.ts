import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { DOBROPOST_MAX_BYTES, normalizeDobropostNumber, parseDobropost, parseDobropostMissing, PROVIDER } from './parser.js';

/** The lookup the tracking page on tracking.dobropost.com makes for a DBRPST number. */
export const DOBROPOST_API = 'https://api.dobropost.com/api/tracking/parcel';
// The key the tracking page's script sends with every lookup, the same for every visitor.
export const DOBROPOST_KEY = 'b4538f528e7a957bd734fdeeab12d143'; // gitleaks:allow
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required|Access denied)|ddos-guard|qrator/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'DobroPost answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'DobroPost returned a reply that is not JSON', { cause });
  }
}

/** Spring's reply to a key it does not accept: HTTP 403 with "Forbidden" and a stack trace. */
function keyRefused(body: string): boolean {
  try {
    const reply: unknown = JSON.parse(body);
    return typeof reply === 'object' && reply !== null && (reply as { message?: unknown }).message === 'Forbidden';
  } catch {
    return false;
  }
}

export class DobropostTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeDobropostNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(`${DOBROPOST_API}?${new URLSearchParams({ key: DOBROPOST_KEY, trackCode: number })}`, {
        method: 'GET', signal, headers: { Accept: 'application/json, text/plain, */*', 'User-Agent': userAgentOf(this.options.userAgent) },
      }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: DOBROPOST_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 410] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'DobroPost moved its tracking lookup');
      const body = decodeText(bytes);
      if (response.status === 403) {
        if (keyRefused(body)) throw new IndeterminateError(PROVIDER, 'DobroPost refused the tracking page’s key', { reason: 'session_rejected' });
        throw new ChallengeError(PROVIDER, 'DobroPost refused the lookup', { status: 403 });
      }
      if (response.status === 404 || response.status === 410) {
        if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'DobroPost answered with a browser check');
        let reply: unknown = null;
        try {
          reply = JSON.parse(body);
        } catch {
          // An HTML 404 is a moved route.
        }
        return parseDobropostMissing(reply, number);
      }
      return parseDobropost(json(body), number);
    };
    // A read that fails to reach the service, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'dobropost', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new DobropostTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'dobropost', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeDobropostNumber(number))),
  };
};
