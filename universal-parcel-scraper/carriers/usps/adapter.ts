
import { DateTime } from 'luxon';
import { load } from 'cheerio';
import { recognizeFromBrowserLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { isValidS10TrackingNumber } from '../../core/detection/s10.js';
import { uspsPackageIdentifier } from '../../core/detection/usps.js';
import { ChallengeError, IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean, TRAWL_TRANSPORT_ALLOWANCE_MS, type TrawlClient } from '../../core/transport/index.js';
import { STATE_PATTERN, uspsScanZone } from './clock.js';
import { uspsStage, uspsStatus } from './status.js';

/**
 * USPS, through the server-rendered tracking page.
 *
 * The `/tracking/{number}` page carries the verdict and collapsed history
 * in its HTML. The legacy query route can return only the global header,
 * so load the package path directly. The browser handles verification;
 * nothing is replayed over plain HTTP.
 */
const TRACKING_BASE = 'https://tools.usps.com/tracking/';
const OUTAGE = 'https://www.usps.com/root/global/server_responses/anyapp_outage_apology.htm';
const MAX_BYTES = 10_000_000;
// The browser's time for every read; with the transport allowance a lookup ends within a
// minute. Answers the page gives come well inside it.
const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_EVENTS_TO_RETURN = 100;
/** Pages a second browser read within the same budget can complete. */
const RECOVERABLE_PAGES = new Set(['incomplete_page', 'interstitial_page']);

/** A read the verification wrapper sent to the outage page, or one not made while reads pause. */
function outageRedirect(error: unknown): boolean {
  return error instanceof IndeterminateError && error.reason === 'maintenance_page';
}

/**
 * Redirects come in runs: after a lookup whose reads were all redirected, the next lookup's
 * first read loads tracking about one time in ten, against more than four after a read that
 * loaded. So once three reads in a row through one browser service land on the outage page,
 * its reads pause for five minutes and lookups end at once, for enabled providers to answer.
 * The next read after the pause pauses them again if it is redirected too; a loaded page
 * ends the run.
 */
const OUTAGE_RUN = 3;
const OUTAGE_PAUSE_MS = 5 * 60_000;
interface OutageRun { redirects: number; pausedUntil: number }
const outageRuns = new Map<string, OutageRun>();

function outageRun(trawl: TrawlClient): OutageRun {
  const key = trawl.endpoint.href;
  let run = outageRuns.get(key);
  if (!run) outageRuns.set(key, run = { redirects: 0, pausedUntil: 0 });
  return run;
}

function pausedMs(run: OutageRun): number {
  return Math.max(0, run.pausedUntil - Date.now());
}

/** The number as typed, upper case and without the spaces, dots and dashes of a printed label. */
function cleanUSPSNumber(raw: string): string {
  return raw.toLocaleUpperCase('en-US').replace(/[\s.-]/g, '');
}

export function normalizeUSPSNumber(raw: string): string {
  const value = cleanUSPSNumber(raw);
  const pic = uspsPackageIdentifier(value);
  if (pic) return pic;
  // The S10 suffix identifies the issuing country, not the destination.
  // Incoming international mail keeps that number when USPS takes over.
  if (!/^\d{20}$/.test(value) && !/^\d{22}$/.test(value) && !isValidS10TrackingNumber(value)) {
    throw new InvalidInputError('USPS', 'USPS tracking numbers must contain 20 or 22 digits, a checksum-valid IMpb, or a checksum-valid UPU S10 number');
  }
  return value;
}

export function uspsTrackingUrl(trackingNumber: string): string {
  return new URL(normalizeUSPSNumber(trackingNumber), TRACKING_BASE).toString();
}

const MONTHS = '(January|February|March|April|May|June|July|August|September|October|November|December)';
const DATE_PATTERN = new RegExp(`${MONTHS}\\s+\\d{1,2},?\\s+\\d{4}`, 'i');
const TIME_PATTERN = /\d{1,2}:\d{2}(?::\d{2})?\s*[ap]\.?m\.?/i;
// Incoming international mail shows this undated from the origin post's electronic notice
// until USPS scans the item, past the origin post's later scans abroad and sometimes after
// the item arrives, so it cannot stand for the item's status while a scan is dated.
const ORIGIN_POST_NOTICE = /^origin post is preparing shipment\b/i;

function eventTime(dateText: string, timeText: string, location: string): { iso: string; timestamp: number } | null {
  const dateMatch = DATE_PATTERN.exec(dateText);
  const timeMatch = TIME_PATTERN.exec(timeText);
  if (!dateMatch || !timeMatch) return null;
  // Facility-local wall time lives in the event's own state.
  const zone = uspsScanZone(location);
  if (!zone) return null;
  const date = firstOccurrence(DateTime.fromFormat(dateMatch[0], 'MMMM d, yyyy', { locale: 'en-US', zone }));
  const clock = timeMatch[0].replace(/\./g, '').toLowerCase();
  const time = firstOccurrence(DateTime.fromFormat(clock, /:\d{2}:\d{2}/.test(clock) ? 'h:mm:ss a' : 'h:mm a', { locale: 'en-US', zone }));
  if (!date.isValid || !time.isValid) return null;
  const at = date.set({ hour: time.hour, minute: time.minute, second: time.second });
  const iso = at.toISO({ suppressMilliseconds: true });
  return iso ? { iso, timestamp: at.toMillis() } : null;
}

/** A delivery estimate reduced to its calendar day, written "March 17, 2025" or "17 March 2025". */
function expectedDelivery(text: string): string | null {
  const match = /(?:expected|scheduled|anticipated)\s+delivery.*?(?:([A-Z][a-z]+)\s+(\d{1,2}),?\s+(\d{4})|(\d{1,2})\s+([A-Z][a-z]+)\s+(\d{4}))/is.exec(text);
  if (!match) return null;
  const [month, date, year] = match[1] ? [match[1], match[2], match[3]] : [match[5], match[4], match[6]];
  const day = DateTime.fromFormat(`${month} ${date} ${year}`, 'MMMM d yyyy', { locale: 'en-US', zone: 'utc' });
  return day.isValid ? day.toISODate() : null;
}

function notLocated(): CarrierResult {
  return {
    status: 'unknown',
    last_status_text: 'USPS could not locate the shipment',
    last_update: null,
    expected_delivery: null,
    events: [],
  };
}

interface ParsedRow {
  event: CarrierEvent;
  timestamp: number;
  index: number;
}

/** One history row, read by content pattern: a US date, a clock time, a
 * city/state location, and the longest remaining cell as the description. */
function parseRow(cells: string[], index: number): ParsedRow | null {
  const texts = cells.map((cell) => clean(cell, 500)).filter(Boolean);
  if (texts.length < 2) return null;
  const dateText = texts.find((text) => DATE_PATTERN.test(text)) ?? '';
  const timeText = texts.find((text) => TIME_PATTERN.test(text)) ?? '';
  // The description cell can echo the location; the location cell is the
  // shortest state-bearing one that carries no date.
  const location = texts
    .filter((text) => STATE_PATTERN.test(text) && !DATE_PATTERN.test(text))
    .sort((left, right) => left.length - right.length)[0] ?? '';
  const description = texts
    .filter((text) => text !== dateText && text !== timeText && text !== location)
    .sort((left, right) => right.length - left.length)[0] ?? '';
  if (!description) return null;
  const at = eventTime(dateText, timeText, location);
  const stage = uspsStage(description) ?? undefined;
  const rawTime = clean(dateText === timeText ? dateText : `${dateText} ${timeText}`, 64);
  return {
    event: {
      ...(at ? { time: at.iso } : rawTime ? { time: rawTime } : {}),
      ...(location ? { location: location.slice(0, 250) } : {}),
      // A delivered line may name who signed; the event keeps the fact, not the name.
      description: stage === 'delivered' ? 'Delivered' : description,
      ...(stage ? { stage } : {}),
    },
    timestamp: at?.timestamp ?? Number.NEGATIVE_INFINITY,
    index,
  };
}

/** Current USPS markup includes collapsed scans in the DOM, without a table.
 * Undated progress steps and the history-expansion control are not scans. */
function parseTimelineRow(description: string, dateText: string, location: string): CarrierEvent | null {
  if (!description || !DATE_PATTERN.test(dateText)) return null;
  const stage = uspsStage(description) ?? undefined;
  const at = eventTime(dateText, dateText, location);
  const date = DATE_PATTERN.exec(dateText)?.[0];
  const time = TIME_PATTERN.exec(dateText)?.[0];
  // UTC is only a parsing frame here. An unresolved location gets an offset-free
  // local_time, never a made-up UTC scan or another facility's timezone. A step
  // USPS dates by its day alone, as it does pre-shipment info, keeps that day.
  const local = date && time ? DateTime.fromFormat(
    `${date.replace(/,\s*/, ' ')} ${time.replace(/\./g, '').replace(/\s*([ap])m/i, ' $1m')}`,
    time.split(':').length === 3 ? 'MMMM d yyyy h:mm:ss a' : 'MMMM d yyyy h:mm a',
    { locale: 'en-US', zone: 'UTC' },
  ) : null;
  const day = date && !time ? DateTime.fromFormat(date.replace(/,\s*/, ' '), 'MMMM d yyyy', { locale: 'en-US', zone: 'UTC' }) : null;
  const wall = local?.isValid ? local.toFormat("yyyy-MM-dd'T'HH:mm:ss") : day?.isValid ? day.toISODate() : null;
  return {
    ...(at ? { time: at.iso } : wall ? { local_time: wall } : { raw_time: dateText }),
    ...(location ? { location: location.slice(0, 250) } : {}),
    description: stage === 'delivered' ? 'Delivered' : description,
    ...(stage ? { stage } : {}),
  };
}

/**
 * A shipping partner's parcel reaches USPS with an acceptance scan after the
 * partner has already moved it. That handoff is transit, not a second acceptance.
 * Events are newest first.
 */
function handoffsInTransit(events: CarrierEvent[]): CarrierEvent[] {
  const result = [...events];
  let moved = false;
  for (let index = result.length - 1; index >= 0; index--) {
    const event = result[index]!;
    if (event.stage === 'accepted' && moved) result[index] = { ...event, stage: 'in_transit' };
    else if (event.stage === 'in_transit' || event.stage === 'customs') moved = true;
  }
  return result;
}

/** The server-rendered tracking page. */
export function parseUSPSTrackingHtml(page: string, trackingNumber: string): CarrierResult {
  const number = normalizeUSPSNumber(trackingNumber);
  const $ = load(page);
  const inlineScript = $('body script:not([src])').length > 0;
  $('script, style, noscript').remove();
  if ($('.track-bar-container').length === 0) {
    const emptyBody = !clean($('body').text()) && $('body').children().length === 0;
    // A completed USPS header without the tracking application, or the
    // tracking page's head captured before its body, is not a missing
    // shipment. A second browser read can recover this partial page.
    if (/^USPS Tracking/.test($('title').text()) && ($('.Widgets_Container #g-navigation').length || emptyBody)) {
      throw new ChallengeError('USPS', 'USPS returned an incomplete tracking page', { reason: 'incomplete_page' });
    }
    // A blank, untitled page holding only the bot check's script is captured
    // before that script reloads into the tracking page. A second read passes.
    if (inlineScript && !clean($('title').text()) && emptyBody) {
      throw new ChallengeError('USPS', 'USPS returned its verification interstitial', { reason: 'interstitial_page' });
    }
    throw new ChallengeError('USPS', 'USPS challenged the browser tracking session');
  }
  const echoed = clean($('#trackingNum').first().text()).toLocaleUpperCase('en-US');
  if (echoed !== number) {
    throw new SchemaError('USPS', 'USPS did not return the requested parcel');
  }
  // The page reuses .banner-header for an upsell banner and for the headings of
  // the estimate's tooltips; only the verdict wrapper's own header is the verdict.
  const banner = clean($('.latest-update-banner-wrapper .banner-header').filter((_, header) => !$(header).closest('.speech_bubble').length)
    .first().text());
  // The estimate's heading, then its weekday, date, month and year and time in elements
  // of their own: "Expected Delivery by: Wednesday 17 March 2025 by 9:00pm".
  const eta = $('.expected_delivery').first().clone();
  eta.find('.hint').remove();
  const estimate = clean(eta.text(), 500);
  if (/tracking not available/i.test(banner)) return notLocated();
  const current = $('.current-tracking-status-wrapper .current-step').first();
  const statusArea = clean(current.find('.tb-status-detail').first().text()
    || current.find('.tb-status').first().text()
    || $('.current-tracking-status-wrapper').first().text(), 5_000);
  const timeline: CarrierEvent[] = [];
  $('.current-tracking-status-wrapper .tb-step').each((_, row) => {
    const parsed = parseTimelineRow(
      clean($(row).find('.tb-status-detail').first().text(), 500),
      clean($(row).find('.tb-date').first().text(), 100),
      clean($(row).find('.tb-location').first().text(), 250),
    );
    if (parsed) timeline.push(parsed);
  });
  const rows: ParsedRow[] = [];
  $('.tracking_history_container tr').each((index, row) => {
    const cells = $(row).find('td').map((_, cell) => $(cell).text()).get();
    if (cells.length === 0) return;
    const parsed = parseRow(cells, index);
    if (parsed) rows.push(parsed);
  });
  rows.sort((left, right) => right.timestamp - left.timestamp || left.index - right.index);
  // The current timeline is newest-first. Keep its order even when some scans
  // have no resolvable timezone; sorting those behind dated scans loses meaning.
  const events = handoffsInTransit(timeline.length ? timeline.slice(0, MAX_EVENTS_TO_RETURN)
    : rows.slice(0, MAX_EVENTS_TO_RETURN).map(({ event }) => event));
  const summary = statusArea || banner;
  const statusText = (ORIGIN_POST_NOTICE.test(summary) ? events[0]?.description : undefined) || summary
    || events[0]?.description || 'Tracking information received';
  const reported = uspsStage(`${statusText} ${banner}`)
    ?? events.map((event) => event.stage).find((value): value is NonNullable<typeof value> => value !== undefined);
  const stage = reported === 'accepted' && events.some((event) => event.stage === 'in_transit') ? 'in_transit' : reported;
  const status = uspsStatus(`${statusText} ${banner}`, events.length > 0);
  const delivered = stage === 'delivered';
  return {
    status,
    ...(stage ? { current_stage: stage } : {}),
    last_status_text: delivered ? 'Delivered' : statusText,
    last_update: events[0]?.time || null,
    ...(events[0]?.local_time ? { last_update_local: events[0].local_time } : {}),
    expected_delivery: delivered ? null : expectedDelivery(`${statusArea} ${banner}`) ?? expectedDelivery(estimate),
    events,
  };
}

export interface USPSTrackerOptions {
  timeoutMs?: number;
  /** The browser service, or null when none is configured. */
  trawl?: TrawlClient | null;
  fetcher?: typeof fetch;
  recorder?: StepRecorder;
}

export class USPSTracker {
  readonly timeoutMs: number;
  readonly #trawl: TrawlClient | null;
  readonly #fetcher: typeof fetch | undefined;
  readonly #recorder: StepRecorder;

  constructor(options: USPSTrackerOptions = {}) {
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
      throw new TypeError('USPS timeout must be positive');
    }
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#trawl = options.trawl ?? null;
    this.#fetcher = options.fetcher;
    this.#recorder = options.recorder ?? NOOP_RECORDER;
  }

  async fetch(trackingNumber: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeUSPSNumber(trackingNumber);
    // Akamai refuses every non-browser client, so a direct attempt only burns
    // time. There is one step, and it is the browser.
    const trawl = this.#trawl;
    if (!trawl) {
      throw new ChallengeError(
        'USPS',
        'USPS challenged direct tracking; configure FLARESOLVERR_URL for browser fallback',
      );
    }
    const result = await runSteps<CarrierResult>({
      // Without a caller's budget the lookup leaves the service its own time and
      // the request the allowance to bring the answer back.
      carrier: 'usps', budgetMs: context.budgetMs ?? this.timeoutMs + TRAWL_TRANSPORT_ALLOWANCE_MS, signal: context.signal,
      recorder: this.#recorder,
    }, [
      { id: 'trawl', run: ({ remainingMs, signal }) => this.#trawlResult(trawl, number, Math.max(1, Math.floor(Math.min(this.timeoutMs, remainingMs))), signal) },
      // A read after a redirect loads tracking about one time in three; one after two, one in ten.
      { id: 'trawl', recovers: error => (error instanceof ChallengeError && RECOVERABLE_PAGES.has(error.reason ?? ''))
        || (outageRedirect(error) && pausedMs(outageRun(trawl)) === 0),
        run: ({ remainingMs, signal }) => this.#trawlResult(trawl, number, Math.max(1, Math.floor(Math.min(this.timeoutMs, remainingMs))), signal) },
      // A second read stays on the interstitial about as often as a first one, so
      // a third read passes as often as the second.
      { id: 'trawl', recovers: error => error instanceof ChallengeError && error.reason === 'interstitial_page',
        run: ({ remainingMs, signal }) => this.#trawlResult(trawl, number, Math.max(1, Math.floor(Math.min(this.timeoutMs, remainingMs))), signal) },
    ]);
    // A typed routing barcode opens with the recipient's ZIP code. The package
    // identifier after it is the number USPS tracks, so consumers can keep that.
    return cleanUSPSNumber(trackingNumber) !== number ? { ...result, canonical_tracking_number: number } : result;
  }

  /** Read the browser's rendered page without replaying its session. An
   * unresolved challenge remains an error so universal fallback can run. */
  async #trawlResult(trawl: TrawlClient, number: string, timeoutMs: number, signal: AbortSignal): Promise<CarrierResult> {
    const run = outageRun(trawl);
    const waitMs = pausedMs(run);
    if (waitMs > 0) {
      throw new IndeterminateError('USPS', 'USPS sent the last lookups to its service outage page; no read until the pause ends',
        { reason: 'maintenance_page', retryAfterMs: waitMs });
    }
    const page = await trawl.scrape({
      url: uspsTrackingUrl(number),
      skipHttp: true,
      maxTier: 3,
      maxTimeout: timeoutMs,
      // The verification page can become idle before it reloads into tracking.
      contentWaitForSelector: '#trackingNum',
      captureResponses: [uspsTrackingUrl(number)],
    }, {
      provider: 'TRAWL while fetching USPS',
      timeoutMs,
      maxBytes: MAX_BYTES,
      fetcher: this.#fetcher,
      signal,
    });
    let result: CarrierResult;
    try { result = parseUSPSTrackingHtml(page.html, number); }
    catch (error) {
      // Prefer a complete matching page if it arrived. Only the exact tracking
      // request's observed redirect proves an outage behind a blank wrapper.
      if (error instanceof ChallengeError && page.capturedResponses.some(response =>
        response.url === uspsTrackingUrl(number) && response.trackingNumberSubmitted === number
        && response.status === 302 && response.headers.location === OUTAGE && !response.error
        && !response.truncated && !response.base64Encoded)) {
        if (++run.redirects >= OUTAGE_RUN) run.pausedUntil = Math.max(run.pausedUntil, Date.now() + OUTAGE_PAUSE_MS);
        // This lookup was redirected; it does not prove every USPS lookup is down.
        throw new IndeterminateError('USPS', 'USPS sent the lookup to its service outage page', { reason: 'maintenance_page' });
      }
      // A page that loaded, even without the parcel or with another one, ends a run of redirects.
      if (!(error instanceof ChallengeError)) run.redirects = 0;
      throw error;
    }
    run.redirects = 0;
    result.tracking_url = uspsTrackingUrl(number);
    result.tracking_source = 'rendered-page';
    return result;
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new USPSTracker({
    fetcher: environment.fetcher,
    trawl: environment.trawl,
    recorder: environment.recorder,
  });
  return {
    id: 'usps', recordsSteps: true, plannedScans: true,
    // Akamai refuses every non-browser client, so there is no direct tier.
    steps: ['trawl'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognizeWithBrowser: (number, context) => recognizeFromBrowserLookup(() => tracker.fetch(number, context)),
  };
};
