import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { MaintenanceError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { HERMES_AT_MAX_BYTES, normalizeHermesAtNumber, parseHermesAt, PROVIDER } from './parser.js';

/** The myHermes.at tracker's page for one number, which its form redirects to. */
export const HERMES_AT_TRACKER = 'https://www.myhermes.at/sendungsverfolgung/trackingnummer/';
const REDIRECTS = [301, 302, 303, 307, 308];
// The tracker answers an unknown number on its page: a missing route is not a missing parcel.
const GONE = [404, 410];
// The site sends visitors to this page while its tracking service is down.
const OFFLINE = /\/service-nicht-verfuegbar\//;

export class HermesAtTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeHermesAtNumber(raw);
    const url = `${HERMES_AT_TRACKER}${encodeURIComponent(number)}/`;
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'de-AT,de', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: HERMES_AT_MAX_BYTES,
        redirect: 'manual', allowHttpStatuses: [...REDIRECTS, ...GONE], fetcher: this.options.fetcher });
      if (REDIRECTS.includes(response.status)) {
        if (OFFLINE.test(response.headers.get('location') ?? '')) throw new MaintenanceError(PROVIDER, 'Hermes Austria\'s tracker is down for maintenance');
        throw new TransportError(PROVIDER, 'The Hermes Austria tracker moved', { status: response.status });
      }
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'The Hermes Austria tracker moved', { status: response.status });
      return parseHermesAt(decodeText(bytes), number);
    };
    return runSteps({ carrier: 'hermes-at', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, remainingMs) },
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new HermesAtTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'hermes-at', recordsSteps: true, steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeHermesAtNumber(number))),
  };
};
