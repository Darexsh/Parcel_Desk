import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { BELPOST_MAX_BYTES, normalizeBelpostNumber, parseBelpost, PROVIDER } from './parser.js';

/** The lookup belpost.by's tracking page makes for the code in its address or form. */
export const BELPOST_API = 'https://api.belpost.by/api/v1/tracking';
const REDIRECTS = [301, 302, 303, 307, 308];
// The tracker answers an unknown code in its reply: a missing route is not a missing item.
const GONE = [404, 405, 410];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /<title>\s*(?:Just a moment|Attention Required|Access Denied)|_cf_chl_opt|cf-turnstile|captcha/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Belpost answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Belpost returned a reply that is not JSON', { cause });
  }
}

/** The tracker's validation reply: only one that faults the number says the code is not one it takes. */
function refusedNumber(body: string): boolean {
  try {
    const payload: unknown = JSON.parse(body);
    return isRecord(payload) && isRecord(payload.errors) && Object.keys(payload.errors).join() === 'number';
  } catch {
    return false;
  }
}

export class BelpostTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeBelpostNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // `hl` names the page's language; the scans come in Russian whichever it names.
      const { response, bytes } = await fetchBounded(BELPOST_API, { method: 'POST', signal, headers: {
        Accept: 'application/json', 'Content-Type': 'application/json', hl: 'ru', 'User-Agent': userAgentOf(this.options.userAgent),
      }, body: JSON.stringify({ number }) }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: BELPOST_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 403, 422] });
      if (REDIRECTS.includes(response.status) || GONE.includes(response.status)) {
        throw new TransportError(PROVIDER, 'Belpost tracking lookup is unavailable', { status: response.status });
      }
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'Belpost refused the lookup', { status: 403 });
      const body = decodeText(bytes).replace(/^\uFEFF/, '').trim();
      if (response.status === 422) {
        if (refusedNumber(body)) throw new InvalidInputError(PROVIDER, 'Belpost says the code is not in its format', { reason: 'wrong_number' });
        throw new SchemaError(PROVIDER, 'Belpost refused the lookup request', { status: 422 });
      }
      if (!body) throw new IndeterminateError(PROVIDER, 'Belpost returned an empty reply');
      return parseBelpost(json(body), number);
    };
    // A lookup that fails to reach Belpost, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'belpost', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new BelpostTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'belpost', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeBelpostNumber(number))),
  };
};
