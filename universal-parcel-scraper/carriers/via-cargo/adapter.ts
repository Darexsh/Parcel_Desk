import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeViaCargoNumber, parseViaCargo, PROVIDER, VIA_CARGO_MAX_BYTES } from './parser.js';

/** The lookup the tracking page on formularios.viacargo.com.ar makes for the number in its address. */
export const VIA_CARGO_API = 'https://ws.busplus.com.ar/alerce/tracking';
// The page's access key for its own service, the same for every visitor.
const PUBLIC_KEY = 'ikh&/54g.Op'; // gitleaks:allow
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required)|AwsWafIntegration|g-recaptcha|hcaptcha/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Via Cargo answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Via Cargo returned a reply that is not JSON', { cause });
  }
}

/** The page's request: the number and its reCAPTCHA token, which the service does not check, so it is left empty. */
export function viaCargoUrl(number: string): string {
  const url = new URL(VIA_CARGO_API);
  url.search = new URLSearchParams({ NumeroEnvio: number, tokenRecaptcha: '' }).toString();
  return url.toString();
}

export class ViaCargoTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeViaCargoNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(viaCargoUrl(number), { method: 'GET', signal, headers: {
        Accept: 'application/json', 'PUBLIC-KEY': PUBLIC_KEY, 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: VIA_CARGO_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 410] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Via Cargo redirected its tracking lookup');
      // The service answers an unknown number with HTTP 200; a 404 is a moved route.
      if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'Via Cargo tracking lookup is unavailable');
      // `{"status":false,"message":"Acceso Denegado"}` refuses the page's key; a firewall's 403 is a browser check.
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'Via Cargo refused the lookup', { status: 403 });
      return parseViaCargo(json(decodeText(bytes)), number);
    };
    // A request that fails to reach the service, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'via-cargo', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ViaCargoTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'via-cargo', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeViaCargoNumber(number))),
  };
};
