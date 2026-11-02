import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeTeamNumber, parseTeam, PROVIDER, TEAM_MAX_BYTES, TEAM_TRAC } from './parser.js';

export { TEAM_TRAC } from './parser.js';
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route is not a missing shipment: the page names a bill it has no status for.
const GONE = [404, 410];

/** The form Team Trac's page posts for one whole bill, with its reference and consignee fields left empty. */
export function teamLookupBody(number: string): string {
  return new URLSearchParams({ hbl: normalizeTeamNumber(number), srn: '', con: '' }).toString();
}

export class TeamTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeTeamNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(TEAM_TRAC, { method: 'POST', signal, body: teamLookupBody(number), headers: {
        Accept: 'text/html', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: TEAM_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Team Trac redirected its lookup');
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'Team Trac page is unavailable');
      const html = decodeText(bytes);
      if (!html.trim()) throw new IndeterminateError(PROVIDER, 'Team Trac returned an empty page');
      return parseTeam(html, number);
    };
    // A lookup that fails to reach Team Trac, or hangs, is sent once more: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'team-worldwide', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new TeamTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'team-worldwide', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeTeamNumber(number))),
  };
};
