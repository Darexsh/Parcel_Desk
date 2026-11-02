import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CARRIER, normalizeTeamExpressNumber, parseTeamExpress, PROVIDER, TEAM_EXPRESS_MAX_BYTES } from './parser.js';

// Team Express's tracking page, rendered on the server for the number in its
// address, which is where its tracking form sends a visitor. It needs no
// cookie, token, CAPTCHA, phone digits or browser.
export const TEAM_EXPRESS_ENDPOINT = 'https://teamexpressme.com/tracking';
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing page is not a missing shipment: an unknown number gets the form alone.
const GONE = [404, 410];

export class TeamExpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeTeamExpressNumber(raw);
    const url = `${TEAM_EXPRESS_ENDPOINT}?${new URLSearchParams({ trackno: number })}`;
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'text/html,application/xhtml+xml', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: TEAM_EXPRESS_MAX_BYTES,
        redirect: 'manual', allowHttpStatuses: [...REDIRECTS, ...GONE, 403], fetcher: this.options.fetcher });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Team Express redirected its tracking page', { status: response.status });
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'Team Express tracking page is unavailable', { status: response.status });
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'Team Express refused the lookup', { status: 403 });
      const html = decodeText(bytes);
      if (!html.trim()) throw new IndeterminateError(PROVIDER, 'Team Express returned an empty page');
      return parseTeamExpress(html, number);
    };
    // A request that fails to reach the tracker, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest. An
    // HTTP status, a rate limit included, is never sent again.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new TeamExpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
