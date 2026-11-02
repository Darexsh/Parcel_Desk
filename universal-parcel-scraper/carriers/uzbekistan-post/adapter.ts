import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { normalizeUzbekistanPostNumber, parseUzbekistanPost, PROVIDER, UZBEKISTAN_POST_MAX_BYTES } from './parser.js';

/** The lookup uz.post's tracking page makes for the code in its address or field. */
export const UZBEKISTAN_POST_API = 'https://tracking.pochta.uz/api/v1/public/test/';
const REDIRECTS = [301, 302, 303, 307, 308];
// The tracker answers an unknown code in its reply: a missing route is not a missing item.
const GONE = [405, 410];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /<title>\s*(?:Just a moment|Attention Required|Access Denied)|_cf_chl_opt|cf-turnstile|captcha/i;

export function uzbekistanPostLookupUrl(number: string): string {
  return `${UZBEKISTAN_POST_API}${encodeURIComponent(number)}/`;
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Uzbekistan Post answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Uzbekistan Post returned a reply that is not JSON', { cause });
  }
}

/** The tracker's 404 for an EMS item IPS does not know, as against a route that is gone. */
function missingItem(body: string): boolean {
  try {
    const payload: unknown = JSON.parse(body);
    return isRecord(payload) && payload.code === 'order_not_found';
  } catch {
    return false;
  }
}

export class UzbekistanPostTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeUzbekistanPostNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(uzbekistanPostLookupUrl(number), { method: 'GET', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: UZBEKISTAN_POST_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, ...GONE] });
      const body = decodeText(bytes).replace(/^\uFEFF/, '').trim();
      if (response.status === 404) {
        if (missingItem(body)) throw new NotFoundError(PROVIDER);
        throw new TransportError(PROVIDER, 'Uzbekistan Post tracking lookup is unavailable', { status: 404 });
      }
      if (REDIRECTS.includes(response.status) || GONE.includes(response.status)) {
        throw new TransportError(PROVIDER, 'Uzbekistan Post tracking lookup is unavailable', { status: response.status });
      }
      if (!body) throw new IndeterminateError(PROVIDER, 'Uzbekistan Post returned an empty reply');
      return parseUzbekistanPost(json(body), number);
    };
    // A lookup that fails to reach the tracker, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'uzbekistan-post', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new UzbekistanPostTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'uzbekistan-post', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeUzbekistanPostNumber(number))),
  };
};
