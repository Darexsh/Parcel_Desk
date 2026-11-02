import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, SchemaError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { normalizeBringNumber, parseBring } from './parser.js';

export class BringTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeBringNumber(raw);
    return runSteps({ carrier: 'bring-posten', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      signal.throwIfAborted();
      const { response, bytes } = await fetchBounded(`https://sporing.bring.no/sporing/json/${number}?lang=en`,
        { signal, headers: { Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) } }, { provider: 'Bring',
          timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: 1_000_000, allowHttpStatuses: [404, 410], fetcher: this.options.fetcher });
      const body = decodeText(bytes);
      let payload: unknown;
      try { payload = JSON.parse(body); } catch { payload = undefined; }
      // The consumer's negative response does not identify the requested parcel. The portal's own
      // not-found comes as JSON or as the bare text "NOT FOUND", which it now sends for an unknown number.
      if (response.status === 404 || response.status === 410) {
        const notFound = isRecord(payload) ? payload.errorState === 'NOT_FOUND' : body.trim() === 'NOT FOUND';
        throw new IndeterminateError('Bring', 'No identity-bound parcel history', notFound ? { reason: 'portal_not_found' } : undefined);
      }
      if (payload === undefined) throw new SchemaError('Bring');
      return parseBring(payload, raw);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new BringTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'bring-posten', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => normalizeBringNumber(number))) };
};
