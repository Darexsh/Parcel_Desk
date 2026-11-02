import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CJ_SCANS_MAX_BYTES, CJ_WAYBILL_MAX_BYTES, normalizeCjNumber, parseCjScans, PROVIDER, readCjWaybill } from './parser.js';

/** The lookups of CJ Logistics' tracker on trace.cjlogistics.com/next/tracking.html. */
export const CJ_TRACE_API = 'https://trace.cjlogistics.com/next/rest/';
const REDIRECTS = [301, 302, 303, 307, 308];
// A bot check or a firewall's refusal in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied)|AwsWafIntegration|awswaf\.com|captcha/i;

function json(bytes: Uint8Array): unknown {
  const body = decodeText(bytes);
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'CJ Logistics answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'CJ Logistics returned a reply that is not JSON', { cause });
  }
}

export class CjLogisticsTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeCjNumber(raw);
    const read = async (signal: AbortSignal, budgetMs: number): Promise<CarrierResult> => {
      const started = performance.now();
      const timeoutMs = () => Math.max(1, Math.floor(budgetMs - (performance.now() - started)));
      // The tracker's form post: the number alone, with no session, token or key.
      const post = async (operation: string, maxBytes: number) => {
        const { response, bytes } = await fetchBounded(`${CJ_TRACE_API}${operation}`, { method: 'POST', signal, headers: {
          Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'User-Agent': userAgentOf(this.options.userAgent),
        }, body: new URLSearchParams({ wblNo: number }).toString() }, { provider: PROVIDER, timeoutMs: timeoutMs(), maxBytes,
          redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 405, 410] });
        // The tracker reads a missing parcel from a 200 reply: anything else is a moved route.
        if (!response.ok) throw new TransportError(PROVIDER, 'CJ Logistics tracking lookup is unavailable');
        return json(bytes);
      };
      const scans = parseCjScans(await post('selectTrackingDetailList.do', CJ_SCANS_MAX_BYTES), number);
      if (scans) return scans;
      // Without scans, the waybill's own record tells a registered waybill from an unknown one.
      return readCjWaybill(await post('selectTrackingWaybil.do', CJ_WAYBILL_MAX_BYTES), number);
    };
    // A request that fails to reach CJ Logistics, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'cj-logistics', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new CjLogisticsTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'cj-logistics', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeCjNumber(number))),
  };
};
