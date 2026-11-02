import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  CORREO_ARGENTINO_LOOKUP, CORREO_ARGENTINO_MAX_BYTES, correoArgentinoLookupFields, normalizeCorreoArgentinoNumber,
  parseCorreoArgentino, PROVIDER,
} from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
// A route the site no longer serves, which says nothing about the item.
const UNAVAILABLE = [404, 410];

export class CorreoArgentinoTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeCorreoArgentinoNumber(raw);
    // One post of the form's fields, as the tracking page's script sends them.
    const attempt = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(CORREO_ARGENTINO_LOOKUP, { method: 'POST', signal, headers: {
        'User-Agent': userAgentOf(this.options.userAgent), Accept: 'text/html, */*; q=0.01',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      }, body: correoArgentinoLookupFields(number) }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
        maxBytes: CORREO_ARGENTINO_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
        allowHttpStatuses: [...REDIRECTS, ...UNAVAILABLE, 403] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Correo Argentino redirected its tracking lookup');
      if (UNAVAILABLE.includes(response.status)) throw new TransportError(PROVIDER, 'Correo Argentino tracking lookup is unavailable');
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'Correo Argentino refused the lookup', { status: 403 });
      return parseCorreoArgentino(decodeText(bytes), number);
    };
    // A lookup that fails to reach the site, or hangs, gets one more: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'correo-argentino', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => attempt(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => attempt(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new CorreoArgentinoTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'correo-argentino', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeCorreoArgentinoNumber(number))),
  };
};
