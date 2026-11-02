import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { normalizeXpressbeesNumber, parseXpressbees } from './parser.js';

// The deployed shipmentv2.xpressbees.com public tracking client names this
// origin, despite its UAT hostname. No seller login or token is required.
const ENDPOINT = 'https://xb-ucp-wallet-api-uat.xbees.in/api/v1/webhookTracking/find';
export class XpressbeesTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}
  async fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeXpressbeesNumber(raw);
    return runSteps({ carrier: 'xpressbees', signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      try {
        const { bytes } = await fetchBounded(ENDPOINT, { method: 'POST', signal, headers: { 'Content-Type': 'application/json',
          'User-Agent': userAgentOf(this.options.userAgent) }, body: JSON.stringify({ AWBNO: number }) }, {
          provider: 'Xpressbees', timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: 1_000_000, fetcher: this.options.fetcher });
        return parseXpressbees(parseJsonBytes(bytes, 'Xpressbees'), number);
      } catch (error) {
        if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) throw new TransportError('Xpressbees', 'Xpressbees tracking endpoint is unavailable', { cause: error });
        throw error;
      }
    } }]);
  }
}
export const adapter: AdapterFactory = environment => {
  const tracker = new XpressbeesTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'xpressbees', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context) };
};
