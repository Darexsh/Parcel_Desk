import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizePaquetexpressNumber, PAQUETEXPRESS_MAX_BYTES, parsePaquetexpress, PROVIDER } from './parser.js';

// The history service Paquetexpress's tracking page asks for each number.
export const PAQUETEXPRESS_ENDPOINT = 'https://cc.paquetexpress.com.mx/ptxws/rest/api/v1/guia/historico/';
// The access token the tracking page and the Android app send with every
// lookup, the same for every visitor.
const PAGE_TOKEN = '@1@2@3@4@5'; // gitleaks:allow
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route is not a missing parcel: an unknown number gets an empty list with HTTP 200.
const GONE = [404, 410];
// The reply is a JSONP call whose argument is the list of rows.
const WRAPPER = /^\s*Resultado\(([\s\S]*)\)\s*;?\s*$/;
// A challenge page, which can come instead of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|captcha|<title>\s*(?:Just a moment|Attention Required|Access Denied)/i;

export function paquetexpressTrackingUrl(raw: string): string {
  return `${PAQUETEXPRESS_ENDPOINT}${normalizePaquetexpressNumber(raw)}/${PAGE_TOKEN}?source=WEBPAGE`;
}

function rows(body: string): unknown {
  const wrapped = WRAPPER.exec(body);
  try {
    if (!wrapped) throw new SyntaxError('not a Resultado(...) call');
    return JSON.parse(wrapped[1]!);
  } catch (error) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Paquetexpress answered with a browser challenge', { cause: error });
    throw new SchemaError(PROVIDER, 'Paquetexpress returned a reply that is not its row list', { cause: error });
  }
}

export class PaquetexpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const url = paquetexpressTrackingUrl(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // The page sends no cookie; the service rejects a request whose Accept
      // header it cannot parse, so it gets the page's own.
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'application/json, text/plain, */*', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: PAQUETEXPRESS_MAX_BYTES, redirect: 'manual',
        allowHttpStatuses: [...REDIRECTS, ...GONE], fetcher: this.options.fetcher });
      if (REDIRECTS.includes(response.status)) throw new IndeterminateError(PROVIDER, 'Paquetexpress moved its tracking service');
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'Paquetexpress tracking service is unavailable');
      return parsePaquetexpress(rows(decodeText(bytes)), raw);
    };
    // A request that fails to reach Paquetexpress, or hangs, gets one more
    // try: the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'paquetexpress', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new PaquetexpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'paquetexpress', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizePaquetexpressNumber(number))),
  };
};
