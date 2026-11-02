import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { DPD_RO_MAX_BYTES, normalizeDpdRoNumber, parseDpdRoReply, PROVIDER } from './parser.js';

// The endpoint MyDPD's public tracker reads a shipment from; the DPD app ships
// the same path. tracking.dpd.ro sits behind a Cloudflare challenge and a
// Turnstile check; this host does not.
export const DPD_RO_ENDPOINT = 'https://mydpd.dpd.ro/rest/public/track';

export class DpdRoTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeDpdRoNumber(raw);
    return runSteps({ carrier: 'dpd-ro', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      signal.throwIfAborted();
      const { response, bytes } = await fetchBounded(`${DPD_RO_ENDPOINT}?${new URLSearchParams({ id: number, language: 'en' })}`, { signal,
        headers: { Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) } }, {
        provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: DPD_RO_MAX_BYTES,
        allowHttpStatuses: [404], fetcher: this.options.fetcher,
      });
      return parseDpdRoReply(response.status, decodeText(bytes), number);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new DpdRoTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'dpd-ro', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeDpdRoNumber(number))) };
};
