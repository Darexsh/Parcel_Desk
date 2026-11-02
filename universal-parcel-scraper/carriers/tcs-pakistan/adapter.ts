import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeTcsNumber, parseTcs, PROVIDER, TCS_MAX_BYTES } from './parser.js';

/** The bridge on tcsexpress.com that the tracking page sends its lookup through. */
export const TCS_API = 'https://www.tcsexpress.com/apibridge';
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 410];
// Bot checks and block pages a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|g-recaptcha|hcaptcha|_Incapsula_Resource|AwsWafIntegration|awswaf\.com|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden)/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'TCS answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'TCS returned a reply that is not JSON', { cause });
  }
}

export class TcsTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeTcsNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // The request the tracking page's script builds: the bridge forwards a GET of `trackapinew` with `param` as its query.
      const { response, bytes } = await fetchBounded(TCS_API, { method: 'POST', signal, headers: {
        Accept: 'application/json', 'Content-Type': 'application/json; charset=UTF-8', 'User-Agent': userAgentOf(this.options.userAgent),
      }, body: JSON.stringify({ body: { url: 'trackapinew', type: 'GET', headers: {}, payload: {}, param: `consignee=${number}` } }) },
      { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: TCS_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 400, ...GONE] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'TCS moved its tracking lookup');
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'TCS tracking lookup is unavailable');
      // The bridge checks the request's shape, so a refusal means the page's request changed.
      if (response.status === 400) throw new SchemaError(PROVIDER, 'TCS refused the lookup as malformed', { status: 400 });
      return parseTcs(json(decodeText(bytes)), number);
    };
    return runSteps({ carrier: 'tcs-pakistan', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, remainingMs) },
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new TcsTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'tcs-pakistan', recordsSteps: true, steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeTcsNumber(number))),
  };
};
