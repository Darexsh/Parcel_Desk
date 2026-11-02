import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { BURD_MAX_BYTES, normalizeBurdNumber, parseBurd, PROVIDER } from './parser.js';

/** The lookup the tracking page on burd.dk makes for the number in its address. */
export const BURD_API = 'https://burdorderstatusapiprod.azurewebsites.net/api/TrackAndTraceStatuses';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required|Access Denied)/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Burd answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Burd returned a reply that is not JSON', { cause });
  }
}

export class BurdTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeBurdNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const url = `${BURD_API}?number=${encodeURIComponent(number)}`;
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: BURD_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 400, 403, 404, 410] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Burd redirected its tracking lookup');
      // The service answers an unknown number with a 400 and no body; a 404 is a moved route.
      if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'Burd tracking lookup is unavailable');
      const body = decodeText(bytes);
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'Burd refused the lookup', { status: 403 });
      if (response.status === 400) {
        // The page reads the empty 400 as a number it does not know.
        if (!body.trim()) throw new NotFoundError(PROVIDER);
        if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Burd answered with a browser check', { status: 400 });
        throw new SchemaError(PROVIDER, 'Burd refused the lookup with an unexpected reply', { status: 400 });
      }
      return parseBurd(json(body), number);
    };
    // One read: the service turns an address away for a few minutes after a
    // handful of lookups, so a repeated request would only spend that allowance.
    return runSteps({ carrier: 'burd-delivery', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, remainingMs) },
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new BurdTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'burd-delivery', recordsSteps: true, steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeBurdNumber(number))),
  };
};
