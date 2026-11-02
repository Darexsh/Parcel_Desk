import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { ICS_COURIER_MAX_BYTES, normalizeIcsCourierNumber, parseIcsCourier, PROVIDER } from './parser.js';

/** The tracking page, which looks the numbers in its address up on the server. */
export const ICS_COURIER_ENDPOINT = 'https://www.icscourier.ca/online-services/parcel-tracking.aspx';
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route is not a missing parcel: the tracker answers unknown numbers with a summary row.
const GONE = [404, 410];
/**
 * The tracker gives up on its own query after 30 seconds and sends the page to
 * its error page. A parcel with scans it has not looked up lately takes it 40
 * to 50 seconds, but the query goes on after the page gives up, so the first
 * try stops at 25 seconds and the retry finds it further along.
 */
const FIRST_TRY_MS = 25_000;

export class IcsCourierTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeIcsCourierNumber(raw);
    // The page takes several numbers; one is asked at a time.
    const url = `${ICS_COURIER_ENDPOINT}?${new URLSearchParams({ trackNums: number })}`;
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: ICS_COURIER_MAX_BYTES,
        redirect: 'manual', allowHttpStatuses: [...REDIRECTS, ...GONE, 403], fetcher: this.options.fetcher });
      if (REDIRECTS.includes(response.status)) {
        // ASP.NET sends a failed or timed-out request to its error page.
        if (/defaulterror/i.test(response.headers.get('location') ?? '')) {
          throw new IndeterminateError(PROVIDER, 'ICS Courier\'s tracker failed the lookup', { status: response.status });
        }
        throw new TransportError(PROVIDER, 'ICS Courier redirected its tracking page', { status: response.status });
      }
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'ICS Courier tracking page is unavailable', { status: response.status });
      const html = decodeText(bytes);
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'ICS Courier refused the lookup', { status: 403 });
      return parseIcsCourier(html, number);
    };
    // A request that fails to reach ICS, or hangs, gets one more try with the rest of the budget.
    return runSteps({ carrier: 'ics-courier', budgetMs: context.budgetMs ?? 60_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, Math.min(firstAttemptMs(remainingMs), FIRST_TRY_MS)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new IcsCourierTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'ics-courier', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
