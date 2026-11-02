import { recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { A_TU_HORA_MAX_BYTES, aTuHoraCredential, carriesPostcode, parseATuHora, parseATuHoraGuid, PROVIDER } from './parser.js';

const SERVICE = 'https://mydelivery.atuhoraexpress.com/service/envios';
/** The lookup the tracking form on mydelivery.atuhoraexpress.com makes for a code and postcode. */
export const A_TU_HORA_LOOKUP = `${SERVICE}/detalle-envio-login-guid/`;
/** The shipment the form then opens under the identifier the lookup returned. */
export const A_TU_HORA_DETAIL = `${SERVICE}/detalle-envio/`;
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required)|captcha|Request Rejected/i;

export function aTuHoraLookupUrl(code: string, postcode: string): string {
  return `${A_TU_HORA_LOOKUP}${encodeURIComponent(code)}/${encodeURIComponent(postcode)}`;
}

/** The page asks in Spanish, the language of the status wordings. */
export function aTuHoraDetailUrl(guid: string): string {
  return `${A_TU_HORA_DETAIL}${encodeURIComponent(guid)}?idioma=ES`;
}

/** A reply's JSON; an empty body is the page's null. */
function json(body: string): unknown {
  if (!body.trim()) return null;
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'A Tu Hora Express answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'A Tu Hora Express returned a reply that is not JSON', { cause });
  }
}

export class ATuHoraExpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, postcode: string | null | undefined, context: TrackingContext = {}): Promise<CarrierResult> {
    const credential = aTuHoraCredential(raw, postcode);
    const post = async (url: string, signal: AbortSignal, timeoutMs: number): Promise<unknown> => {
      // The page posts an empty JSON object to both routes.
      const { response, bytes } = await fetchBounded(url, { method: 'POST', signal, headers: {
        Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      }, body: '{}' }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: A_TU_HORA_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 405, 410] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'A Tu Hora Express redirected its tracking lookup');
      if ([404, 405, 410].includes(response.status)) throw new TransportError(PROVIDER, 'A Tu Hora Express tracking lookup is unavailable');
      if (response.status !== 200) throw new IndeterminateError(PROVIDER, 'A Tu Hora Express did not answer with its tracking reply');
      return json(decodeText(bytes));
    };
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      const left = () => deadline - performance.now();
      const guid = parseATuHoraGuid(await post(aTuHoraLookupUrl(credential.code, credential.postcode), signal, left()));
      return parseATuHora(await post(aTuHoraDetailUrl(guid), signal, left()), credential, guid);
    };
    // A read that fails to reach the tracker, or hangs, gets one more: the first
    // gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'a-tu-hora-express', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ATuHoraExpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'a-tu-hora-express', recordsSteps: true, steps: ['direct', 'retry'],
    // The 24-digit form carries its postcode; a shorter code takes the caller's.
    track: (input, context) => tracker.fetch(input.number, input.postcode, context),
    // Recognition gets no postcode, so only the 24-digit form can be asked.
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, null, context), () => carriesPostcode(number)),
  };
};
