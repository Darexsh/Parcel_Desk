import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { CarrierError, ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, isNetworkFailure, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  CENTRAL_TRANSPORT_MAX_BYTES, centralTransportResult, centralTransportTraceBody, normalizeCentralTransportNumber,
  parseCentralTransportHistory, parseCentralTransportTrace, PROVIDER,
} from './parser.js';

const ORIGIN = 'https://www.centraltransport.com';
/** The trace the tracking page's script asks for the PRO numbers typed in. */
export const CENTRAL_TRANSPORT_TRACE = `${ORIGIN}/webservices/ctservice.asmx/GetTraceLegStatus`;
/** The travel history the page's script asks for one traced shipment. */
export const CENTRAL_TRANSPORT_HISTORY = `${ORIGIN}/tools/track-shipment.aspx/GetTrackDetails`;
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Access Denied|Request Rejected)|The requested URL was rejected|captcha/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Central Transport answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Central Transport returned a reply that is not JSON', { cause });
  }
}

export class CentralTransportTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeCentralTransportNumber(raw);
    const attempt = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      // A request left without time fails as a timeout, which the retry can recover.
      const left = () => Math.max(1, Math.floor(deadline - performance.now()));
      const post = async (url: string, body: unknown): Promise<unknown> => {
        const { response, bytes } = await fetchBounded(url, { method: 'POST', signal, headers: {
          Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
        }, body: JSON.stringify(body) }, { provider: PROVIDER, timeoutMs: left(), maxBytes: CENTRAL_TRANSPORT_MAX_BYTES,
          redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
        // The site sends retired pages to its home page; that and a 404 are a moved route.
        if (response.status !== 200) throw new TransportError(PROVIDER, 'Central Transport tracking lookup is unavailable');
        return json(decodeText(bytes));
      };
      const trace = parseCentralTransportTrace(await post(CENTRAL_TRANSPORT_TRACE, centralTransportTraceBody(number)), number);
      let history: CarrierEvent[] | null;
      try {
        history = parseCentralTransportHistory(await post(CENTRAL_TRANSPORT_HISTORY, { pro: trace.pro, proNumKey: trace.key }), number);
      } catch (error) {
        // The page shows the history only when the summary turns it on, and no
        // reply seen does: a history it no longer serves leaves the summary.
        // A failed connection, a refusal, a rate limit or a cancellation stands.
        if (!(error instanceof CarrierError) || isNetworkFailure(error) || !['schema', 'transport', 'indeterminate'].includes(error.kind)) throw error;
        history = null;
      }
      return centralTransportResult(trace, history);
    };
    // An attempt that fails to reach Central Transport, or hangs, gets one
    // more: the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'central-transport', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => attempt(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => attempt(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new CentralTransportTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'central-transport', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
