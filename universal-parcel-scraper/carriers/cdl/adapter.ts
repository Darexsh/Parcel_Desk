import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { cdlRequestNumber } from './number.js';
import { CDL_MAX_BYTES, parseCdl, PROVIDER } from './parser.js';

// The service the tracking page at apps.cdldelivers.com/Tracking-Page asks, without a key, cookie or token.
export const CDL_DETAILS = 'https://apps.cdldelivers.com/Tracking-Page-API/Tracking/details';
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route is not a missing parcel: the service answers an unknown number with HTTP 204.
const GONE = [404, 410];
// A firewall or bot check's page instead of the service's JSON, which can come with HTTP 200.
const BLOCKED = /<title>\s*(?:Web Page Blocked|Request Rejected|Access Denied|Attention Required|Just a moment)|_cf_chl_opt|cf-turnstile|captcha|The requested URL was rejected/i;

/** The service's address for one number, as the tracking page asks it. */
export function cdlDetailsUrl(raw: string): string {
  return `${CDL_DETAILS}?${new URLSearchParams({ value: cdlRequestNumber(raw) })}`;
}

export class CdlTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const url = cdlDetailsUrl(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: CDL_MAX_BYTES,
        redirect: 'manual', allowHttpStatuses: [...REDIRECTS, ...GONE], fetcher: this.options.fetcher });
      if (REDIRECTS.includes(response.status)) throw new IndeterminateError(PROVIDER, 'CDL sent the lookup to another address');
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'CDL tracking service is unavailable');
      const text = decodeText(bytes).replace(/^\uFEFF/, '');
      // The service answers a number it has no parcel under with an empty HTTP 204.
      if (response.status === 204 && !text.trim()) throw new NotFoundError(PROVIDER);
      if (response.status !== 200 || !text.trim()) throw new IndeterminateError(PROVIDER, 'CDL answered the lookup without a parcel');
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch (cause) {
        if (BLOCKED.test(text.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'CDL answered with a block page', { cause });
        // The body is left out of the error: a parcel's reply carries delivery photos and names.
        throw new SchemaError(PROVIDER, 'CDL returned a reply that is not JSON', { cause });
      }
      if (payload === null) throw new IndeterminateError(PROVIDER, 'CDL answered the lookup without a parcel');
      return parseCdl(payload, raw);
    };
    // A request that fails to reach CDL, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'cdl', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new CdlTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'cdl', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => cdlRequestNumber(number))),
  };
};
