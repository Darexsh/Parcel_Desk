import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { HEPSIJET_MAX_BYTES, normalizeHepsijetNumber, parseHepsijet, PROVIDER } from './parser.js';

/** The lookup the tracking page on www.hepsijet.com makes for the number in its address. */
export const HEPSIJET_API = 'https://website-backend.hepsijet.com/server/tms/webDeliveryTracking';
const REDIRECTS = [301, 302, 303, 307, 308];
// The security page Hepsiburada's Akamai edge serves in place of a reply, and Akamai's own bot checks.
const CHALLENGE = /HBBlockandCaptcha|<title>\s*Hepsiburada\s*\|\s*Güvenlik|bm-verify|sec-if-cpt|_abck|Access Denied/i;

export class HepsijetTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeHepsijetNumber(raw);
    const url = `${HEPSIJET_API}?customerDeliveryNo=${encodeURIComponent(number)}`;
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: HEPSIJET_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 410] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'HepsiJET redirected its tracking lookup');
      // The lookup answers every number with HTTP 200; a missing route is a moved service.
      if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'HepsiJET tracking lookup is unavailable');
      // Akamai turns away clients it takes for bots, curl among them, with its security page.
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'HepsiJET refused the lookup at its firewall', { status: 403 });
      const body = decodeText(bytes);
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch (cause) {
        if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'HepsiJET answered with a browser check', { cause });
        throw new SchemaError(PROVIDER, 'HepsiJET returned a reply that is not JSON', { cause });
      }
      return parseHepsijet(payload, number);
    };
    // A request that fails to reach HepsiJET, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'hepsijet', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new HepsijetTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'hepsijet', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeHepsijetNumber(number))),
  };
};
