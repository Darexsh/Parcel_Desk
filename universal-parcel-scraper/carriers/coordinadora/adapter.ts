import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { COORDINADORA_MAX_BYTES, normalizeCoordinadoraNumber, parseCoordinadora, PROVIDER } from './parser.js';

/** The lookup Coordinadora's tracker at rastreo.coordinadora.com makes for one guide. */
export const COORDINADORA_API = 'https://apiv2.coordinadora.com/tracking/rastreo';
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route is not a missing guide: the service answers an unknown guide with HTTP 200.
const GONE = [404, 410];
// Bot checks and block pages a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|g-recaptcha|hcaptcha|_Incapsula_Resource|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden)/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Coordinadora answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Coordinadora returned a reply that is not JSON', { cause });
  }
}

export class CoordinadoraTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeCoordinadoraNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(COORDINADORA_API, { method: 'POST', signal, headers: {
        Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      }, body: JSON.stringify({ guias: [number] }) }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
        maxBytes: COORDINADORA_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Coordinadora moved its tracking lookup');
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'Coordinadora tracking lookup is unavailable');
      return parseCoordinadora(json(decodeText(bytes)), number);
    };
    return runSteps({ carrier: 'coordinadora', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, remainingMs) },
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new CoordinadoraTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'coordinadora', recordsSteps: true, steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeCoordinadoraNumber(number))),
  };
};
