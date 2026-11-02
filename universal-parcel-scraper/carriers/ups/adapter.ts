
import { load } from 'cheerio';
import { DateTime, FixedOffsetZone } from 'luxon';
import makeFetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { carrierErrorKind, ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import { isValidUpsTrackingNumber } from '../../core/detection/ups.js';
import { uspsPackageIdentifier } from '../../core/detection/usps.js';
import type { CarrierEvent, CarrierResult, CarrierStatus } from '../../core/result/index.js';
import { runSteps, singleFlight, takeTurn } from '../../core/runner/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { calendarDay, countryCode, countryTimeZone, firstOccurrence } from '../../core/time/index.js';
import { clean, cleanScalar, decodeText, fetchBounded, parseJsonBytes, TRAWL_TRANSPORT_ALLOWANCE_MS, type TrawlClient } from '../../core/transport/index.js';
import { isRecord, type JsonObject } from '../../core/types.js';
import { UPSApiClient, upsApiCredentials, upsApiNotFound, upsApiNotices, type UPSApiCredentials } from './api.js';
import { isUpsNotice, UPS_PROGRESS_STATUS, UPS_STATUS_TYPE, upsActivityStage, upsBannerStage, upsRecipientAction, upsStatus, upsUncodedScanStage } from './status.js';
import { decodeEntities } from './text.js';

const TRACKING_BASE = 'https://www.ups.com/track';
const STATUS_API = 'https://webapis.ups.com/track/api/Track/GetStatus?loc=en_US';
const TRAWL_PROVIDER = 'TRAWL while fetching UPS';
const MAX_BYTES = 10_000_000;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:147.0) Gecko/20100101 Firefox/147.0';
// The browser's time; with the transport allowance a lookup ends within a minute. Answers
// the page gives come well inside it, and a longer wait only holds up the caller's sync.
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_DIRECT_TIMEOUT_MS = 20_000;
// The official API answers within a second or two. Its step gets at most this, and at most
// half of what is left, so the page can still answer after it.
const API_TIMEOUT_MS = 15_000;
// How long the browser may wait for the page's own status call after the page settles.
const SETTLE_TIMEOUT_MS = 15_000;
// Retain the latest bounded sequence of matching replies.
const MAX_CAPTURED = 20;
// UPS's status call answers HTTP 500 in bursts. During one, the browser's call failed again
// for every lookup that followed within a minute and nearly every one within five, while
// lookups after a longer pause were answered. Akamai's blocks, which keep the browser on its
// interstitial, come in bursts too: 84% of the lookups within five minutes of one were
// blocked, against 3% otherwise. So do pages whose every browser tier fails outright: 90%
// of the lookups within five minutes of one failed, against 13% after an answer. After any
// of them the browser rests that long, and the caller's next source answers meanwhile.
export const STATUS_HOLD_MS = 5 * 60_000;
// Provider strings are short; the rendered page's whole text is not, and the
// identity check reads all of it, so it passes its own limit to `clean`.
const PAGE_TEXT_LIMIT = 2_000_000;

export function upsTrackingUrl(trackingNumber: string): string {
  const url = new URL(TRACKING_BASE);
  url.searchParams.set('loc', 'en_US');
  url.searchParams.set('tracknum', trackingNumber);
  url.searchParams.set('requester', 'ST/trackdetails');
  return url.toString();
}

/**
 * Akamai rejected the session (HTTP 401/403/419, or a page that carries no
 * XSRF token). It stays a distinct class because the adapter reacts to it: the
 * cached session is refreshed once, then dropped, before the browser tier runs.
 */
export class UPSSessionRejected extends ChallengeError {
  constructor(message: string) {
    super('UPS', message);
    this.name = 'UPSSessionRejected';
  }
}

/**
 * UPS's tracking system is down. Its own page reads error 298 or 299 as "the
 * system is temporarily unavailable": an outage, never an answer about the
 * parcel. It is thrown past every fallback, so a rendered page cannot stand in
 * for it.
 */
export class UPSUnavailableError extends IndeterminateError {
  constructor(code: string) {
    super('UPS', `UPS tracking is temporarily unavailable (error ${code})`);
    this.name = 'UPSUnavailableError';
  }
}

/**
 * The browser step, skipped while UPS's status call would likely answer HTTP 500
 * again, or the page fail again: inconclusive, so another source may answer.
 */
export class UPSStatusHeldError extends IndeterminateError {
  constructor(readonly heldMs: number) {
    super('UPS', `UPS's tracking failed in the browser moments ago; the browser waits ${Math.ceil(heldMs / 1_000)} s more`);
    this.name = 'UPSStatusHeldError';
  }
}

/**
 * When the status call last answered HTTP 500, or the page last failed in
 * every browser tier, by browser service. Every tracker in the process that uses the service
 * shares it, as a host's several registries do; a restart forgets it.
 */
const statusFailedAt = new Map<string, number>();

/**
 * Whether the browser service's HTTP 500 says its last browser tier failed,
 * blocked on Akamai's interstitial or with an error, until the tiers or the
 * deadline ran out. An excerpt cut short still shows the status.
 */
function trawlBrowserFailed(error: unknown): boolean {
  if (!(error instanceof UpstreamHttpError) || error.status !== 500) return false;
  const excerpt = error.diagnostics?.body_excerpt ?? '';
  let reply: unknown;
  try { reply = JSON.parse(excerpt); } catch { return /"status"\s*:\s*"(?:blocked|error)"/.test(excerpt); }
  const last: unknown = isRecord(reply) && Array.isArray(reply.timings) ? reply.timings.at(-1) : undefined;
  return isRecord(last) && (last.tier === 2 || last.tier === 3) && (last.status === 'blocked' || last.status === 'error');
}

/** How long the browser service still rests after a 500, or 0. */
function statusHeldMs(trawl: TrawlClient): number {
  const failedAt = statusFailedAt.get(trawl.endpoint.href);
  return failedAt === undefined ? 0 : Math.max(0, failedAt + STATUS_HOLD_MS - Date.now());
}

