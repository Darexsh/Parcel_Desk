import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { AMERICAN_WEST_MAX_BYTES, normalizeAmericanWestNumber, parseAmericanWest, PROVIDER } from './parser.js';

/** The I-Trek tracker Freightgate runs for American West. */
export const AMERICAN_WEST_ITREK = 'https://awest.freightgate.com/cgi-bin/tarifftrek5.1/itrek.cgi';
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route is not a missing shipment: the page answers an unknown number with a notice.
const GONE = [404, 410];

/** The page the tracker's search opens for one whole pro number, searched as a pro number and nothing else. */
export function americanWestLookupUrl(number: string): string {
  const query = new URLSearchParams({
    database: 'awest', type: 'submit', interface: 'pltx', open_interface_search: 'Search Now',
    open_text: normalizeAmericanWestNumber(number), SearchOn: 'open_billno',
  });
  return `${AMERICAN_WEST_ITREK}?${query.toString()}`;
}

export class AmericanWestTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeAmericanWestNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(americanWestLookupUrl(number), { method: 'GET', signal, headers: {
        Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: AMERICAN_WEST_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'American West redirected its tracking page');
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'American West tracking page is unavailable');
      const html = decodeText(bytes);
      if (!html.trim()) throw new IndeterminateError(PROVIDER, 'American West returned an empty page');
      return parseAmericanWest(html, number);
    };
    // A lookup that fails to reach the tracker, or hangs, is sent once more: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'american-west-express', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new AmericanWestTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'american-west-express', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
