import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CEVA_DETAILS_MAX_BYTES, CEVA_SEARCH_MAX_BYTES, cevaLogisticsDetailsUrl, cevaLogisticsSearchUrl, isCevaLogisticsMissing,
  normalizeCevaLogisticsNumber, parseCevaLogisticsDetails, parseCevaLogisticsSearch, PROVIDER } from './parser.js';

export { CEVA_SHIPMENTS } from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks Akamai or Cloudflare could put in place of a reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Access Denied)|bm-verify|sec-if-cpt|errors\.edgesuite\.net/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'CEVA answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'CEVA returned a reply that is not JSON', { cause });
  }
}

/** A reply that need not be JSON, such as an error page. */
function lenient(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/** A lookup's answer: the reply, the house bill it does not know, or nothing at all. */
type Answer = { kind: 'reply'; payload: unknown } | { kind: 'missing' } | { kind: 'empty' };

export class CevaLogisticsTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeCevaLogisticsNumber(raw);
    // One attempt opens the number as a house bill, as a link from CEVA does.
    // When the tracker does not know it as one, it runs the tracking page's
    // search and opens the shipment whose house bill or order number is the
    // whole number. None of it needs a cookie, a token or a browser.
    const attempt = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      // A request left without time fails as a timeout, which the retry can recover.
      const left = () => Math.max(1, Math.floor(deadline - performance.now()));
      const read = async (url: string, maxBytes: number): Promise<Answer> => {
        const { response, bytes } = await fetchBounded(url, { method: 'GET', signal,
          headers: { Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) } }, { provider: PROVIDER, timeoutMs: left(), maxBytes,
          redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 204, 403, 404, 410] });
        if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'CEVA redirected its tracking lookup');
        if (response.status === 403) throw new ChallengeError(PROVIDER, 'CEVA refused the lookup', { status: 403 });
        if (response.status === 204) return { kind: 'empty' };
        const body = decodeText(bytes);
        if (response.status === 200) return { kind: 'reply', payload: json(body) };
        // The lookup answers an unknown house bill with its own 404; another 404 is a moved route.
        if (response.status === 404 && isCevaLogisticsMissing(lenient(body))) return { kind: 'missing' };
        throw new TransportError(PROVIDER, 'CEVA tracking lookup is unavailable');
      };
      const details = await read(cevaLogisticsDetailsUrl(number), CEVA_DETAILS_MAX_BYTES);
      if (details.kind === 'reply') return parseCevaLogisticsDetails(details.payload, number);
      if (details.kind === 'empty') throw new SchemaError(PROVIDER, 'CEVA returned an empty shipment');
      const search = await read(cevaLogisticsSearchUrl(number), CEVA_SEARCH_MAX_BYTES);
      if (search.kind === 'missing') throw new NotFoundError(PROVIDER);
      if (search.kind === 'empty') throw new IndeterminateError(PROVIDER, 'CEVA did not run the search');
      const match = parseCevaLogisticsSearch(search.payload, number);
      const opened = await read(cevaLogisticsDetailsUrl(match.reference, match.type), CEVA_DETAILS_MAX_BYTES);
      if (opened.kind !== 'reply') throw new IndeterminateError(PROVIDER, 'CEVA did not open the shipment its search matched');
      return parseCevaLogisticsDetails(opened.payload, number, match);
    };
    // An attempt that fails to reach CEVA, or hangs, gets one more: the first
    // gets half of the budget, so the retry fits in the rest. An HTTP status,
    // a rate limit included, is never sent again.
    return runSteps({ carrier: 'ceva-logistics', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => attempt(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => attempt(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new CevaLogisticsTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'ceva-logistics', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeCevaLogisticsNumber(number))),
  };
};
