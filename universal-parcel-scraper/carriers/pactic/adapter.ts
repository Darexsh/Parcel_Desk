import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CARRIER, isPacticWaybill, normalizePacticNumber, PACTIC_MAX_BYTES, pacticJson, parsePactic, PROVIDER } from './parser.js';

/** The lookup Pactic's tracking page makes for one waybill. */
export const PACTIC_TRACKING_API = 'https://dashboard.pactic.com/api/Meta/tracking';
const REDIRECTS = [301, 302, 303, 307, 308];
// The tracker answers an unknown waybill with an empty list: a missing route is not a missing parcel.
const GONE = [404, 405, 410];
const DEFAULT_BUDGET_MS = 15_000;

/** The lookup's address for one waybill. */
export function pacticTrackingUrl(number: string): string {
  return `${PACTIC_TRACKING_API}?waybill=${encodeURIComponent(number)}`;
}

export class PacticTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(pacticTrackingUrl(number), { method: 'GET', signal, headers: {
      Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: PACTIC_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 400] });
    const { status } = response;
    // Its validation refuses a waybill with HTTP 400; that says nothing about whether the parcel exists.
    if (status === 400) throw new IndeterminateError(PROVIDER, 'Pactic refused the waybill', { status });
    if (REDIRECTS.includes(status) || GONE.includes(status)) throw new TransportError(PROVIDER, 'Pactic tracking lookup is unavailable', { status });
    return parsePactic(pacticJson(decodeText(bytes)), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizePacticNumber(raw);
    // A read that fails to reach Pactic, or hangs, is sent once more: the first
    // try gets half of the budget.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new PacticTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    // Only Pactic's own waybills: a partner courier's number belongs to that courier, though the tracker knows it.
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizePacticNumber(number)) && isPacticWaybill(number)),
  };
};
