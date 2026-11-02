import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  CARRIER, normalizeOcsNumber, OCS_HISTORY, OCS_LOOKUP, OCS_LOOKUP_MAX_BYTES, OCS_MAX_BYTES, ocsRoute, parseOcs, PROVIDER, type OcsHandoff,
} from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 20_000;
// The lookup's reply is one line. It only names the delivery company, so it never holds up the history for long.
const LOOKUP_MS = 3_000;

/** The lookup's address for one waybill, as the tracking form on OCS's site opened it. */
export function ocsLookupUrl(number: string): string {
  return `${OCS_LOOKUP}?cwbno=${encodeURIComponent(number)}`;
}

/** The history page's address for one waybill, where the lookup sends it. */
export function ocsHistoryUrl(number: string): string {
  return `${OCS_HISTORY}?cwbno=${encodeURIComponent(number)}`;
}

export class OcsTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  /** One page. Both answer HTTP 200, a waybill they do not hold included: another status is a moved route or a refusal. */
  private async page(url: string, signal: AbortSignal, timeoutMs: number, maxBytes: number): Promise<string> {
    const { response, bytes } = await fetchBounded(url, { signal, headers: {
      // The history page answers in the language asked, Japanese otherwise.
      Accept: 'text/html', 'Accept-Language': 'en', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 410] });
    if (response.status === 403) throw new ChallengeError(PROVIDER, 'OCS refused the lookup', { status: 403 });
    if (response.status !== 200) throw new TransportError(PROVIDER, 'OCS tracking page is unavailable', { status: response.status });
    return decodeText(bytes);
  }

  /** The delivery company the lookup hands the waybill to. A lookup that fails or does not answer in time names none. */
  private async handoff(number: string, signal: AbortSignal, timeoutMs: number): Promise<OcsHandoff> {
    try {
      return ocsRoute(await this.page(ocsLookupUrl(number), signal, timeoutMs, OCS_LOOKUP_MAX_BYTES), number);
    } catch {
      return {};
    }
  }

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // OCS's page holds the history, a delivery company's scans included; the lookup, asked at the same time, only names
    // the company. OCS took its tracking form off the lookup after a vulnerability notice, and its host stopped answering.
    const lookup = new AbortController();
    const handoff = this.handoff(number, AbortSignal.any([signal, lookup.signal]), Math.min(LOOKUP_MS, timeoutMs));
    try {
      const html = await this.page(ocsHistoryUrl(number), signal, timeoutMs, OCS_MAX_BYTES);
      const named = await handoff;
      signal.throwIfAborted();
      return parseOcs(html, number, named);
    } finally {
      lookup.abort();
    }
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeOcsNumber(raw);
    // A read that fails to reach OCS, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new OcsTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeOcsNumber(number))),
  };
};
