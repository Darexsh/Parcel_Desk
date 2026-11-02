import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeOakHarborNumber, OAK_HARBOR_MAX_BYTES, parseOakHarbor, PROVIDER } from './parser.js';

/** The action the tracing page posts a PRO to; it answers with the trace details as HTML. */
export const OAK_HARBOR_ENDPOINT = 'https://www.oakh.com/tracingactions.php';
const TRACING_PAGE = 'https://www.oakh.com/page/tracing';
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route is not a missing shipment: the action answers unknown PROs with a notice.
const GONE = [404, 410];

/** The form the tracing page sends for one PRO, as a guest with no account. */
export function oakHarborLookupBody(number: string): URLSearchParams {
  const pro = normalizeOakHarborNumber(number);
  return new URLSearchParams({ action: 'loadTraceDetails', traceNum: pro, tracePro: pro, traceType: 'OHPRO',
    showPrevious: 'false', showNext: 'false', traceAccount: '0' });
}

export class OakHarborTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeOakHarborNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(OAK_HARBOR_ENDPOINT, { method: 'POST', signal, body: oakHarborLookupBody(number), headers: {
        Accept: '*/*',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        // The page's script sends these with each lookup.
        'X-Requested-With': 'XMLHttpRequest',
        Referer: TRACING_PAGE,
        'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: OAK_HARBOR_MAX_BYTES,
        redirect: 'manual', allowHttpStatuses: [...REDIRECTS, ...GONE], fetcher: this.options.fetcher });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Oak Harbor redirected its tracing action');
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'Oak Harbor tracing action is unavailable');
      const html = decodeText(bytes);
      // The action answers a request it does not recognize with an empty reply.
      if (!html.trim()) throw new IndeterminateError(PROVIDER, 'Oak Harbor returned an empty reply');
      return parseOakHarbor(html, number);
    };
    // A request that fails to reach Oak Harbor, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'oak-harbor', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new OakHarborTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'oak-harbor', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
