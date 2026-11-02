import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { MIDLAND_MAX_BYTES, normalizeMidlandNumber, parseMidland, PROVIDER } from './parser.js';

/** The tracking page Midland's quick track field opens, which renders one shipment on the server. */
export const MIDLAND_TRACKING = 'https://ship.midlandtransport.com/Tracking/TrackClientTrackings';
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 410];
const DEFAULT_BUDGET_MS = 15_000;

/** The page's address for a number, in English, as the home page's quick track field opens it. */
export function midlandTrackingUrl(number: string): string {
  return `${MIDLAND_TRACKING}?${new URLSearchParams({ TrackingNumber: number, Lang: '0' }).toString()}`;
}

export class MidlandTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(midlandTrackingUrl(number), { method: 'GET', signal, headers: {
      Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: MIDLAND_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 403] });
    // The page answers a number it does not hold with HTTP 200; a redirect or a 404 is a moved route.
    if (REDIRECTS.includes(response.status) || GONE.includes(response.status)) {
      throw new TransportError(PROVIDER, 'Midland’s tracking page is unavailable', { status: response.status });
    }
    // Imperva, in front of the page, refuses a client it blocks with a 403.
    if (response.status === 403) throw new ChallengeError(PROVIDER, 'Midland refused the lookup', { status: 403 });
    return parseMidland(decodeText(bytes), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeMidlandNumber(raw);
    // A lookup that fails to reach Midland, or hangs, is asked once more: the
    // first try gets half of the budget. An HTTP status is never sent again.
    return runSteps({ carrier: 'midland-transport', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new MidlandTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'midland-transport', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
