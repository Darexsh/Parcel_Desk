import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, RateLimitedError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { MAILAMERICAS_MAX_BYTES, normalizeMailamericasNumber, parseMailamericas, PROVIDER } from './parser.js';

/** The lookup the tracking page on mailamericas.com makes for the number typed in. */
export const MAILAMERICAS_API = 'https://mailamericas.com/api/tracking';
const REDIRECTS = [301, 302, 303, 307, 308];
// The bare page AWS's load balancer answers with when it refuses a request.
const BALANCER_REFUSAL = /<title>\s*403 Forbidden\s*<\/title>/i;
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|AwsWafIntegration|awswaf\.com|gokuProps/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'MailAmericas answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'MailAmericas returned a reply that is not JSON', { cause });
  }
}

export class MailamericasTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeMailamericasNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(MAILAMERICAS_API, { method: 'POST', signal, headers: {
        Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      }, body: JSON.stringify({ trackingNumber: number, language: 'en' }) }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
        maxBytes: MAILAMERICAS_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 410] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'MailAmericas redirected its tracking lookup');
      // The page reads a missing parcel from a 200 reply; a 404 is a moved route.
      if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'MailAmericas tracking lookup is unavailable');
      if (response.status === 403) {
        // The balancer refuses an address that asked too often for a few minutes,
        // and some clients' names outright, with the same page.
        if (BALANCER_REFUSAL.test(decodeText(bytes).slice(0, 4_000))) {
          throw new RateLimitedError(PROVIDER, undefined, 'MailAmericas refused the lookup at its load balancer', { status: 403 });
        }
        throw new ChallengeError(PROVIDER, 'MailAmericas refused the lookup', { status: 403 });
      }
      return parseMailamericas(json(decodeText(bytes)), number);
    };
    // One read with the whole budget: a parcel the service has not looked up
    // lately takes it twenty seconds to answer.
    return runSteps({ carrier: 'mailamericas', budgetMs: context.budgetMs ?? 30_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, remainingMs) },
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new MailamericasTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'mailamericas', recordsSteps: true, steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeMailamericasNumber(number))),
  };
};
