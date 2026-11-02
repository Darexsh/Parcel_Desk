import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizePinAgNumber, parsePinAg, parsePinAgMissing, PIN_AG_MAX_BYTES, PROVIDER } from './parser.js';

// The service PIN's tracking page asks for a number's statuses.
export const PIN_AG_ENDPOINT = 'https://sendungsverfolgung.pin-ag.de/api2/tracking';

export function pinAgTrackingUrl(raw: string): string {
  return `${PIN_AG_ENDPOINT}?sendung=${encodeURIComponent(normalizePinAgNumber(raw))}`;
}

export class PinAgTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const url = pinAgTrackingUrl(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: PIN_AG_MAX_BYTES,
        allowHttpStatuses: [404, 405], fetcher: this.options.fetcher });
      const text = decodeText(bytes);
      if (response.status !== 200) return parsePinAgMissing(response.status, text);
      let reply: unknown;
      try {
        reply = JSON.parse(text);
      } catch (error) {
        throw new SchemaError(PROVIDER, 'PIN AG returned a reply that is not JSON', { cause: error });
      }
      return parsePinAg(reply, raw);
    };
    // A request that fails to reach PIN, or hangs, gets one more try: the first
    // gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'pin-ag', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new PinAgTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'pin-ag', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizePinAgNumber(number))),
  };
};
