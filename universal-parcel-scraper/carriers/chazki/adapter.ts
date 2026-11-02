import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeChazkiNumber, ORDER_MAX_BYTES, parseChazkiOrder, PROVIDER, readChazkiSearch, SEARCH_MAX_BYTES } from './parser.js';

/** The GraphQL service the tracking page on nintendo.chazki.com asks. */
export const CHAZKI_API = 'https://backend.chazki.com/';
const ORIGIN = 'https://nintendo.chazki.com';
// The page's search, for the orders under a trackcode.
const SEARCH = 'query getOrderPublicTrackCode($trackCode: String!) { OrderPublicTrackCode: getOrderPublicTrackCode(trackCode: $trackCode) { id trackCode } }';
// The page's order query, cut to the fields the adapter reads: the page's own
// also asks for the sender's and recipient's names, phones, IDs and addresses,
// the driver and the delivery evidence.
const ORDER = 'query getOrderPublic($id: Int) { OrderPublic: getOrderPublic(id: $id) { id trackCode Service { name } '
  + 'Status { subtype subclass } OrderServiceHistorialPublic { statusID createdAt } } }';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required)|AwsWafIntegration|awswaf\.com/i;

function json(bytes: Uint8Array): unknown {
  const body = decodeText(bytes);
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Chazki answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Chazki returned a reply that is not JSON', { cause });
  }
}

export class ChazkiTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeChazkiNumber(raw);
    const read = async (signal: AbortSignal, budgetMs: number): Promise<CarrierResult> => {
      const started = performance.now();
      const timeoutMs = () => Math.max(1, Math.floor(budgetMs - (performance.now() - started)));
      const query = async (operationName: string, variables: Record<string, unknown>, text: string, maxBytes: number) => {
        const { response, bytes } = await fetchBounded(CHAZKI_API, { method: 'POST', signal, headers: {
          Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
          Origin: ORIGIN, Referer: `${ORIGIN}/`,
        }, body: JSON.stringify({ operationName, variables, query: text }) }, { provider: PROVIDER, timeoutMs: timeoutMs(),
          maxBytes, redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 400, 404, 410] });
        // A redirect or a missing route is a moved service, not a missing parcel.
        if (REDIRECTS.includes(response.status) || response.status === 404 || response.status === 410) {
          throw new TransportError(PROVIDER, 'Chazki tracking service is unavailable');
        }
        // GraphQL answers a query it refuses with HTTP 400 and its errors, which the parser reads.
        return json(bytes);
      };
      const id = readChazkiSearch(await query('getOrderPublicTrackCode', { trackCode: number }, SEARCH, SEARCH_MAX_BYTES), number);
      return parseChazkiOrder(await query('getOrderPublic', { id }, ORDER, ORDER_MAX_BYTES), number, id);
    };
    // A request that fails to reach Chazki, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'chazki', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ChazkiTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'chazki', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context) };
};
