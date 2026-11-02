import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  assertNotChallenged, BARID_AL_MAGHRIB_MAX_BYTES, baridAlMaghribSummaryKnows, normalizeBaridAlMaghribNumber, parseBaridAlMaghrib, PROVIDER,
} from './parser.js';

const ORIGIN = 'https://www.barid.ma';
/** The page the tracking form opens for one code. */
export const BARID_AL_MAGHRIB_DETAIL = `${ORIGIN}/bamb2cstorefront/fr/tracking/getdetailentrytracking`;
/** The lookup the tracking form makes for several codes. */
export const BARID_AL_MAGHRIB_LOOKUP = `${ORIGIN}/bamb2cstorefront/fr/tracking/getTrackingByCode`;
/** Where the detail page sends a code it has no history for. */
const SEARCH_PAGE = '/bamb2cstorefront/fr/tracking/page';
const REDIRECTS = [301, 302, 303, 307, 308];
// The site answers an unknown code itself: a missing route is not a missing item.
const GONE = [404, 410];
const DEFAULT_BUDGET_MS = 20_000;

interface Read { status: number; location: string | null; body: string }

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    assertNotChallenged(body);
    throw new SchemaError(PROVIDER, 'Barid Al-Maghrib returned a lookup reply that is not JSON', { cause });
  }
}

export class BaridAlMaghribTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async get(url: string, accept: Record<string, string>, signal: AbortSignal, timeoutMs: number): Promise<Read> {
    const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
      ...accept, 'Accept-Language': 'fr', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: BARID_AL_MAGHRIB_MAX_BYTES,
      redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE] });
    if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'Barid Al-Maghrib tracking page is unavailable', { status: response.status });
    return { status: response.status, location: response.headers.get('location'), body: decodeText(bytes).replace(/^\uFEFF/, '').trim() };
  }

  /**
   * The detail page, then, when it sends the code back to the search form,
   * the form's own lookup to tell an unknown code from one without history.
   */
  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const deadline = performance.now() + timeoutMs;
    const left = () => Math.max(1, deadline - performance.now());
    const query = `?code=${encodeURIComponent(number)}`;
    const detail = await this.get(`${BARID_AL_MAGHRIB_DETAIL}${query}`, { Accept: 'text/html' }, signal, left());
    if (detail.status === 200) return parseBaridAlMaghrib(detail.body, number);
    const target = detail.location ? new URL(detail.location, BARID_AL_MAGHRIB_DETAIL) : null;
    if (target?.origin !== ORIGIN || target.pathname !== SEARCH_PAGE) {
      throw new TransportError(PROVIDER, 'Barid Al-Maghrib redirected its tracking page', { status: detail.status });
    }
    const lookup = await this.get(`${BARID_AL_MAGHRIB_LOOKUP}?trackingCode=${encodeURIComponent(number)}`, {
      Accept: 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest',
    }, signal, left());
    if (lookup.status !== 200) throw new TransportError(PROVIDER, 'Barid Al-Maghrib redirected its tracking lookup', { status: lookup.status });
    if (!baridAlMaghribSummaryKnows(json(lookup.body), number)) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Barid Al-Maghrib knows the item but did not open its history');
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeBaridAlMaghribNumber(raw);
    // A read that fails to reach the site, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'barid-al-maghrib', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new BaridAlMaghribTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'barid-al-maghrib', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeBaridAlMaghribNumber(number))),
  };
};