/** The error codes UPS's page answers with "try again later". */
const OUTAGE_CODES: ReadonlySet<string> = new Set(['298', '299']);

/**
 * What one lookup lends each request. A session outlives the lookup that
 * built it, so it is handed these per request and keeps neither.
 */
interface RequestBounds {
  /** Aborts on the caller's signal or when the lookup budget is spent. */
  signal: AbortSignal;
  /** When the lookup budget is spent, on the `performance.now()` clock. */
  deadline: number;
}

class UPSHttpSession {
  readonly jar = new CookieJar();
  readonly #fetcher: typeof fetch;
  #userAgent = USER_AGENT;

  constructor(readonly timeoutMs: number, fetcher?: typeof fetch) {
    // Resolve the global lazily so a test seam installed after construction
    // still sees the request.
    this.#fetcher = makeFetchCookie(fetcher ?? ((input, init) => fetch(input, init)), this.jar);
  }

  async fetchPage(url: string, bounds: RequestBounds): Promise<string> {
    const result = await this.request(url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        DNT: '1',
        Pragma: 'no-cache',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-GPC': '1',
        'Upgrade-Insecure-Requests': '1',
        'User-Agent': this.#userAgent,
      },
    }, 'UPS tracking page', bounds);
    return decodeText(result);
  }

  async fetchStatus(trackingNumber: string, bounds: RequestBounds): Promise<JsonObject> {
    const token = await this.xsrfToken();
    if (!token) throw new UPSSessionRejected('The UPS session has no XSRF token');
    const clientUrl = upsTrackingUrl(trackingNumber);
    const bytes = await this.request(STATUS_API, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Content-Type': 'application/json',
        DNT: '1',
        Origin: 'https://www.ups.com',
        Referer: clientUrl,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-site',
        'Sec-GPC': '1',
        'User-Agent': this.#userAgent,
        'X-XSRF-TOKEN': token,
      },
      body: JSON.stringify({
        Locale: 'en_US',
        TrackingNumber: [trackingNumber.toLocaleLowerCase('en-US')],
        isBarcodeScanned: false,
        Requester: 'st/trackdetails',
        ClientUrl: clientUrl,
        returnToValue: '',
        AssociatedBcdnNumber: null,
      }),
    }, 'UPS status API', bounds);
    const payload = parseJsonBytes(bytes, 'UPS');
    if (!isRecord(payload)) throw new UPSSessionRejected('UPS returned an invalid tracking response');
    return payload;
  }

  async xsrfToken(): Promise<string> {
    const cookies = await this.jar.getCookies(STATUS_API);
    const value = cookies.find((cookie) => cookie.key === 'X-XSRF-TOKEN-ST')?.value ?? '';
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  private async request(
    url: string,
    init: RequestInit,
    description: string,
    bounds: RequestBounds,
  ): Promise<Uint8Array> {
    let result: Awaited<ReturnType<typeof fetchBounded>>;
    try {
      result = await fetchBounded(url, { ...init, signal: bounds.signal }, {
        provider: description,
        timeoutMs: Math.max(1, Math.floor(Math.min(this.timeoutMs, bounds.deadline - performance.now()))),
        maxBytes: MAX_BYTES,
        redirect: 'follow',
        fetcher: this.#fetcher,
        allowHttpStatuses: [401, 403, 419],
      });
    } catch (error) {
      // A throttle keeps the transport's status and Retry-After and never
      // refreshes the session. Other HTTP failures retain UPS's inconclusive
      // classification: even a 404 says nothing about the shipment.
      if (error instanceof UpstreamHttpError && error.status !== 429) {
        throw new IndeterminateError('UPS', `${description} returned HTTP ${error.status}`);
      }
      throw error;
    }
    if ([401, 403, 419].includes(result.response.status)) {
      throw new UPSSessionRejected(`${description} returned HTTP ${result.response.status}`);
    }
    // Any other rejected status proves nothing about the shipment, so the
    // browser tier is still allowed to answer it.
    if (!result.response.ok) {
      throw new IndeterminateError('UPS', `${description} returned HTTP ${result.response.status}`);
    }
    return result.bytes;
  }
}

/** An answer no other tier or rendered page may replace. */
function isFinalAnswer(error: unknown): boolean {
  return error instanceof InvalidInputError || error instanceof NotFoundError || error instanceof UPSUnavailableError
    || carrierErrorKind(error) === 'rate_limited';
}

/**
 * Whether the page may answer after the official API failed: always, except
 * when the API refused the number or has no record of it. A throttle or an
 * outage of the API says nothing about the page.
 */
function recoversFromApi(error: unknown): boolean {
  return !(error instanceof InvalidInputError || error instanceof NotFoundError);
}

/** Headers from a captured response are case-insensitive, like HTTP headers. */
function capturedHttpError(status: number, headers: Record<string, string>): Error {
  if (status === 404 || status === 410) {
    return new IndeterminateError('UPS', `UPS status API returned HTTP ${status}`);
  }
  if (status === 419) return new ChallengeError('UPS', 'UPS rejected the browser session', { status });
  const retryHeader = Object.entries(headers).find(([key]) => key.toLowerCase() === 'retry-after')?.[1];
  const delay = retryHeader === undefined ? NaN : /^\d+$/.test(retryHeader.trim())
    ? Number(retryHeader) * 1_000 : Date.parse(retryHeader) - Date.now();
  return new UpstreamHttpError('UPS', status, Number.isFinite(delay) ? Math.max(0, delay) : undefined);
}

function withoutIcons(value: string): string {
  return clean(value.replace(/\b(?:check_circle|content_copy|expand_more|check)\b/g, ' '));
}

function notLocated(): CarrierResult {
  return {
    status: 'unknown',
    last_status_text: 'UPS could not locate the shipment',
    last_update: null,
    expected_delivery: null,
    events: [],
  };
}

/**
 * The rendered tracking page, used when no structured answer can be had. It
 * carries the current status and the delivery location block, never a history.
 */
