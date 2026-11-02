import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { DPD_ZA_MAX_BYTES, normalizeDpdZaNumber, parseDpdZa, PROVIDER } from './parser.js';

/** The lookup the parcel tracker app, which DPD South Africa's tracking page frames, makes for one waybill. */
export const DPD_ZA_API = 'https://website.dpdl.co.za/s/QuickTrack';
const REDIRECTS = [301, 302, 303, 307, 308];
// The tracker reads a missing waybill from a 200 reply: a missing route is a moved lookup.
const GONE = [404, 410];

/** The lookup's address for one waybill, as the tracker app builds it. */
export function dpdZaLookupUrl(number: string): string {
  return `${DPD_ZA_API}?${new URLSearchParams({ waybillNo: number, includeRelatedWaybills: 'true',
    includeCollectionTrackingEvents: 'true' }).toString()}`;
}

export class DpdZaTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeDpdZaNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(dpdZaLookupUrl(number), { method: 'GET', signal, headers: {
        Accept: 'application/json, text/plain, */*', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: DPD_ZA_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 403] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'DPD South Africa redirected its tracking lookup', { status: response.status });
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'DPD South Africa tracking lookup is unavailable', { status: response.status });
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'DPD South Africa refused the lookup', { status: 403 });
      return parseDpdZa(decodeText(bytes), number);
    };
    // A lookup that fails to reach the site, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'dpd-za', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new DpdZaTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'dpd-za', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeDpdZaNumber(number))),
  };
};
