import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeOmgoNumber, OMGO_ENDPOINT, OMGO_MAX_BYTES, parseOmgoNonce, parseOmgoTrackingJson } from './parser.js';

export class OmgoTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeOmgoNumber(raw);
    return runSteps({ carrier: 'omgo', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const deadline = performance.now() + remainingMs;
      const options = () => ({ provider: 'OMGO', timeoutMs: Math.max(1, Math.floor(deadline - performance.now())),
        maxBytes: OMGO_MAX_BYTES, fetcher: this.options.fetcher });
      const headers = { 'User-Agent': userAgentOf(this.options.userAgent) };
      try {
        // Cached WordPress pages can carry an expired nonce. A fresh page is
        // required for each lookup; no pinned nonce or session is retained.
        const page = await fetchBounded(`https://omgoexpress.cn/track-package/?_=${Date.now()}`, { signal, headers }, options());
        const nonce = parseOmgoNonce(decodeText(page.bytes));
        const body = new FormData();
        body.set('action', 'shi_get_tracking_info'); body.set('nonce', nonce); body.set('tracking_codes', number);
        const result = await fetchBounded(OMGO_ENDPOINT, { method: 'POST', signal, headers, body }, options());
        return parseOmgoTrackingJson(decodeText(result.bytes), number);
      } catch (error) {
        if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) {
          throw new TransportError('OMGO', 'OMGO tracking endpoint is unavailable', { cause: error });
        }
        if (error instanceof UpstreamHttpError && error.status === 403 && error.diagnostics?.body_excerpt?.trim() === '-1') {
          throw new IndeterminateError('OMGO', 'OMGO rejected the page-issued tracking nonce', { cause: error, reason: 'nonce_expired' });
        }
        throw error;
      }
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new OmgoTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'omgo', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => normalizeOmgoNumber(number))) };
};
