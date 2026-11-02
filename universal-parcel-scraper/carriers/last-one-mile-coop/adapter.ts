import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  decodeLastOneMilePage, LAST_ONE_MILE_FORM, LAST_ONE_MILE_MAX_BYTES, normalizeLastOneMileNumber, parseLastOneMile, PROVIDER,
} from './parser.js';

/** Yamato System Development's tracker, which hosts the co-op's inquiry form. */
export const LAST_ONE_MILE_TRACKING = 'https://y-track.jp/ytrack/inqservlet';
const REDIRECTS = [301, 302, 303, 307, 308];

/** The page the co-op's links open for one waybill. */
export function lastOneMileUrl(number: string): string {
  return `${LAST_ONE_MILE_TRACKING}?${new URLSearchParams({ ...LAST_ONE_MILE_FORM, number01: number })}`;
}

export class LastOneMileTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeLastOneMileNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(lastOneMileUrl(number), { signal, headers: {
        Accept: 'text/html', 'Accept-Language': 'ja', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: LAST_ONE_MILE_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
      // The page answers HTTP 200 for a number it does not know; a redirect or a 404 is a moved route.
      if (response.status !== 200) throw new TransportError(PROVIDER, 'Last One Mile Co-op tracking page moved');
      return parseLastOneMile(decodeLastOneMilePage(bytes, response.headers.get('content-type')), number);
    };
    // A read that fails to reach the site, or hangs, gets one more: the first gets half of the budget.
    return runSteps({ carrier: 'last-one-mile-coop', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new LastOneMileTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'last-one-mile-coop', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeLastOneMileNumber(number))),
  };
};
