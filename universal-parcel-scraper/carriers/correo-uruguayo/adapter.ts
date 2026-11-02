import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CORREO_URUGUAYO_MAX_BYTES, normalizeCorreoUruguayoNumber, parseCorreoUruguayo, PROVIDER } from './parser.js';

/** The lookup the tracking page on ahiva.correo.com.uy makes for the codes in its address or form. */
export const CORREO_URUGUAYO_API = 'https://ahiva.correo.com.uy/servicioConsultaTntIps-ws/seguimientoEnvios/eventosweb';
const REDIRECTS = [301, 302, 303, 307, 308];
// The tracker answers an unknown code in its reply: a missing route is not a missing item.
const GONE = [404, 405, 410];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|_cf_chl_opt|cf-turnstile|captcha/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Correo Uruguayo answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Correo Uruguayo returned a reply that is not JSON', { cause });
  }
}

/** The tracker's address for one code. The page joins several with semicolons; only the one asked is sent. */
export function correoUruguayoLookupUrl(number: string): string {
  return `${CORREO_URUGUAYO_API}?${new URLSearchParams({ codigoPieza: number })}`;
}

export class CorreoUruguayoTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeCorreoUruguayoNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(correoUruguayoLookupUrl(number), { method: 'GET', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: CORREO_URUGUAYO_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 403] });
      if (REDIRECTS.includes(response.status) || GONE.includes(response.status)) {
        throw new TransportError(PROVIDER, 'Correo Uruguayo tracking lookup is unavailable', { status: response.status });
      }
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'Correo Uruguayo refused the lookup', { status: 403 });
      const body = decodeText(bytes).replace(/^\uFEFF/, '').trim();
      if (!body) throw new IndeterminateError(PROVIDER, 'Correo Uruguayo returned an empty reply');
      return parseCorreoUruguayo(json(body), number);
    };
    // A lookup that fails to reach the tracker, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'correo-uruguayo', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new CorreoUruguayoTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'correo-uruguayo', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeCorreoUruguayoNumber(number))),
  };
};
