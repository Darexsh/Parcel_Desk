import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { clean, decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { LICCARDI_MAX_BYTES, normalizeLiccardiNumber, parseLiccardi, PROVIDER } from './parser.js';

/** The lookup the tracking page on my.liccarditrasporti.com makes for the number in its address. */
export const LICCARDI_API = 'https://operativo.liccarditrasporti.com/ope/rest/tracking/';
// The service refuses a lookup that does not come from the tracking page.
const REFERER = 'https://my.liccarditrasporti.com/';
const REDIRECTS = [301, 302, 303, 307, 308];
// The status SafeLine, the firewall in front of the tracker, answers with its browser check.
const SAFELINE_CHECK = 468;
// Bot checks the SafeLine firewall, or a CDN, could put in place of the reply.
const CHALLENGE = /safeline|<title>\s*Controllo di Sicurezza|_cf_chl_opt|cf-turnstile|<title>\s*Just a moment/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Liccardi answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Liccardi returned a reply that is not JSON', { cause });
  }
}

/** The service's own answer for a number it does not know: HTTP 404 with this body. */
export function isLiccardiNotFound(payload: unknown): boolean {
  return isRecord(payload) && payload.status === 404 && /^shipment not found$/i.test(clean(payload.message, 100));
}

export class LiccardiTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeLiccardiNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(`${LICCARDI_API}${number}`, { method: 'GET', signal, headers: {
        Accept: 'application/json', Referer: REFERER, 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: LICCARDI_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410, SAFELINE_CHECK] });
      if (response.status === SAFELINE_CHECK) throw new ChallengeError(PROVIDER, 'Liccardi answered with its firewall\'s browser check', { status: SAFELINE_CHECK });
      if (response.status === 404) {
        let body: unknown;
        try {
          body = JSON.parse(decodeText(bytes));
        } catch {
          body = null;
        }
        if (isLiccardiNotFound(body)) throw new NotFoundError(PROVIDER);
      }
      // Any other 404, a 410 or a redirect is a moved route.
      if (response.status !== 200) throw new TransportError(PROVIDER, 'Liccardi tracking lookup is unavailable', { status: response.status });
      return parseLiccardi(json(decodeText(bytes)), number);
    };
    // A lookup that fails to reach the tracker, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'liccardi', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new LiccardiTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'liccardi', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
