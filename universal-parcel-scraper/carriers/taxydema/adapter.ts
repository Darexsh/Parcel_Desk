import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isTaxydemaAbsence, normalizeTaxydemaNumber, parseTaxydema, PROVIDER, TAXYDEMA_MAX_BYTES } from './parser.js';

/** The lookup the tracking page on taxydema.gr makes for the number in its address. */
export const TAXYDEMA_API = 'https://www.taxydema.gr/api/track-request/';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required)|captcha/i;

export function taxydemaLookupUrl(number: string): string {
  return `${TAXYDEMA_API}${encodeURIComponent(number)}`;
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Taxydema answered with a browser check', { cause });
    return undefined;
  }
}

export class TaxydemaTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeTaxydemaNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(taxydemaLookupUrl(number), { method: 'GET', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: TAXYDEMA_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 410] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Taxydema redirected its tracking lookup');
      const payload = json(decodeText(bytes));
      // The site refuses some clients' names with `{"error":"Forbidden"}`.
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'Taxydema refused the lookup', { status: 403 });
      if (response.status === 404 || response.status === 410) {
        if (isTaxydemaAbsence(payload)) throw new NotFoundError(PROVIDER);
        // The server's own page for a route it does not have, or another error.
        if (payload === undefined) throw new TransportError(PROVIDER, 'Taxydema tracking lookup is unavailable');
        throw new IndeterminateError(PROVIDER, 'Taxydema did not complete the lookup');
      }
      if (response.status !== 200) throw new IndeterminateError(PROVIDER, 'Taxydema did not answer with its tracking reply');
      if (payload === undefined) throw new SchemaError(PROVIDER, 'Taxydema returned a reply that is not JSON');
      return parseTaxydema(payload, number);
    };
    // A read that fails to reach Taxydema, or hangs, gets one more: the first
    // gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'taxydema', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new TaxydemaTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'taxydema', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeTaxydemaNumber(number))),
  };
};
