import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { EMS_VIETNAM_MAX_BYTES, normalizeEmsVietnamNumber, parseEmsVietnam, PROVIDER } from './parser.js';

/** The lookup the tracking page on ems.com.vn makes for the number typed in. */
export const EMS_VIETNAM_API = 'https://api.myems.vn/TrackAndTraceItemCode';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks Cloudflare, in front of the service, could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|challenge-platform|<title>\s*Attention Required/i;

/** The address the page asks: the number with `EMS` after it, and the Vietnamese wording. */
export function emsVietnamLookupUrl(number: string): string {
  return `${EMS_VIETNAM_API}?itemcode=${encodeURIComponent(`${number}EMS`)}&language=0`;
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'EMS Vietnam answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'EMS Vietnam returned a reply that is not JSON', { cause });
  }
}

export class EmsVietnamTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeEmsVietnamNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(emsVietnamLookupUrl(number), { method: 'GET', signal, headers: {
        Accept: 'application/json, text/plain, */*', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: EMS_VIETNAM_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'EMS Vietnam redirected its tracking lookup');
      // The service answers an unknown number with HTTP 200; a 404 is a moved route.
      if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'EMS Vietnam tracking lookup is unavailable');
      return parseEmsVietnam(json(decodeText(bytes)), number);
    };
    // One read with the whole budget, as the page allows thirty seconds: some
    // numbers take the service twenty seconds or more to answer.
    return runSteps({ carrier: 'ems-vietnam', budgetMs: context.budgetMs ?? 30_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, remainingMs) },
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new EmsVietnamTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'ems-vietnam', recordsSteps: true, steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeEmsVietnamNumber(number))),
  };
};