export function parseUPSTrackingHtml(page: string, trackingNumber: string): CarrierResult {
  const $ = load(page);
  $('script, style, noscript').remove();
  const expected = trackingNumber.toUpperCase();
  const visible = clean($('body').text(), PAGE_TEXT_LIMIT).toUpperCase();
  const metaNumbers = $('meta[name]').map((_, element) => {
    const name = clean($(element).attr('name')).toLocaleLowerCase('en-US');
    return ['stapp-tracknum', 'appvars.trk_tracknum'].includes(name)
      ? clean($(element).attr('content')).toUpperCase()
      : '';
  }).get();
  if (!visible.includes(expected) && !metaNumbers.includes(expected)) {
    throw new SchemaError('UPS', 'UPS did not return the requested parcel');
  }
  if (/could not locate|invalid tracking|not valid tracking/i.test(visible)) return notLocated();
  let statusText = withoutIcons(clean($('#stApp_nameKey').last().text()));
  // Only the active milestone: the bar also lists every milestone still ahead,
  // and "Out for Delivery" among those is not the status.
  $('#stApp_shpmtProgress .sr-only').remove();
  const progress = withoutIcons(clean($('#stApp_shpmtProgress .progress-step.active').text()));
  const currentStatus = upsStatus(`${statusText} ${progress}`);
  if (!statusText) statusText = progress || 'Tracking information received';
  // Where a delivered parcel was left, written as the scans' places. The ship-to
  // block names the recipient's town, not where the parcel is, so it never
  // becomes the banner's place.
  const location = pagePlace(clean($('#stApp_deliveredToAddress').last().text()));
  // The banner has no clock, so its event carries none.
  const bannerStage = upsBannerStage(statusText);
  const events: CarrierEvent[] = currentStatus === 'unknown'
    ? []
    : [{ ...(location ? { location } : {}), description: statusText, ...(bannerStage ? { stage: bannerStage } : {}) }];
  return {
    status: currentStatus,
    last_status_text: statusText,
    last_update: null,
    expected_delivery: null,
    // The banner is the status alone, so an enabled provider may still hold the history.
    summary_only: true,
    events,
  };
}

/**
 * A notice keeps the stage of the scan before it, which UPS lists after it
 * (newest first), so the parcel app stores it as no step forward. A notice
 * with no scan before it is left without a stage.
 */
function keepNoticeStages(events: CarrierEvent[]): void {
  let previous: string | undefined;
  for (const event of [...events].reverse()) {
    if (isUpsNotice(event.provider_code)) {
      if (previous) Object.assign(event, { stage: previous, stage_source: 'none' });
    } else if (event.stage) {
      previous = event.stage;
    }
  }
}

/** Stages a parcel reaches only on its delivery leg. */
/** Delivered to an access point, and held there: the scans whose parcel waits at the reply's access point. */
const AT_ACCESS_POINT: ReadonlySet<string> = new Set(['2Q', 'ZP']);
const DELIVERY_LEG: ReadonlySet<string> = new Set(['out_for_delivery', 'failed_attempt', 'ready_for_pickup', 'delivered']);

/**
 * UPS scans a parcel it collects again after its delivery leg, from an access point to deliver it
 * where the receiver asked or to send it back, with its acceptance codes ("Pickup Scan"): that
 * collection is transit, not a second acceptance. Events are newest first.
 */
function laterPickupsInTransit(events: CarrierEvent[]): void {
  let delivering = false;
  for (const event of [...events].reverse()) {
    if (event.stage === 'accepted' && delivering) event.stage = 'in_transit';
    else if (event.stage && DELIVERY_LEG.has(event.stage)) delivering = true;
  }
}

/** A provider string with its HTML entities decoded, then cleaned. */
function text(value: unknown, maxLength?: number): string {
  return clean(typeof value === 'string' ? decodeEntities(value) : value, maxLength);
}

type ScanClock = Pick<CarrierEvent, 'time' | 'local_time' | 'time_zone' | 'time_zone_basis'> & { provider_time_text?: string };

/** UPS's offset of a scan's place, in minutes. */
function statedOffset(stated: string): number | null {
  const offset = /^([+-])(0\d|1[0-4]):([0-5]\d)$/.exec(stated);
  return offset ? (offset[1] === '-' ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3])) : null;
}

/**
 * The zone of a scan's place, from its country's code or English name, when the country keeps one
 * civil time. Spain and Portugal have none here: their islands keep a clock an hour from the
 * mainland's, the offset the mainland keeps in the other season.
 */
function placeZone(country: string): string | null {
  const code = countryCode(country);
  return code && code !== 'ES' && code !== 'PT' ? countryTimeZone(code) : null;
}

/**
 * A scan UPS states on its place's offset for the other season, one the place's zone does not
 * keep at that wall clock but keeps at another time of the year, dated on the place's clock.
 * After the clocks went back, UPS dated deliveries in France on the summer offset: each reached
 * its answer an hour after the instant that offset gives, and the wall clock was the place's.
 * The scan keeps that wall clock, and the instant says its zone is the place's.
 */
function placeClock(wall: string, offset: number, zone: string | null): ScanClock | null {
  if (!zone) return null;
  const readings = DateTime.fromISO(wall, { zone }).getPossibleOffsets();
  if (!readings.length || readings.some((reading) => reading.offset === offset)) return null;
  const year = Number(wall.slice(0, 4));
  const seasons = [1, 7].map((month) => DateTime.utc(year, month, 1).setZone(zone).offset);
  if (seasons[0] === seasons[1] || !seasons.includes(offset)) return null;
  const time = firstOccurrence(DateTime.fromISO(wall, { zone })).toISO({ suppressMilliseconds: true });
  return time ? { time, local_time: wall, time_zone: zone, time_zone_basis: 'place' } : null;
}

/** The UTC pair, `gmtDate` (YYYYMMDD) and `gmtTime` (HH:MM:SS; the API's schema also shows HMMSS), as an ISO wall clock. */
function utcPair(activity: JsonObject): string | null {
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(cleanScalar(activity.gmtDate));
  const time = /^(\d{1,2}):?([0-5]\d):?([0-5]\d)$/.exec(cleanScalar(activity.gmtTime));
  if (!date || !time || Number(time[1]) > 23) return null;
  return `${date[1]}-${date[2]}-${date[3]}T${time[1]!.padStart(2, '0')}:${time[2]}:${time[3]}`;
}

