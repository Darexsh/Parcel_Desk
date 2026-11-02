import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { ENERGIA_MAX_BYTES, energiaDocumentNumber, parseEnergia, PROVIDER } from './parser.js';

/** The lookup nrg-tk.pro's tracking page makes for the receipt number in its address or form. */
export const ENERGIA_API = 'https://nrg-tk.pro/rest/waybills/states';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /<title>\s*(?:Just a moment|Attention Required|Access Denied|DDoS-Guard)|_cf_chl_opt|cf-turnstile|ddos-guard|qrator|captcha/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'TK Energia answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'TK Energia returned a reply that is not JSON', { cause });
  }
}

/** A JSON reply, or nothing for a body that is not one. */
function maybeJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

export class EnergiaTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = energiaDocumentNumber(raw);
    const url = `${ENERGIA_API}?${new URLSearchParams({ documentNumber: number }).toString()}`;
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: ENERGIA_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 400, 403, 404, 410] });
      if (REDIRECTS.includes(response.status) || response.status === 410) {
        throw new TransportError(PROVIDER, 'TK Energia tracking lookup is unavailable', { status: response.status });
      }
      const body = decodeText(bytes).replace(/^\uFEFF/, '').trim();
      const payload = response.status === 200 ? undefined : maybeJson(body);
      // The tracker's backend refuses a path it does not serve with its own JSON error.
      if (response.status === 403) {
        if (isRecord(payload) && typeof payload.path === 'string') {
          throw new TransportError(PROVIDER, 'TK Energia tracking lookup is unavailable', { status: 403 });
        }
        throw new ChallengeError(PROVIDER, 'TK Energia refused the lookup', { status: 403 });
      }
      if (response.status === 400) throw new SchemaError(PROVIDER, 'TK Energia refused the lookup request', { status: 400 });
      // An unknown receipt is a 404 with the tracker's NOT_FOUND reply; another 404 is a moved route.
      if (response.status === 404) {
        if (isRecord(payload) && payload.status === 'NOT_FOUND') return parseEnergia(payload, number);
        throw new TransportError(PROVIDER, 'TK Energia tracking lookup is unavailable', { status: 404 });
      }
      if (!body) throw new IndeterminateError(PROVIDER, 'TK Energia returned an empty reply');
      return parseEnergia(json(body), number);
    };
    // A lookup that fails to reach the tracker, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'energia-tk', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new EnergiaTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'energia-tk', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => energiaDocumentNumber(number))),
  };
};
