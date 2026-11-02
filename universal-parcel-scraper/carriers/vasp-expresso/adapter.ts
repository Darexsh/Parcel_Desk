import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeVaspExpressoNumber, parseVaspExpresso, PROVIDER, VASP_EXPRESSO_MAX_BYTES } from './parser.js';

/** The lookup the Track and Trace page on vaspexpresso.pt makes for the number typed in. */
export const VASP_EXPRESSO_API = 'https://www.vaspexpresso.pt/api/TrackAndTrace';
const REDIRECTS = [301, 302, 303, 307, 308];
// The page reads a missing parcel from an empty reply: a missing route is a moved lookup.
const GONE = [404, 410];

/** The lookup's address for one number, as the page builds it. */
export function vaspExpressoLookupUrl(number: string): string {
  return `${VASP_EXPRESSO_API}?${new URLSearchParams({ term: number }).toString()}`;
}

export class VaspExpressoTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeVaspExpressoNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(vaspExpressoLookupUrl(number), { method: 'GET', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: VASP_EXPRESSO_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 403] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Vasp Expresso redirected its tracking lookup', { status: response.status });
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'Vasp Expresso tracking lookup is unavailable', { status: response.status });
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'Vasp Expresso refused the lookup', { status: 403 });
      return parseVaspExpresso(decodeText(bytes), number);
    };
    // A lookup that fails to reach the site, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'vasp-expresso', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new VaspExpressoTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'vasp-expresso', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeVaspExpressoNumber(number))),
  };
};
