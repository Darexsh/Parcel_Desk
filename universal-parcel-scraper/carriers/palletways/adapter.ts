import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizePalletwaysNumber, PALLETWAYS_MAX_BYTES, parsePalletways, PROVIDER } from './parser.js';

export const PALLETWAYS_ORIGIN = 'https://track2.palletways.com';
const REDIRECTS = [301, 302, 303, 307, 308];

/**
 * The status the tracking page loads into itself for the ID typed. The full
 * details it loads next need the delivery postcode, which the adapter does not use.
 */
export const palletwaysStatusUrl = (number: string) =>
  `${PALLETWAYS_ORIGIN}/tt_basic.php?dc_syscon=${encodeURIComponent(number)}`;

export class PalletwaysTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizePalletwaysNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(palletwaysStatusUrl(number), { method: 'GET', signal, headers: {
        Accept: 'text/html, */*; q=0.01',
        // As the page script sends it: the full details refuse a request without these.
        'X-Requested-With': 'XMLHttpRequest',
        Referer: `${PALLETWAYS_ORIGIN}/`,
        'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: PALLETWAYS_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Palletways redirected its status lookup');
      // An unknown ID gets a notice with HTTP 200; a missing page is a moved route.
      if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'Palletways status lookup is unavailable');
      return parsePalletways(decodeText(bytes), number);
    };
    return runSteps({ carrier: 'palletways', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, remainingMs) },
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new PalletwaysTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  // No recognition: no detection rule claims eleven bare digits for
  // Palletways, so preflight never asks it.
  return {
    id: 'palletways', recordsSteps: true, steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
