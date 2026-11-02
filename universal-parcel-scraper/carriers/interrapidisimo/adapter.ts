import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  INTERRAPIDISIMO_MAX_BYTES, isInterrapidisimoAnswer, interrapidisimoSession, normalizeInterrapidisimoNumber, parseInterrapidisimo, PROVIDER,
} from './parser.js';

const GATEWAY = 'https://gateway.interrapidisimo.com';
/** The search the tracker at siguetuenvio.interrapidisimo.com makes for the guide typed in. */
export const INTERRAPIDISIMO_SEARCH = `${GATEWAY}/ConsultaGuiasSTE/api/v1/Guias/ConsultarGuias`;
/** The summary of the guides a search found. */
export const INTERRAPIDISIMO_SUMMARY = `${GATEWAY}/ConsultaGuiasSTE/api/v1/ResultadoConsulta/ConsultarGuias`;
/** The milestones of one guide. */
export const INTERRAPIDISIMO_MILESTONES = `${GATEWAY}/ServiciosTrackingSTE/api/v1/EstadoTracking/ObtenerEstadoTracking`;
// The tracker's application number, which the milestones service asks for.
const APPLICATION = '39';
const REDIRECTS = [301, 302, 303, 307, 308];
// The service answers its own refusals and missing guides with a JSON body under these statuses.
const ANSWERED = [400, 401, 404];
// Akamai, in front of the gateway, could put a block page in place of a reply.
const CHALLENGE = /Access Denied|Reference #\d|_abck|bm-verify|<title>\s*(?:Just a moment|Attention Required)/i;

function json(body: string, status: number): unknown {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Inter Rapidísimo answered with a block page', { cause });
    if (status === 404) throw new TransportError(PROVIDER, 'Inter Rapidísimo tracking lookup is unavailable', { cause, status });
    throw new SchemaError(PROVIDER, 'Inter Rapidísimo returned a reply that is not JSON', { cause });
  }
  // A 404 without the service's own answer is a moved route.
  if (status === 404 && !isInterrapidisimoAnswer(payload)) {
    throw new TransportError(PROVIDER, 'Inter Rapidísimo tracking lookup is unavailable', { status });
  }
  return payload;
}

export class InterrapidisimoTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeInterrapidisimoNumber(raw);
    // The page's three requests: the search opens a session for the guide, under
    // which it reads the guide's summary and its milestones.
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      const left = () => Math.max(1, Math.floor(deadline - performance.now()));
      // The page sends an empty ALTCHA payload while its check is switched off.
      const session = interrapidisimoSession(await this.#json(
        `${INTERRAPIDISIMO_SEARCH}?NumerosGuias=${number}&altchaPayload=`, { method: 'GET' }, signal, left()));
      const summary = await this.#json(INTERRAPIDISIMO_SUMMARY, { method: 'POST', body: JSON.stringify({ idConsulta: session }) }, signal, left());
      const milestones = await this.#json(`${INTERRAPIDISIMO_MILESTONES}?numeroGuia=${number}`,
        { method: 'GET', headers: { Authorization: session, idaplicacion: APPLICATION } }, signal, left());
      return parseInterrapidisimo(summary, milestones, number);
    };
    return runSteps({ carrier: 'interrapidisimo', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, remainingMs) },
    ]);
  }

  async #json(url: string, init: { method: string; body?: string; headers?: Record<string, string> }, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
    const { response, bytes } = await fetchBounded(url, { method: init.method, signal, headers: {
      Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent), ...init.headers,
    }, ...(init.body ? { body: init.body } : {}) }, { provider: PROVIDER, timeoutMs, maxBytes: INTERRAPIDISIMO_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...ANSWERED, 403] });
    if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Inter Rapidísimo redirected its tracking lookup');
    if (response.status === 403) throw new ChallengeError(PROVIDER, 'Inter Rapidísimo refused the lookup', { status: 403 });
    return json(decodeText(bytes), response.status);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new InterrapidisimoTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'interrapidisimo', recordsSteps: true, steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeInterrapidisimoNumber(number))),
  };
};
