import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { ENVIA_MAX_BYTES, isEnviaNotFound, normalizeEnviaNumber, parseEnvia, PROVIDER, readEnviaShipment } from './parser.js';

/** The API envia.co's tracking page reads a guía from: its record, then its milestones. */
export const ENVIA_API = 'https://envia.co/EnviaV2_Api/api/tracking';
const REDIRECTS = [301, 302, 303, 307, 308];
// The service answers an unknown guía with its own 404 reply; a 404 without it is a moved route.
const GONE = [404, 405, 410];
// Bot checks and block pages a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|g-recaptcha|hcaptcha|_Incapsula_Resource|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden)/i;
// Unknown guías can take ten seconds or more to answer.
const BUDGET_MS = 30_000;

function json(body: string, status: number): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (GONE.includes(status)) throw new TransportError(PROVIDER, 'Envía tracking lookup is unavailable', { status, cause });
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Envía answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Envía returned a reply that is not JSON', { cause });
  }
}

export class EnviaTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async #request(url: string, init: { method: 'GET' | 'POST'; body?: string }, signal: AbortSignal, timeoutMs: number) {
    const { response, bytes } = await fetchBounded(url, { ...init, signal, headers: {
      Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs, maxBytes: ENVIA_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE] });
    if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Envía moved its tracking lookup', { status: response.status });
    return { status: response.status, body: json(decodeText(bytes), response.status) };
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeEnviaNumber(raw);
    const read = async (signal: AbortSignal, remainingMs: number): Promise<CarrierResult> => {
      const deadline = Date.now() + remainingMs;
      const left = () => Math.max(1, Math.floor(deadline - Date.now()));
      const record = await this.#request(`${ENVIA_API}/individual`, { method: 'POST', body: JSON.stringify({ guiaNumber: number }) },
        signal, left());
      // Only the service's own not-found reply comes with a 404; anything else there is a moved route.
      if (record.status === 404 && isEnviaNotFound(record.body)) throw new NotFoundError(PROVIDER);
      if (record.status !== 200) throw new TransportError(PROVIDER, 'Envía tracking lookup is unavailable', { status: record.status });
      const shipment = readEnviaShipment(record.body, number);
      const history = await this.#request(`${ENVIA_API}/history/${number}`, { method: 'GET' }, signal, left());
      if (history.status !== 200) throw new TransportError(PROVIDER, 'Envía history lookup is unavailable', { status: history.status });
      return parseEnvia(shipment, history.body, number);
    };
    // A request that fails to reach Envía, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'envia-colombia', budgetMs: context.budgetMs ?? BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new EnviaTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'envia-colombia', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeEnviaNumber(number))),
  };
};
