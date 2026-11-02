import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CSE_MAX_BYTES, cseQueries, normalizeCseNumber, parseCse, PROVIDER } from './parser.js';

/** The lookup CSE's tracking page on cse.ru makes, followed by the numbers it was given, comma-separated. */
export const CSE_API = 'https://lk.cse.ru/api/new-track/';
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route is not a missing parcel: the tracker lists unknown numbers in its reply.
const GONE = [404, 410];
// DDoS-Guard fronts cse.ru, and a CDN or firewall could put its check in place of the reply.
const CHALLENGE = /ddos-guard|__ddg|_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Checking your browser)/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'CSE answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'CSE returned a reply that is not JSON', { cause });
  }
}

export class CseTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeCseNumber(raw);
    // The page takes up to ten numbers, comma-separated, in one lookup.
    const url = `${CSE_API}${encodeURIComponent(cseQueries(number).join(','))}`;
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: CSE_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE] });
      // The site sends a request for a route it does not have to its login page.
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'CSE redirected its tracking lookup', { status: response.status });
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'The CSE tracking lookup is unavailable', { status: response.status });
      return parseCse(json(decodeText(bytes)), number);
    };
    // A request that fails to reach CSE, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'cse-russia', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new CseTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'cse-russia', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeCseNumber(number))),
  };
};
