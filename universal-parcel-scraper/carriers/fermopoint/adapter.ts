import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, InvalidInputError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { FERMOPOINT_MAX_BYTES, normalizeFermopointNumber, parseFermopoint, PROVIDER } from './parser.js';

/** The booking page the tracking forms on fermopoint.it send a code to. */
export const FERMOPOINT_BOOKING = 'https://www.fermopoint.it/prenotazione/';
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route is not a missing booking: the page answers unknown codes itself.
const GONE = [404, 410];

/** Whether a redirect is the site's error page for a code it calls invalid. */
function refusedCode(location: string | null): boolean {
  if (!location) return false;
  try {
    const url = new URL(location, FERMOPOINT_BOOKING);
    return url.pathname.toLowerCase() === '/errore/404' && /non è valido/i.test(url.searchParams.get('msg') ?? '');
  } catch {
    return false;
  }
}

export class FermopointTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeFermopointNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(`${FERMOPOINT_BOOKING}${number}`, { method: 'GET', signal, headers: {
        Accept: 'text/html,application/xhtml+xml', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: FERMOPOINT_MAX_BYTES,
        redirect: 'manual', allowHttpStatuses: [...REDIRECTS, ...GONE], fetcher: this.options.fetcher });
      if (REDIRECTS.includes(response.status)) {
        // The page sends a code that fails its own format check to its error page.
        if (refusedCode(response.headers.get('location'))) throw new InvalidInputError(PROVIDER, 'Fermopoint calls the code invalid', { reason: 'wrong_number' });
        throw new TransportError(PROVIDER, 'Fermopoint sent the lookup to another page', { status: response.status });
      }
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'The Fermopoint booking page is unavailable', { status: response.status });
      const html = decodeText(bytes);
      if (!html.trim()) throw new IndeterminateError(PROVIDER, 'Fermopoint returned an empty page');
      return parseFermopoint(html, number);
    };
    // A request that fails to reach the site, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'fermopoint', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new FermopointTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'fermopoint', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeFermopointNumber(number))),
  };
};
