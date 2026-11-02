import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { normalizeSlovenskaPostaNumber, parseSlovenskaPosta, PROVIDER, SLOVENSKA_POSTA_MAX_BYTES } from './parser.js';

// The service behind the tracking page at posta.sk/sledovanie-zasielok, which
// any visitor's browser calls: no key, cookie or token. The page always asks
// for the parts of a multi-piece item too.
export const SLOVENSKA_POSTA_ENDPOINT = 'https://api.posta.sk/private/web/track';
// The F5 firewall in front of the service rejects a request with an HTML page.
const BLOCKED = /Požiadavka bola zamietnutá|Prístup na požadovanú internetovú adresu bol zamietnutý|Access to the web address has been denied|chybový kód/i;

export function slovenskaPostaUrl(number: string): string {
  return `${SLOVENSKA_POSTA_ENDPOINT}?q=${encodeURIComponent(number)}&mmpc=1`;
}

export class SlovenskaPostaTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeSlovenskaPostaNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      let bytes: Uint8Array;
      try {
        ({ bytes } = await fetchBounded(slovenskaPostaUrl(number), { signal,
          headers: { Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) } },
        { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: SLOVENSKA_POSTA_MAX_BYTES, fetcher: this.options.fetcher }));
      } catch (error) {
        // An unknown number has its own error code; a missing route is not a missing item.
        if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) {
          throw new TransportError(PROVIDER, 'Slovenská pošta tracking service is unavailable', { cause: error });
        }
        throw error;
      }
      let payload: unknown;
      try { payload = parseJsonBytes(bytes, PROVIDER); }
      catch (cause) {
        if (BLOCKED.test(decodeText(bytes.subarray(0, 64_000)))) {
          throw new ChallengeError(PROVIDER, 'Slovenská pošta answered with a block page', { cause });
        }
        throw new SchemaError(PROVIDER, 'Slovenská pošta returned invalid tracking JSON', { cause });
      }
      return parseSlovenskaPosta(payload, number);
    };
    // A request that fails to reach the service, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'slovenska-posta', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new SlovenskaPostaTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'slovenska-posta', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeSlovenskaPostaNumber(number))),
  };
};
