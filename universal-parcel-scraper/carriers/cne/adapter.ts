import { createHash } from 'node:crypto';
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { normalizeCneNumber, parseCne } from './parser.js';

const ENDPOINT = 'https://wapi.cne.com/tracking/officialWebsite';
// The anonymous website's public WASM client prefixes inputs before MD5:
// https://www.cne.com/assets/wasm/wasm_md5_bg-074da2d9.wasm
// This is a form-protocol constant, not an account credential. Keep its space.
const PUBLIC_FORM_PREFIX = '01979c0bfa33772dbb3f5c07bd651b21 ';
const sign = (input: string) => createHash('md5').update(PUBLIC_FORM_PREFIX + input).digest('hex');

export class CneTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeCneNumber(raw);
    return runSteps({ carrier: 'cne', signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const timestamp = Date.now().toString();
      try {
        const { bytes } = await fetchBounded(`${ENDPOINT}?t=${timestamp}`, { method: 'POST', signal,
          headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/plain, */*',
            Origin: 'https://www.cne.com', Referer: 'https://www.cne.com/', 'User-Agent': userAgentOf(this.options.userAgent),
            signature: sign(timestamp.substring(0, 12) + number) },
          body: JSON.stringify({ lan: 'en', logisticsNo: number, md5: sign(number + 'Track') }),
        }, { provider: 'CNE Express', timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: 1_000_000, fetcher: this.options.fetcher });
        return parseCne(parseJsonBytes(bytes, 'CNE Express'), number);
      } catch (error) {
        if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) throw new TransportError('CNE Express', 'CNE tracking endpoint is unavailable', { cause: error });
        throw error;
      }
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new CneTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'cne', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context) };
};
