import { DateTime } from 'luxon';
import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { carrierErrorKind, IndeterminateError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { withNetworkRetry } from '../../core/runner/networkRetry.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { getOnlineScanZone, GETONLINE_MAX_BYTES, GetOnlineTracker } from '../skynet-worldwide/getonline.js';
import { DPEX, DPEX_CHINA_TRACKER, normalizeDpexNumber, parseDpexChina, PROVIDER } from './parser.js';

interface Options { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string }
type Answer = { result: CarrierResult } | { error: unknown };

const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 410];

const settle = (read: Promise<CarrierResult>): Promise<Answer> => read.then((result) => ({ result }), (error: unknown) => ({ error }));

/** A scan's wall clock to the minute: as written when it has no zone, else its instant on its location's clock. */
function wallClock(event: CarrierEvent): string {
  if (typeof event.local_time === 'string') return event.local_time.slice(0, 16);
  const zone = event.time ? getOnlineScanZone(event.location ?? '') : null;
  // An instant shown on a zone's clock: no wall clock is read in the zone.
  return zone ? DateTime.fromISO(event.time!).setZone(zone).toFormat("yyyy-MM-dd'T'HH:mm") : (event.time ?? '').slice(0, 16);
}

/**
 * One history from both trackers' answers. Both write a scan with the
 * station's wall clock, so the clocks compare across them. The GETOnline
 * page's history leads, as its clocks can carry a zone, followed by DPEX
 * China's scans from before its first: the documents, the collection and the
 * first legs. DPEX China's history stands alone when it holds a later scan.
 */
function combine(getOnline: CarrierResult | undefined, china: CarrierResult | undefined): CarrierResult | undefined {
  if (!getOnline || !china) return getOnline ?? china;
  const clocks = (getOnline.events ?? []).map(wallClock).sort();
  const theirs = (china.events ?? []).map(wallClock).sort();
  if (!clocks.length || theirs.at(-1)! > clocks.at(-1)!) {
    const country = china.destination_country ?? getOnline.destination_country;
    return country ? { ...china, destination_country: country } : china;
  }
  const earlier = (china.events ?? []).filter((event) => wallClock(event) < clocks[0]!);
  if (!earlier.length) return getOnline;
  const events = [...getOnline.events!, ...earlier];
  const stage = events.find((event) => event.stage);
  return {
    ...getOnline,
    ...(stage ? { status: languageStageStatus(stage.stage as Stage), current_stage: stage.stage, current_stage_source: stage.stage_source } : {}),
    ...(getOnline.destination_country ?? china.destination_country ? { destination_country: getOnline.destination_country ?? china.destination_country } : {}),
    events,
  };
}

/**
 * DPEX's two trackers, asked together: the GETOnline page, which holds the
 * scans of the stations on Frontier Force's platform, and DPEX China's own
 * system, which also holds scans entered by hand, such as the collection and
 * the first legs, and copies in the platform's.
 */
export class DpexTracker {
  private readonly getOnline: GetOnlineTracker;

  constructor(private readonly options: Options = {}) {
    // The lookup records its step; the GETOnline read inside it is not a lookup of its own.
    this.getOnline = new GetOnlineTracker(DPEX, { fetcher: options.fetcher, recorder: NOOP_RECORDER, userAgent: options.userAgent });
  }

  /** DPEX China's page for one number, read once more after a network failure. */
  private async china(number: string, signal: AbortSignal, budgetMs: number): Promise<CarrierResult> {
    const started = performance.now();
    const url = `${DPEX_CHINA_TRACKER}?${new URLSearchParams({ id: number })}`;
    return withNetworkRetry({ signal, remainingMs: () => budgetMs - (performance.now() - started) }, async (timeoutMs) => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'text/html,application/xhtml+xml', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: GETONLINE_MAX_BYTES,
        redirect: 'manual', allowHttpStatuses: [...REDIRECTS, ...GONE], fetcher: this.options.fetcher });
      if (REDIRECTS.includes(response.status) || GONE.includes(response.status)) {
        throw new TransportError(PROVIDER, 'DPEX China moved its trace-and-track page', { status: response.status });
      }
      const html = decodeText(bytes);
      if (!html.trim()) throw new IndeterminateError(PROVIDER, 'DPEX China returned an empty page');
      return parseDpexChina(html, number);
    });
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeDpexNumber(raw);
    return runSteps({ carrier: 'dpex', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const answers = await Promise.all([
        settle(this.getOnline.fetch(number, { signal, budgetMs: remainingMs })),
        settle(this.china(number, signal, remainingMs)),
      ]);
      const [getOnline, china] = answers.map((answer) => ('result' in answer ? answer.result : undefined));
      const result = combine(getOnline, china);
      if (result) return result;
      const errors = answers.map((answer) => ('error' in answer ? answer.error : null));
      // Unknown only when both say so; a tracker that could not answer leaves the lookup open.
      throw errors.find((error) => carrierErrorKind(error) !== 'not_found') ?? errors[0];
    } }]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new DpexTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'dpex', recordsSteps: true, steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => normalizeDpexNumber(number))),
  };
};
