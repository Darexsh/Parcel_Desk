import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { ANTERAJA_MAX_BYTES, normalizeAnterajaNumber, parseAnteraja, PROVIDER } from './parser.js';

export { normalizeAnterajaNumber, parseAnteraja } from './parser.js';
export const ANTERAJA_TRACKING_API = 'https://api.anteraja.id/order/tracking';

export class AnterajaTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeAnterajaNumber(raw);
    return runSteps({ carrier: 'anteraja', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const { response, bytes } = await fetchBounded(ANTERAJA_TRACKING_API, { method: 'POST', signal,
        // Public client/version identifiers select the mobile guest route; neither names an account.
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', source: 'aca_android', mv: '1.2', 'User-Agent': userAgentOf(this.options.userAgent) },
        body: JSON.stringify([{ codes: number }]) }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(remainingMs)),
        maxBytes: ANTERAJA_MAX_BYTES, fetcher: this.options.fetcher, allowHttpStatuses: [404, 410] });
      if ([404, 410].includes(response.status)) throw new TransportError(PROVIDER, 'Anteraja guest tracking is unavailable');
      const body = decodeText(bytes);
      if (/^\s*</.test(body)) throw new ChallengeError(PROVIDER, 'Anteraja returned a verification page');
      let payload: unknown;
      try { payload = JSON.parse(body); } catch { throw new SchemaError(PROVIDER, 'Anteraja returned unreadable tracking JSON'); }
      return parseAnteraja(payload, number);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new AnterajaTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'anteraja', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeAnterajaNumber(number))) };
};
