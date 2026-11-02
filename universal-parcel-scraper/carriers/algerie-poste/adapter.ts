import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { ALGERIE_POSTE_MAX_BYTES, normalizeAlgeriePosteNumber, parseAlgeriePoste, PROVIDER } from './parser.js';

/** EMS Champion Post Algérie's tracker, the page its tracking forms open for one number. */
export const ALGERIE_POSTE_TRACKER = 'https://ems.dz/track/index.php';
const REDIRECTS = [301, 302, 303, 307, 308];
// The tracker answers an unknown number on its page: a missing route is not a missing item.
const GONE = [404, 410];
const DEFAULT_BUDGET_MS = 20_000;

export class AlgeriePosteTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeAlgeriePosteNumber(raw);
    const url = `${ALGERIE_POSTE_TRACKER}?${new URLSearchParams({ icd: number })}`;
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'fr', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: ALGERIE_POSTE_MAX_BYTES,
        redirect: 'manual', allowHttpStatuses: [...REDIRECTS, ...GONE], fetcher: this.options.fetcher });
      if (REDIRECTS.includes(response.status) || GONE.includes(response.status)) {
        throw new TransportError(PROVIDER, 'The Algérie Poste tracker moved', { status: response.status });
      }
      const html = decodeText(bytes);
      if (!html.trim()) throw new IndeterminateError(PROVIDER, 'Algérie Poste returned an empty page');
      return parseAlgeriePoste(html, number);
    };
    // A request that fails to reach the tracker, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'algerie-poste', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new AlgeriePosteTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'algerie-poste', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeAlgeriePosteNumber(number))),
  };
};