/**
 * A scan's clock. UPS sends the same scan twice: a UTC pair (`gmtDate` /
 * `gmtTime`) and a local pair with a `gmtOffset`. The UTC pair's instant, to
 * the second, is written on that offset when the local pair reads the same
 * minute on it, so the scan keeps its place's clock; otherwise it stays in
 * UTC. A zero offset is written as UTC was, `+00:00`. Without the UTC pair,
 * the local pair and its offset become the time. An offset the place cannot
 * have at that time of year gives way to the place's zone (`placeClock`);
 * otherwise no zone is guessed. A local pair without an offset stays a
 * `local_time`, a scan UPS dates by its day alone, as it does some drop-offs,
 * keeps that day, other text stays as UPS wrote it, and a scan with no clock
 * at all, like some label scans, gets none. The page's reply and the official
 * API write the local pair differently and the rest alike, so one scan gets
 * one time from either.
 */
function scanClock(activity: JsonObject, local: string | null, day: string | null, raw: string, zone: string | null): ScanClock {
  const stated = cleanScalar(activity.gmtOffset);
  const offset = statedOffset(stated);
  const utc = utcPair(activity);
  if (utc) {
    const shown = offset === null ? null : DateTime.fromISO(utc, { zone: 'utc' }).setZone(FixedOffsetZone.instance(offset));
    if (!shown?.isValid || !local || shown.toFormat("yyyy-MM-dd'T'HH:mm") !== local.slice(0, 16)) return { time: `${utc}+00:00` };
    return placeClock(shown.toFormat("yyyy-MM-dd'T'HH:mm:ss"), offset!, zone)
      ?? { time: offset ? shown.toISO({ suppressMilliseconds: true }) : `${utc}+00:00` };
  }
  if (local) {
    if (offset === null) return /^[+-]\d{2}:\d{2}$/.test(stated) ? { time: `${local}${stated}` } : { local_time: local };
    return placeClock(local, offset, zone) ?? { time: `${local}${stated}` };
  }
  if (day) return { local_time: day };
  return raw ? { provider_time_text: raw } : {};
}

/** The clock of a scan in the page's reply, whose local pair reads `08/04/2026` and `9:12 A.M.`, at a place such as `ZUERICH, CH`. */
function activityClock(activity: JsonObject, place: string): ScanClock {
  const localDate = cleanScalar(activity.date);
  const localTime = cleanScalar(activity.time);
  const dateMatch = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(localDate);
  const timeMatch = /^(\d{1,2}):([0-5]\d)\s*([AP])\.?M\.?$/i.exec(localTime);
  const hour = Number(timeMatch?.[1]);
  const local = dateMatch && timeMatch && hour >= 1 && hour <= 12
    ? `${dateMatch[3]}-${dateMatch[1]}-${dateMatch[2]}T${String(hour % 12 + (timeMatch[3]!.toUpperCase() === 'P' ? 12 : 0)).padStart(2, '0')}:${timeMatch[2]}:00`
    : null;
  const day = dateMatch && !localTime ? calendarDay(Number(dateMatch[3]), Number(dateMatch[1]), Number(dateMatch[2])) : null;
  return scanClock(activity, local, day, clean(`${localDate} ${localTime}`), placeZone(place.split(',').at(-1)!.trim()));
}

