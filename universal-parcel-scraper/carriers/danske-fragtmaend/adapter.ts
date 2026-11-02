import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import {
  DANSKE_FRAGTMAEND_MAX_BYTES, normalizeDanskeFragtmaendNumber, parseDanskeFragtmaend, PROVIDER, type DanskeFragtmaendNumber,
} from './parser.js';

/** The tracking page's own lookups on trace.fragt.dk. */
export const DANSKE_FRAGTMAEND_API = 'https://trace.fragt.dk/backend/api/tracktrace/';
const REDIRECTS = [301, 302, 303, 307, 308];
// The tracker's English, as the page asks for it after its language switch.
const ENGLISH = '2';
// The tracker's answers for a number it does not know, naming that number.
const UNKNOWN = /^(?:Couldn't find fragtbrev with number|Failed to find consignment from the given collicode): (\S+)$/;
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|_cf_chl_opt|cf-turnstile|captcha/i;

/** The lookup the page makes for a consignment note number or for a collicode. */
export function danskeFragtmaendUrl({ number, kind }: DanskeFragtmaendNumber): string {
  const [path, key] = kind === 'colli' ? ['GetByColliCode', 'colliCode'] : ['GetByConsignmentNumber', 'consignmentNumber'];
  return `${DANSKE_FRAGTMAEND_API}${path}?${new URLSearchParams({ [key]: number, language: ENGLISH })}`;
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Danske Fragtmænd answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Danske Fragtmænd returned a reply that is not JSON', { cause });
  }
}

/** The `Message` of an error reply, or an empty string. */
function message(body: string): string {
  try {
    const payload: unknown = JSON.parse(body);
    return isRecord(payload) && typeof payload.Message === 'string' ? payload.Message.trim() : '';
  } catch {
    return '';
  }
}

export class DanskeFragtmaendTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const input = normalizeDanskeFragtmaendNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(danskeFragtmaendUrl(input), { method: 'GET', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: DANSKE_FRAGTMAEND_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 400, 404, 410] });
      if (REDIRECTS.includes(response.status) || response.status === 410) {
        throw new TransportError(PROVIDER, 'Danske Fragtmænd tracking lookup is unavailable', { status: response.status });
      }
      const body = decodeText(bytes).replace(/^\uFEFF/, '').trim();
      if (response.status === 404) {
        // Only the tracker's own answer naming the number is a missing consignment; another 404 is a moved route.
        if (UNKNOWN.exec(message(body))?.[1]?.toUpperCase() === input.number) throw new NotFoundError(PROVIDER);
        throw new TransportError(PROVIDER, 'Danske Fragtmænd tracking lookup is unavailable', { status: 404 });
      }
      if (response.status === 400) {
        if (/^Colli code is not valid/.test(message(body))) throw new InvalidInputError(PROVIDER, 'Danske Fragtmænd says the collicode is not valid', { reason: 'wrong_number' });
        throw new SchemaError(PROVIDER, 'Danske Fragtmænd refused the lookup request', { status: 400 });
      }
      return parseDanskeFragtmaend(json(body), input.number);
    };
    // A lookup that fails to reach the tracker, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'danske-fragtmaend', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new DanskeFragtmaendTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'danske-fragtmaend', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    // Only a collicode: a bare consignment note number also fits other carriers' numbers.
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeDanskeFragtmaendNumber(number)) && normalizeDanskeFragtmaendNumber(number).kind === 'colli'),
  };
};
