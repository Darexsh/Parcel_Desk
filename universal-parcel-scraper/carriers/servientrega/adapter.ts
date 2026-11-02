import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeServientregaNumber, parseServientrega, PROVIDER, SERVIENTREGA_MAX_BYTES } from './parser.js';

/** The guide lookup Servientrega's app makes through its public API gateway. */
export const SERVIENTREGA_API = 'https://apim-servientrega-prd.azure-api.net/portal-rastreo/api/ControlRastreovalidaciones';
const REDIRECTS = [301, 302, 303, 307, 308];
// The gateway answers a route it does not know with 404: a missing route is not a missing guide.
const GONE = [404, 410];
// Bot checks and block pages a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|g-recaptcha|hcaptcha|_Incapsula_Resource|Web Application Firewall|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden)/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Servientrega answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Servientrega returned a reply that is not JSON', { cause });
  }
}

export class ServientregaTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeServientregaNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // The zeros are the tracker's "no answer yet" to the checks it can ask for.
      const { response, bytes } = await fetchBounded(SERVIENTREGA_API, { method: 'POST', signal, headers: {
        Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      }, body: JSON.stringify({ numeroGuia: number, idValidacionUsuario: '0', tipoDatoValidar: '0', datoRespuestaUsuario: '0', idpais: 1, lenguaje: 'es' }) },
      { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: SERVIENTREGA_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 400, ...GONE] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Servientrega moved its tracking lookup');
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'Servientrega tracking lookup is unavailable');
      // The number is checked first, so a refused request no longer fits the service.
      if (response.status === 400) throw new SchemaError(PROVIDER, 'Servientrega refused the lookup as malformed', { status: 400 });
      return parseServientrega(json(decodeText(bytes)), number);
    };
    return runSteps({ carrier: 'servientrega', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, remainingMs) },
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ServientregaTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'servientrega', recordsSteps: true, steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeServientregaNumber(number))),
  };
};
