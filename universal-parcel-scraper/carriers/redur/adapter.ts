import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeRedurNumber, parseRedur, PROVIDER, REDUR_MAX_BYTES } from './parser.js';

/** Redur's tracking page; its search form posts the number back to it. */
export const REDUR_TRACKER = 'https://redur.es/track-trace/';
const REDIRECTS = [301, 302, 303, 307, 308];
// The page answers an unknown number itself: a missing page is a moved tracker, not a missing parcel.
const GONE = [404, 410];

/**
 * The search form's fields for a tracking number, in Spanish. The form keeps
 * an empty reCAPTCHA field whose script the page no longer loads.
 */
export function redurLookupBody(number: string): string {
  return new URLSearchParams({ 'g-recaptcha-response': '', idiomausuario: 'es', buscarpor: 'NTRACKING', valor: number }).toString();
}

export class RedurTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeRedurNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(REDUR_TRACKER, { method: 'POST', signal, headers: {
        Accept: 'text/html', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': userAgentOf(this.options.userAgent),
      }, body: redurLookupBody(number) }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: REDUR_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 403] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Redur redirected its tracking page', { status: response.status });
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'Redur tracking page is unavailable', { status: response.status });
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'Redur refused the lookup', { status: 403 });
      return parseRedur(decodeText(bytes), number);
    };
    // A lookup that fails to reach the tracker, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'redur', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new RedurTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'redur', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeRedurNumber(number))),
  };
};
