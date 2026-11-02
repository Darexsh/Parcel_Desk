import { createHash } from 'node:crypto';
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { normalizeSpxPhNumber, parseSpxPh } from './parser.js';
const BASE = 'https://spx.ph';
// Public checksum configuration from the official Philippine tracking client;
// this is not a session credential. The legacy feed remains its own fallback.
const CHECKSUM_SALT = 'MGViZmZmZTYzZDJhNDgxY2Y1N2ZlN2Q1ZWJkYzlmZDY=';
export class SpxPhTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}
  async fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeSpxPhNumber(raw);
    const read = async (url: URL, signal: AbortSignal, remainingMs: number, legacy: boolean) => {
      try {
        const { bytes } = await fetchBounded(url, { signal, headers: { Accept: 'application/json', 'x-language': 'en',
          'User-Agent': userAgentOf(this.options.userAgent) } }, { provider: 'SPX Express Philippines',
            timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: 1_000_000, fetcher: this.options.fetcher });
        return parseSpxPh(parseJsonBytes(bytes, 'SPX Express Philippines'), number, legacy);
      } catch (error) {
        if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) throw new TransportError('SPX Express Philippines', 'SPX tracking endpoint is unavailable', { cause: error });
        throw error;
      }
    };
    return runSteps({ carrier: 'spx-ph', signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
        const url = new URL('/shipment/order/open/order/get_order_info', BASE);
        url.searchParams.set('spx_tn', number); url.searchParams.set('language_code', 'en-ph');
        return read(url, signal, remainingMs, false);
      } }, { id: 'legacy', run: async ({ signal, remainingMs }) => {
        const seconds = Math.floor(Date.now() / 1000);
        const checksum = createHash('sha256').update(`${number}${seconds}${CHECKSUM_SALT}`).digest('hex');
        const url = new URL('/api/v2/fleet_order/tracking/search', BASE);
        url.searchParams.set('sls_tracking_number', `${number}|${seconds}${checksum}`);
        return read(url, signal, remainingMs, true);
      } }]);
  }
}
export const adapter: AdapterFactory = environment => {
  const tracker = new SpxPhTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'spx-ph', recordsSteps: true, steps: ['direct', 'legacy'], track: (input, context) => tracker.fetch(input.number, context) };
};
