import { accepted, recognizeFromBrowserLookup, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, NotFoundError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import type { TrawlClient } from '../../core/transport/trawl.js';
import { xpoBrowser } from './browser.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  normalizeXpoLtlNumber, parseXpoLtlHistory, parseXpoLtlSummary, PROVIDER, XPO_LTL_MAX_BYTES, xpoLtlResult, type XpoLtlSummary,
} from './parser.js';

/** XPO's former PRO tracking pages, which the server still renders for a plain request. */
export const XPO_LTL_TRACKING = 'https://ltl.xpo.com/webapp/manifestrpts_p_app/Tracking/TrackingRS.jsp';
export const XPO_LTL_HISTORY = 'https://ltl.xpo.com/webapp/manifestrpts_p_app/Tracking/ShipmentHistory.jsp';

/** The summary page, or the Mexico system's, as the not-found page links to it. */
export function xpoLtlSummaryUrl(number: string, mexico = false): string {
  return `${XPO_LTL_TRACKING}?${new URLSearchParams(mexico ? { rptMX: 'MX', PRO: number } : { PRO: number })}`;
}

/** The history page, with the parameters of the summary page's own link. */
export function xpoLtlHistoryUrl(number: string, mexico = false): string {
  return `${XPO_LTL_HISTORY}?${new URLSearchParams({ proNbr: number, rptMX: mexico ? 'MX' : '', intlMXShipmentHistNote: 'N' })}`;
}

export class XpoLtlTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; trawl?: TrawlClient | null } = {}) {}

  /** The summary, then its history unless `history` is false, which gives a summary-only result. */
  async fetch(raw: string, context: TrackingContext = {}, { history = true }: { history?: boolean } = {}): Promise<CarrierResult> {
    const number = normalizeXpoLtlNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = Date.now() + timeoutMs;
      let mexico = false;
      let summary: XpoLtlSummary;
      try {
        summary = parseXpoLtlSummary(await this.page(xpoLtlSummaryUrl(number), signal, deadline), number);
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
        // The not-found page sends shipments from Mexico to a system of their
        // own: a PRO is missing only when both say so.
        mexico = true;
        summary = parseXpoLtlSummary(await this.page(xpoLtlSummaryUrl(number, true), signal, deadline), number);
      }
      const scans = history ? parseXpoLtlHistory(await this.page(xpoLtlHistoryUrl(number, mexico), signal, deadline), number) : null;
      return xpoLtlResult(summary, scans);
    };
    // A request that fails to reach the site, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'xpo-ltl', budgetMs: context.budgetMs ?? (this.options.trawl ? 50_000 : 20_000), signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, this.options.trawl ? Math.min(10_000, firstAttemptMs(remainingMs)) : firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, this.options.trawl ? Math.min(5000, remainingMs) : remainingMs)),
      { id: 'trawl', enabled: history && !!this.options.trawl, run: ({ signal, remainingMs }) => xpoBrowser(this.options.trawl!, number, signal, remainingMs) },
    ]);
  }

  private async page(url: string, signal: AbortSignal, deadline: number): Promise<string> {
    const { response, bytes } = await fetchBounded(url, { signal, headers: {
      Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(deadline - Date.now())), maxBytes: XPO_LTL_MAX_BYTES,
      fetcher: this.options.fetcher });
    // The pages are Latin-1, as their header says.
    const charset = /charset=([^;]+)/i.exec(response.headers.get('content-type') ?? '')?.[1]?.trim().toLowerCase();
    return decodeText(bytes, charset === 'utf-8' || charset === 'utf8' ? 'utf-8' : 'windows-1252');
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new XpoLtlTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent, trawl: environment.trawl });
  return {
    id: 'xpo-ltl', recordsSteps: true, steps: ['direct', 'retry', 'trawl'],
    track: (input, context) => tracker.fetch(input.number, context),
    // The summary alone tells a known PRO from an unknown one.
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context, { history: false }),
      () => accepted(() => normalizeXpoLtlNumber(number))),
    recognizeWithBrowser: (number, context, previous) => {
      if (previous instanceof RateLimitedError || previous instanceof SchemaError || previous instanceof NotFoundError) return Promise.reject(previous);
      if (!environment.trawl) return Promise.reject(new ChallengeError(PROVIDER));
      if ((context?.budgetMs ?? 45000) <= 2000) return Promise.reject(new BudgetExceededError(PROVIDER, context?.budgetMs ?? 0));
      return recognizeFromBrowserLookup(() => runSteps({ carrier: 'xpo-ltl', budgetMs: context?.budgetMs ?? 45000,
        signal: context?.signal, recorder: environment.recorder }, [
        { id: 'trawl', run: ({ signal, remainingMs }) => xpoBrowser(environment.trawl!, number, signal, remainingMs) },
      ]));
    },
  };
};
