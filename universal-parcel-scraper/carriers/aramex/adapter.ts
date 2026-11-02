import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { aramexDetailRedirect, aramexDetailUrl, normalizeAramexNumber, parseAramex } from './parser.js';

export class AramexTracker {
  private readonly userAgent: string;
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {
    this.userAgent = userAgentOf(options.userAgent);
  }
  fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeAramexNumber(raw);
    return runSteps({ carrier: 'aramex', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const started = performance.now();
      const get = async (url: string, regionalRedirect = false): Promise<string> => {
        signal.throwIfAborted();
        const left = remainingMs - (performance.now() - started);
        if (left <= 0) throw new BudgetExceededError('Aramex', context.budgetMs ?? 20_000);
        try {
          // The edge rejects Node's default user agent on server networks.
          const { response, bytes } = await fetchBounded(url, { signal, headers: {
            Accept: 'text/html', 'User-Agent': this.userAgent,
          } }, {
            provider: 'Aramex', timeoutMs: Math.max(1, Math.floor(left)), maxBytes: 1_500_000,
            fetcher: this.options.fetcher, ...(regionalRedirect ? { redirect: 'manual', allowHttpStatuses: [301, 302, 303, 307, 308] } : {}),
          });
          if (regionalRedirect && [301, 302, 303, 307, 308].includes(response.status)) {
            return await get(aramexDetailRedirect(response.headers.get('location') ?? '', url));
          }
          return decodeText(bytes);
        } catch (error) {
          if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) throw new TransportError('Aramex', 'Aramex tracking endpoint is unavailable', { cause: error });
          throw error;
        }
      };
      const overview = await get(`https://www.aramex.com/us/en/track/shipments?ShipmentNumber=${number}`);
      const detail = aramexDetailUrl(overview, number);
      return parseAramex(await get(detail, true), number);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new AramexTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'aramex', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context) };
};
