import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  CORREOS_EL_SALVADOR_MAX_BYTES, isCorreosElSalvadorMissing, normalizeCorreosElSalvadorNumber, parseCorreosElSalvador, PROVIDER,
} from './parser.js';

/** The lookup the tracking page on www.correos.gob.sv makes for the code in its field. */
export const CORREOS_EL_SALVADOR_API = 'https://www.correos.gob.sv:8000/api/v1/rastrear-paquete/';
const REDIRECTS = [301, 302, 303, 307, 308];
// Only the service's own problem reply is a missing item; another 404 or a 410 is a missing route.
const GONE = [404, 410];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|_cf_chl_opt|cf-turnstile|captcha/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Correos de El Salvador answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Correos de El Salvador returned a reply that is not JSON', { cause });
  }
}

/** The tracking service's address for one code. */
export function correosElSalvadorLookupUrl(number: string): string {
  return `${CORREOS_EL_SALVADOR_API}${encodeURIComponent(number)}`;
}

export class CorreosElSalvadorTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeCorreosElSalvadorNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(correosElSalvadorLookupUrl(number), { method: 'GET', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: CORREOS_EL_SALVADOR_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE] });
      const body = decodeText(bytes).replace(/^\uFEFF/, '').trim();
      if (response.status === 404 && isCorreosElSalvadorMissing(response.headers.get('content-type') ?? '', body)) {
        throw new NotFoundError(PROVIDER);
      }
      if (REDIRECTS.includes(response.status) || GONE.includes(response.status)) {
        throw new TransportError(PROVIDER, 'Correos de El Salvador tracking lookup is unavailable', { status: response.status });
      }
      if (!body) throw new IndeterminateError(PROVIDER, 'Correos de El Salvador returned an empty reply');
      return parseCorreosElSalvador(json(body), number);
    };
    // A lookup that fails to reach the service, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'correos-el-salvador', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new CorreosElSalvadorTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'correos-el-salvador', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeCorreosElSalvadorNumber(number))),
  };
};
