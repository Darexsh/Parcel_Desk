import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { normalizePosturinnNumber, parsePosturinn, POSTURINN_MAX_BYTES, PROVIDER } from './parser.js';

/** The lookup posturinn.is's tracking page makes for the code in its address or search box. */
export const POSTURINN_API = 'https://api.mobiz.posturinn.is/api/v1/shipments/';
const REDIRECTS = [301, 302, 303, 307, 308];
// The tracker answers an unknown code with 204: a missing route is not a missing item.
const GONE = [404, 405, 410];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|_cf_chl_opt|cf-turnstile|captcha/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Pósturinn answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Pósturinn returned a reply that is not JSON', { cause });
  }
}

/** The tracker's refusal of a code it calls invalid ("Sendingarnúmerið er ekki gilt"). */
function refusedNumber(body: string): boolean {
  try {
    const payload: unknown = JSON.parse(body);
    return isRecord(payload) && payload.errorType === 'InvalidArgument';
  } catch {
    return false;
  }
}

export class PosturinnTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizePosturinnNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // The English page asks for English wordings, as this does; some stay Icelandic.
      const { response, bytes } = await fetchBounded(`${POSTURINN_API}${number}`, { method: 'GET', signal, headers: {
        Accept: 'application/json', 'X-Preferred-Language': 'en', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: POSTURINN_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 400, 403] });
      if (REDIRECTS.includes(response.status) || GONE.includes(response.status)) {
        throw new TransportError(PROVIDER, 'Pósturinn tracking lookup is unavailable', { status: response.status });
      }
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'Pósturinn refused the lookup', { status: 403 });
      // The page reads an empty answer as "Tracking number not recognized".
      if (response.status === 204) throw new NotFoundError(PROVIDER);
      const body = decodeText(bytes).replace(/^\uFEFF/, '').trim();
      if (response.status === 400) {
        if (refusedNumber(body)) throw new InvalidInputError(PROVIDER, 'Pósturinn says the code is not valid', { reason: 'wrong_number' });
        throw new SchemaError(PROVIDER, 'Pósturinn refused the lookup request', { status: 400 });
      }
      if (!body) throw new IndeterminateError(PROVIDER, 'Pósturinn returned an empty reply');
      return parsePosturinn(json(body), number);
    };
    // A lookup that fails to reach Pósturinn, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'posturinn', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new PosturinnTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'posturinn', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizePosturinnNumber(number))),
  };
};
