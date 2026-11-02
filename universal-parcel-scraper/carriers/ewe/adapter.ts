import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { normalizeEweNumber, parseEweLookup, parseEweTrace, PROVIDER } from './parser.js';
import { getJson, orderRouteUrl } from './trace.js';

/** The lookup the tracking page on www.ewe.com.au makes for the number typed in. */
export const EWE_LOOKUP = 'https://www.epintl.com.au/oms/api/tracking/emetro/';
/** The lookup of EWE's trace tracker on trace.ewe.com.au. */
export const EWE_TRACE = 'https://trace.ewe.com.au/api/trace/orderRoute';
export const eweLookupUrl = (number: string) => `${EWE_LOOKUP}${encodeURIComponent(number)}`;
export const eweTraceUrl = (number: string) => orderRouteUrl(EWE_TRACE, number);

export class EweTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  // Both lookups answer an unknown number in a 200 reply: a 404 or a redirect is a moved route.
  private get(url: string, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
    return getJson(url, PROVIDER, signal, timeoutMs, this.options);
  }

  /**
   * Both lookups at once. The trace tracker's scans carry codes and instants,
   * so its answer wins when it has the parcel; otherwise the tracking page's
   * lookup, which also knows eMetro's consignments, gives the answer, found,
   * not found or failed.
   */
  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const sibling = new AbortController();
    const both = AbortSignal.any([signal, sibling.signal]);
    const lookup = this.get(eweLookupUrl(number), both, timeoutMs).then((payload) => parseEweLookup(payload, number));
    // Read below, or left once the trace tracker answers.
    lookup.catch(() => undefined);
    try {
      const traced = parseEweTrace(await this.get(eweTraceUrl(number), both, timeoutMs), number);
      sibling.abort();
      return traced;
    } catch {
      return await lookup;
    }
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeEweNumber(raw);
    // A lookup that fails to reach the trackers, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'ewe', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new EweTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'ewe', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