/** The clock of a scan in the official API's reply, whose local pair reads `20260804` and `091204`. */
function apiActivityClock(activity: JsonObject): ScanClock {
  const localDate = cleanScalar(activity.date);
  const localTime = cleanScalar(activity.time);
  const dateMatch = /^(\d{4})(\d{2})(\d{2})$/.exec(localDate);
  const timeMatch = /^([01]\d|2[0-3])([0-5]\d)([0-5]\d)$/.exec(localTime);
  const day = dateMatch ? calendarDay(Number(dateMatch[1]), Number(dateMatch[2]), Number(dateMatch[3])) : null;
  const local = day && timeMatch ? `${day}T${timeMatch[1]}:${timeMatch[2]}:${timeMatch[3]}` : null;
  const address = isRecord(activity.location) && isRecord(activity.location.address) ? activity.location.address : {};
  return scanClock(activity, local, localTime ? null : day, clean(`${localDate} ${localTime}`),
    placeZone(cleanScalar(address.countryCode || address.country, 8)));
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const DAY_MS = 86_400_000;

/**
 * The scheduled delivery date. UPS sends a month key and a day number but no
 * year, so the year is the one that puts the date within the last week or in
 * the future.
 */
function expectedDelivery(detail: JsonObject, today: Date): string | null {
  if (!isRecord(detail.scheduledDeliveryDateDetail)) return null;
  const value = detail.scheduledDeliveryDateDetail;
  const month = MONTHS[cleanScalar(value.monthCMSKey).split('.').at(-1)?.toLocaleLowerCase('en-US') ?? ''];
  const day = Number(cleanScalar(value.dayNum));
  if (!month || !Number.isInteger(day) || day < 1 || day > 31) return null;
  const year = today.getUTCFullYear();
  const candidate = calendarDay(year, month, day);
  if (!candidate) return null;
  const utcToday = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Date.parse(candidate) < utcToday - 7 * DAY_MS ? calendarDay(year + 1, month, day) : candidate;
}

/** The structured answer of the tracking page's own status API. */
export function parseUPSTrackingResponse(
  payload: unknown,
  trackingNumber: string,
  today = new Date(),
): CarrierResult {
  if (!isRecord(payload)) throw new SchemaError('UPS');
  if (payload.statusCode !== '200' && payload.statusCode !== 200) {
    const code = cleanScalar(payload.statusCode).toUpperCase();
    if (OUTAGE_CODES.has(code)) throw new UPSUnavailableError(code);
    // UPS answers 402 "Invalid Request" for a number whose check digit fails.
    if (cleanScalar(payload.statusCode) === '402' && !isValidUpsTrackingNumber(trackingNumber.toUpperCase())) {
      throw new InvalidInputError('UPS', 'UPS rejected the number: its check digit does not match', { reason: 'wrong_number' });
    }
    throw new IndeterminateError('UPS', clean(payload.statusText) || 'UPS tracking is unavailable');
  }
  if (!Array.isArray(payload.trackDetails) || payload.trackDetails.length === 0) return notLocated();
  const expected = trackingNumber.toUpperCase();
  const named = payload.trackDetails.filter((item) => isRecord(item)
    && cleanScalar(item.trackingNumber ?? item.requestedTrackingNumber).toUpperCase() === expected);
  // One number was asked for: of several details, only the one that names it answers.
  if (payload.trackDetails.length > 1 && named.length !== 1) throw new SchemaError('UPS', 'UPS did not return the requested parcel');
  const detail: unknown = named[0] ?? payload.trackDetails[0];
  if (!isRecord(detail)) throw new SchemaError('UPS');
  // An outage is not about any parcel, whichever number the reply names.
  const errorCode = cleanScalar(detail.errorCode).toUpperCase();
  if (OUTAGE_CODES.has(errorCode)) throw new UPSUnavailableError(errorCode);
  const returned = cleanScalar(detail.trackingNumber ?? detail.requestedTrackingNumber);
  if (returned && returned.toUpperCase() !== expected) {
    throw new SchemaError('UPS', 'UPS did not return the requested parcel');
  }
  const errorText = text(detail.errorText);
  // Error 504 in a successful reply that names the number: UPS has no record of
  // it, expired or not active yet, as its own page reads the code.
  if (returned && errorCode === '504') throw new NotFoundError('UPS');
  if (detail.errorCode || errorText) {
    return { ...notLocated(), last_status_text: errorText || 'UPS could not locate the shipment' };
  }
  const events: CarrierEvent[] = [];
  if (Array.isArray(detail.shipmentProgressActivities)) {
    for (const raw of detail.shipmentProgressActivities) {
      if (!isRecord(raw)) continue;
      const milestone = isRecord(raw.milestoneName) ? text(raw.milestoneName.name) : '';
      let description = text(raw.activityScan) || milestone;
      const additional = text(raw.activityAdditionalDescription);
      if (additional && !description.toLocaleLowerCase('en-US').includes(additional.toLocaleLowerCase('en-US'))) {
        description = clean(`${description} — ${additional}`);
      }
      if (!description) continue;
      const code = cleanScalar(raw.actCode, 8).toUpperCase();
      const stage = code ? upsActivityStage(code) : upsUncodedScanStage(description);
      const action = upsRecipientAction(code);
      events.push({
        ...activityClock(raw, text(raw.location)),
        location: pagePlace(text(raw.location)),
        description,
        ...(/^[A-Z0-9]{1,4}$/.test(code) ? { provider_code: code } : {}),
        ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
        ...(action ? { recipient_action: action } : {}),
      });
    }
  }
  laterPickupsInTransit(events);
  keepNoticeStages(events);
  const newest = events[0];
  // UPS lists the newest scan first. Its code outranks the coarse progress
  // token, which reads Exception for a mere delay. A notice is no scan.
  const decider = events.find((event) => !isUpsNotice(event.provider_code)) ?? newest;
  const stage = decider?.stage as Stage | undefined;
  const currentName = isRecord(detail.currentMilestone) ? text(detail.currentMilestone.name) : '';
  const statusText = decider?.description
    || text(detail.packageStatus ?? detail.simplifiedText)
    || currentName
    || 'Tracking information received';
  const progress = clean(detail.progressBarType).toLocaleLowerCase('en-US');
  const status: CarrierStatus = stage ? languageStageStatus(stage) : (Object.hasOwn(UPS_PROGRESS_STATUS, progress)
    ? UPS_PROGRESS_STATUS[progress]!
    : upsStatus(
      [detail.packageStatus, detail.simplifiedText, currentName, statusText].map((value) => text(value)).join(' '),
      events.length > 0,
    ));
  const delivered = stage ? stage === 'delivered' : status === 'delivered';
  const deliveredAt = delivered ? decider?.time : undefined;
  const country = [detail.shipToAddress, detail.deliveryAddress]
    .map((address) => (isRecord(address) ? cleanScalar(address.country, 8).toUpperCase() : ''))
    .find((code) => /^[A-Z]{2}$/.test(code));
  // Only a parcel the newest scan has at the access point waits there: a reminder to collect a held parcel
  // does not say where it is held, and the reply can name an access point the parcel has left.
  const pickupPoint = stage === 'ready_for_pickup' && AT_ACCESS_POINT.has(clean(decider?.provider_code).toUpperCase())
    ? accessPoint(detail) : '';
  // UPS writes its service names with trademark signs ("UPS Standard&#174;"), which are not part of the name.
  const information = isRecord(detail.additionalInformation) ? detail.additionalInformation.serviceInformation : null;
  const service = isRecord(information) ? clean(text(information.serviceName, 200).replace(/[®™℠]/g, ' '), 80) : '';
  // A parcel UPS hands to the U.S. Postal Service for the last leg (Ground
  // Saver, for one) names its USPS number. Anything that is not a USPS package
  // number is dropped, and a routing barcode keeps only its package number.
  const postal = isRecord(detail.additionalInformation)
    ? uspsPackageIdentifier(cleanScalar(detail.additionalInformation.postalServiceTrackingID))
    : null;
  // Never projected: the ship-to and delivery addresses beyond their country,
  // `receivedBy`, `leftAt`, the proof-of-delivery link, the access point's
  // attention name, hours and coordinates, and `senderShipperNumber`, an
  // account number.
  return {
    status,
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: statusText,
    last_update: newest?.time ?? null,
    expected_delivery: delivered ? null : expectedDelivery(detail, today),
    ...(deliveredAt ? { delivered_at: deliveredAt } : {}),
    ...(pickupPoint ? { pickup_point: pickupPoint } : {}),
    ...(country ? { destination_country: country } : {}),
    ...(service ? { service_name: service } : {}),
    ...(postal ? { delivery_carrier: 'usps', delivery_tracking_number: postal } : {}),
    events,
  };
}

/**
 * The access point, read only while the parcel waits there: its business name,
 * then its street and its town on their own lines when UPS gives both. The
 * attention name is never a fallback: it can name a person.
 */
function accessPoint(detail: JsonObject): string {
  const point = isRecord(detail.upsAccessPoint) ? detail.upsAccessPoint : null;
  const location = point && isRecord(point.location) ? point.location : null;
  const name = location ? text(location.companyName, 200) : '';
  if (!location || !name) return name;
  const street = text(location.streetAddress1, 120);
  const more = [location.streetAddress2, location.streetAddress3].map((line) => text(line, 120)).filter(Boolean).join(', ');
  const city = text(location.city, 80);
  if (!street || !city) return name;
  const postcode = text(location.zipCode, 16);
  // A US state or Canadian province comes before the postcode, after the town.
  const region = text(location.state, 40) || text(location.province, 40);
  const town = region ? `${city}, ${[region, postcode].filter(Boolean).join(' ')}` : [postcode, city].filter(Boolean).join(' ');
  return [name, street, more, town].filter(Boolean).join('\n');
}

const ENGLISH_REGIONS = new Intl.DisplayNames(['en'], { type: 'region' });

/** A town UPS's API writes in capitals, written as its page shows it: "DES MOINES" is "Des Moines". */
function townCase(town: string): string {
  return /\p{Ll}/u.test(town) ? town
    : town.toLocaleLowerCase('en-US').replace(/(^|[\s\-.(/])(\p{L})/gu, (_, before: string, letter: string) => before + letter.toLocaleUpperCase('en-US'));
}

/**
 * A scan's place on the page. A delivery's comes in capitals with codes ("KOELN, DE",
 * "DES MOINES, IA, US"), and is written as the page writes every other scan's. A
 * place without commas is kept: its last word could be a state as well as a country.
 */
function pagePlace(location: string): string {
  const fields = location.split(/\s*,\s*/);
  const code = fields.at(-1)!;
  const country = fields.length > 1 && /^[A-Z]{2}$/.test(code) && !/\p{Ll}/u.test(location) ? ENGLISH_REGIONS.of(code) : undefined;
  return country && country !== code ? [townCase(fields[0]!), ...fields.slice(1, -1), country].join(', ') : location;
}

/**
 * A scan's place in the API's reply, written as the page writes it: the town,
 * the state or province, and the country's English name ("Des Moines, IA,
 * United States", "Koeln, Germany"). The street and postcode are never read.
 */
function apiPlace(location: unknown): string {
  const address = isRecord(location) && isRecord(location.address) ? location.address : null;
  if (!address) return '';
  const code = cleanScalar(address.countryCode || address.country, 8).toUpperCase();
  const country = /^[A-Z]{2}$/.test(code) ? ENGLISH_REGIONS.of(code) ?? code : text(address.country, 60);
  return [townCase(text(address.city, 80)), text(address.stateProvince, 40), country].filter(Boolean).join(', ');
}

/** A YYYYMMDD date of the API's `deliveryDate` list, by type, in this order. */
function apiDeliveryDate(detail: JsonObject, ...types: string[]): string | null {
  const dates = Array.isArray(detail.deliveryDate) ? detail.deliveryDate.filter(isRecord) : [];
  for (const type of types) {
    const match = /^(\d{4})(\d{2})(\d{2})$/.exec(cleanScalar(dates.find((entry) => cleanScalar(entry.type).toUpperCase() === type)?.date));
    const day = match ? calendarDay(Number(match[1]), Number(match[2]), Number(match[3])) : null;
    if (day) return day;
  }
  return null;
}

/**
 * The official Track API's answer (`GET /api/track/v1/details/{number}`), as
 * the same shipment the page's reply makes: the scans with their activity
 * codes, the status, the scheduled day, the service, the destination country
 * and the USPS number of a parcel handed to the post office. The addresses
 * beyond their country, the recipient, signature, photo, proof of delivery,
 * payments and references are never read, and neither is the access point,
 * which the API does not name.
 */
export function parseUPSApiResponse(payload: unknown, trackingNumber: string): CarrierResult {
  const shipments = isRecord(payload) && isRecord(payload.trackResponse) && Array.isArray(payload.trackResponse.shipment)
    ? payload.trackResponse.shipment.filter(isRecord) : null;
  if (!shipments) throw new SchemaError('UPS', 'UPS API returned an invalid tracking response');
  const packages = shipments.flatMap((shipment) => (Array.isArray(shipment.package) ? shipment.package.filter(isRecord) : []));
  if (packages.length === 0) {
    if (upsApiNotFound(upsApiNotices(payload))) throw new NotFoundError('UPS');
    throw new SchemaError('UPS', 'UPS API returned no package');
  }
  const expected = trackingNumber.toUpperCase();
  const named = packages.filter((item) => cleanScalar(item.trackingNumber).toUpperCase() === expected);
  // One number was asked for: of several packages, only the one that names it answers.
  if (packages.length > 1 && named.length !== 1) throw new SchemaError('UPS', 'UPS did not return the requested parcel');
  const detail = named[0] ?? packages[0]!;
  const returned = cleanScalar(detail.trackingNumber).toUpperCase();
  if (returned && returned !== expected) throw new SchemaError('UPS', 'UPS did not return the requested parcel');
  const events: CarrierEvent[] = [];
  for (const raw of Array.isArray(detail.activity) ? detail.activity : []) {
    if (!isRecord(raw)) continue;
    const scanStatus = isRecord(raw.status) ? raw.status : {};
    const description = text(scanStatus.description);
    if (!description) continue;
    const code = cleanScalar(scanStatus.code, 8).toUpperCase();
    const stage = code ? upsActivityStage(code) : upsUncodedScanStage(description);
    const action = upsRecipientAction(code);
    events.push({
      ...apiActivityClock(raw),
      location: apiPlace(raw.location),
      description,
      ...(/^[A-Z0-9]{1,4}$/.test(code) ? { provider_code: code } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
      ...(action ? { recipient_action: action } : {}),
    });
  }
  laterPickupsInTransit(events);
  keepNoticeStages(events);
  // The API lists the newest scan first; its code outranks the status type. A notice is no scan.
  const newest = events[0];
  const decider = events.find((event) => !isUpsNotice(event.provider_code)) ?? newest;
  const stage = decider?.stage as Stage | undefined;
  const current = isRecord(detail.currentStatus) ? detail.currentStatus : {};
  const statusText = decider?.description
    || text(current.description)
    || text(current.simplifiedTextDescription)
    || 'Tracking information received';
  const type = cleanScalar(current.type, 4).toUpperCase();
  const status: CarrierStatus = stage ? languageStageStatus(stage) : (Object.hasOwn(UPS_STATUS_TYPE, type)
    ? UPS_STATUS_TYPE[type]!
    : upsStatus([current.description, current.simplifiedTextDescription, statusText].map((value) => text(value)).join(' '), events.length > 0));
  const delivered = stage ? stage === 'delivered' : status === 'delivered';
  const deliveredAt = delivered ? decider?.time : undefined;
  const addresses = Array.isArray(detail.packageAddress) ? detail.packageAddress.filter(isRecord) : [];
  const destination = addresses.find((entry) => cleanScalar(entry.type).toUpperCase() === 'DESTINATION');
  const country = destination && isRecord(destination.address) ? cleanScalar(destination.address.countryCode, 8).toUpperCase() : '';
  const service = isRecord(detail.service) ? clean(text(detail.service.description, 200).replace(/[®™℠]/g, ' '), 80) : '';
  // A parcel UPS hands to the U.S. Postal Service names its USPS number among the alternate numbers.
  const postal = (Array.isArray(detail.alternateTrackingNumber) ? detail.alternateTrackingNumber.filter(isRecord) : [])
    .filter((entry) => cleanScalar(entry.type).toUpperCase().startsWith('USPS'))
    .map((entry) => uspsPackageIdentifier(cleanScalar(entry.number)))
    .find(Boolean) ?? null;
  return {
    status,
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: statusText,
    last_update: newest?.time ?? null,
    expected_delivery: delivered ? null : apiDeliveryDate(detail, 'RDD', 'SDD'),
    ...(deliveredAt ? { delivered_at: deliveredAt } : {}),
    ...(/^[A-Z]{2}$/.test(country) ? { destination_country: country } : {}),
    ...(service ? { service_name: service } : {}),
    ...(postal ? { delivery_carrier: 'usps', delivery_tracking_number: postal } : {}),
    events,
  };
}

export interface UPSTrackerOptions {
  timeoutMs?: number;
  directTimeoutMs?: number;
  /** The browser service, or null when none is configured. */
  trawl?: TrawlClient | null;
  fetcher?: typeof fetch;
  recorder?: StepRecorder;
  /** The deployment's app on developer.ups.com, or null without one. */
  api?: UPSApiCredentials | null;
}

export class UPSTracker {
  readonly timeoutMs: number;
  readonly directTimeoutMs: number;
  readonly #trawl: TrawlClient | null;
  readonly #api: UPSApiClient | null;
  readonly #fetcher: typeof fetch | undefined;
  readonly #recorder: StepRecorder;
  readonly #serialize = singleFlight();
  #session: UPSHttpSession | null = null;

  constructor(options: UPSTrackerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.directTimeoutMs = Math.max(1_000, Math.min(
      this.timeoutMs,
      options.directTimeoutMs ?? DEFAULT_DIRECT_TIMEOUT_MS,
    ));
    this.#trawl = options.trawl ?? null;
    this.#api = options.api ? new UPSApiClient(options.api, options.fetcher) : null;
    this.#fetcher = options.fetcher;
    this.#recorder = options.recorder ?? NOOP_RECORDER;
  }

  async fetch(trackingNumber: string, context: TrackingContext = {}): Promise<CarrierResult> {
    // A number of another shape is refused before the lookup waits for its turn.
    const number = trackingNumber.toUpperCase();
    if (!/^1Z[A-Z0-9]{16}$/.test(number)) {
      throw new InvalidInputError('UPS', 'UPS tracking numbers must start with 1Z and contain 18 characters');
    }
    // One lookup at a time: the cached session's cookies and XSRF token are
    // shared state and must never be refreshed by two lookups at once.
    return takeTurn(this.#serialize, 'UPS', context, (left) => this.#lookup(number, left));
  }

  async #lookup(number: string, context: TrackingContext): Promise<CarrierResult> {
    const trawl = this.#trawl;
    const api = this.#api;
    // The direct page, kept so it can still be read when no browser service
    // exists and the structured call was refused.
    const page: { html: string | null } = { html: null };
    return runSteps<CarrierResult>({
      // Without a caller's budget the browser tier leaves the service its own time
      // and the request the allowance to bring the answer back.
      carrier: 'ups',
      budgetMs: context.budgetMs ?? (api ? API_TIMEOUT_MS : 0) + this.timeoutMs + (trawl ? TRAWL_TRANSPORT_ALLOWANCE_MS : 0),
      signal: context.signal,
      recorder: this.#recorder,
    }, [
      {
        id: 'api',
        enabled: api !== null,
        run: ({ remainingMs, signal }) => this.#officialResult(api!, number, Math.min(API_TIMEOUT_MS, Math.floor(remainingMs / 2)), signal),
      },
      {
        id: 'direct',
        // Plain HTTP serves only deployments without a browser service. Since
        // 2026-09-10 Akamai holds the status API open until the timeout for
        // every session a browser did not establish, so with a browser the
        // structured answer is read from the page's own call instead.
        enabled: trawl === null,
        recovers: recoversFromApi,
        run: async ({ remainingMs, signal }) => {
          try {
            return await this.#directResult(number, page, { signal, deadline: performance.now() + remainingMs });
          } catch (error) {
            // A caller that cancelled gets its own reason back: no answer from
            // the page already fetched, no challenge report.
            context.signal?.throwIfAborted();
            // UPS refused the number, does not know it or is down; no page or
            // browser can answer it.
            if (isFinalAnswer(error)) throw error;
            if (page.html !== null) {
              try {
                return this.#renderedResult(page.html, number);
              } catch {
                // The direct page was itself a challenge; surface the actionable setup error.
              }
            }
            throw new ChallengeError(
              'UPS',
              'UPS challenged direct tracking; configure FLARESOLVERR_URL for browser fallback',
              { cause: error },
            );
          }
        },
      },
      {
        id: 'trawl',
        enabled: trawl !== null,
        recovers: recoversFromApi,
        run: async ({ remainingMs, signal }) => {
          // The skip is recorded as this step's failure, under its own error type.
          const held = statusHeldMs(trawl!);
          if (held > 0) throw new UPSStatusHeldError(held);
          return this.#trawlResult(trawl!, number, Math.max(1, Math.floor(Math.min(this.timeoutMs, remainingMs))), signal);
        },
      },
    ]);
  }

  /** The cached session, then a fresh one; both talk plain HTTP to the status API. */
  async #directResult(number: string, page: { html: string | null }, bounds: RequestBounds): Promise<CarrierResult> {
    const cached = this.#session;
    if (cached) {
      try {
        return await this.#apiResult(number, cached, bounds);
      } catch (error) {
        if (!(error instanceof UPSSessionRejected)) throw error;
        try {
          await cached.fetchPage(upsTrackingUrl(number), bounds);
          return await this.#apiResult(number, cached, bounds);
        } catch (refreshError) {
          if (!(refreshError instanceof UPSSessionRejected)) throw refreshError;
          this.#session = null;
        }
      }
    }
    const direct = new UPSHttpSession(this.directTimeoutMs, this.#fetcher);
    page.html = await direct.fetchPage(upsTrackingUrl(number), bounds);
    if (!await direct.xsrfToken()) throw new UPSSessionRejected('UPS challenged the direct tracking session');
    const result = await this.#apiResult(number, direct, bounds);
    this.#session = direct;
    return result;
  }

  /**
   * A real browser loads the page and makes the status call itself; the
   * service hands that reply back. The browser's cookies are never replayed
   * over plain HTTP: Akamai accepts the call only from the session it
   * validated in the page. The page the browser rendered is the last resort.
   */
  async #trawlResult(trawl: TrawlClient, number: string, timeoutMs: number, signal: AbortSignal): Promise<CarrierResult> {
    let page;
    try {
      page = await trawl.scrape({
        url: upsTrackingUrl(number),
        skipHttp: true,
        maxTier: 3,
        maxTimeout: timeoutMs,
        captureResponses: [STATUS_API],
        settleTimeout: SETTLE_TIMEOUT_MS,
      }, {
        provider: TRAWL_PROVIDER,
        timeoutMs,
        maxBytes: MAX_BYTES,
        fetcher: this.#fetcher,
        signal,
        captureWindow: 'last',
      });
    } catch (error) {
      if (trawlBrowserFailed(error)) statusFailedAt.set(trawl.endpoint.href, Date.now());
      throw error;
    }
    // The last matching response is authoritative. An earlier success cannot
    // answer after the page's retry was refused or returned invalid data.
    const entry = page.capturedResponses.filter((capture) => capture.url === STATUS_API).slice(-MAX_CAPTURED).at(-1);
    // UPS's 428 verification flow can still leave a valid rendered answer.
    if (entry && entry.status !== 428) {
      if (entry.status === 500) statusFailedAt.set(trawl.endpoint.href, Date.now());
      if (entry.status >= 400) throw capturedHttpError(entry.status, entry.headers);
      if (entry.status !== 200 || entry.truncated || entry.body === null || entry.base64Encoded || entry.error) {
        throw new SchemaError('UPS', 'UPS returned an unreadable status response');
      }
      let payload: unknown;
      try {
        payload = JSON.parse(entry.body);
      } catch {
        throw new SchemaError('UPS', 'UPS returned invalid tracking JSON');
      }
      return this.#structuredResult(number, payload);
    }
    try {
      return this.#renderedResult(page.html, number);
    } catch (error) {
      throw new TransportError('UPS', 'TRAWL did not capture the UPS status response', { cause: error });
    }
  }

  async #apiResult(number: string, session: UPSHttpSession, bounds: RequestBounds): Promise<CarrierResult> {
    return this.#structuredResult(number, await session.fetchStatus(number, bounds));
  }

  async #officialResult(api: UPSApiClient, number: string, timeoutMs: number, signal: AbortSignal): Promise<CarrierResult> {
    const result = parseUPSApiResponse(await api.track(number, signal, Math.max(1, timeoutMs)), number);
    result.tracking_url = upsTrackingUrl(number);
    result.tracking_source = 'official-api-response';
    return result;
  }

  #structuredResult(number: string, payload: unknown): CarrierResult {
    const result = parseUPSTrackingResponse(payload, number);
    result.tracking_url = upsTrackingUrl(number);
    result.tracking_source = 'structured-web-response';
    return result;
  }

  #renderedResult(page: string, number: string): CarrierResult {
    const result = parseUPSTrackingHtml(page, number);
    result.tracking_url = upsTrackingUrl(number);
    result.tracking_source = 'rendered-page';
    return result;
  }
}

export const adapter: AdapterFactory = (environment) => {
  const api = upsApiCredentials(environment.env);
  const tracker = new UPSTracker({
    fetcher: environment.fetcher,
    trawl: environment.trawl,
    recorder: environment.recorder,
    api,
  });
  return {
    id: 'ups', plannedScans: true,
    // `api` is UPS's official Track API and runs only with a deployment's app
    // credentials. `direct` is plain HTTP and runs only without a browser
    // service. `trawl` is the browser, which also reads the page's own status call.
    steps: [...(api ? ['api'] : []), 'direct', 'trawl'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
