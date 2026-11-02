import { load, type CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { returnedTrackingNumber } from '../../core/detection/returned.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { lastMovement } from '../../core/result/pickup.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime, firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { isMagyarPostaSettlement, magyarPostaStage } from './status.js';

export const PROVIDER = 'Magyar Posta';
// A result page for one item is a few dozen kilobytes once its scripts are removed.
export const MAGYAR_POSTA_MAX_BYTES = 1_000_000;

const MAX_ROWS = 300;
// The heading of the tracker's result section, in Hungarian, the language the adapter asks for.
const RESULTS = 'Eredmények';
// The notice for a number without data: "the system found no data for the item".
const NOT_FOUND = 'A megadott küldeményre vonatkozóan a rendszer sajnos nem talált adatot';
const SERVICE = 'Küldemény típusa';
const BLOCKED = /<title>\s*(?:Request Rejected|Access Denied)|requested URL was rejected/i;
// "2026. 01. 13. 9:04": a wall clock without an offset.
const STAMP = /^(\d{4})\. (\d{2})\. (\d{2})\. (\d{1,2}):(\d{2})$/;
// The icon of a row or item: its tab (parcel, letter, other), then the category of the scan.
const CATEGORY = /^fig_[123]([1-5])$/;
// The app's instants: UTC, with microseconds.
const APP_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const HOME = 'Europe/Budapest';
// A row more than a few minutes after the lookup is a plan, not a scan: a dispatch's next leg
// is listed at its planned time a day ahead, and an hour's leeway showed it before it was due.
const CLOCK_SKEW_MS = 5 * 60_000;
/** The app names each scan's category, the tracker's icons 1 to 5. */
const APP_CATEGORIES: ReadonlyMap<string, string> = new Map([
  ['felvétel', '1'], ['feldolgozás', '2'], ['szállítás', '3'], ['kézbesítés', '4'], ['kézbesített', '5'],
]);

type Selection = ReturnType<CheerioAPI>;

/**
 * The tracker takes S10 item codes, Magyar Posta's domestic numbers and the
 * barcodes other networks hand over: letters and digits, with at least one digit.
 */
export function normalizeMagyarPostaNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (/^(?=[A-Z]*\d)[A-Z0-9]{8,30}$/.test(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Magyar Posta tracks letters and digits, 8 to 30 of them');
}

/** The public page, which frames the tracker and fills the number into its search. */
export function magyarPostaTrackingUrl(raw: string): string {
  return `https://www.posta.hu/nyomkovetes/nyitooldal?searchvalue=${normalizeMagyarPostaNumber(raw)}`;
}

function wallClock(stamp: string): string | null {
  const match = STAMP.exec(stamp);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
  // UTC only checks the calendar fields. No offset is assigned.
  const parsed = DateTime.fromObject({ year, month, day, hour, minute }, { zone: 'UTC' });
  return parsed.isValid ? parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") : null;
}

/** "Facility|Town" as "Facility, Town". */
function place(raw: string): string {
  const [name = '', town = '', ...rest] = raw.split('|').map(part => clean(part, 200));
  if (rest.length) return '';
  return name && town && name !== town ? `${name}, ${town}` : name || town;
}

function category($: CheerioAPI, node: Selection): string | undefined {
  const icons = node.children('div.status_ikon').children('div');
  if (icons.length !== 1) return undefined;
  return CATEGORY.exec(clean($(icons[0]).attr('class'), 20))?.[1];
}

/** The wording of a scan, without the line under it that names who took the item. */
function wording(cell: Selection): string {
  const copy = cell.clone();
  copy.find('.data_sikertelen_atv').remove();
  return clean(copy.text(), 300);
}

/**
 * The tracker's Hungarian result page for one number: the item's current
 * status, the details of a parcel and its log, oldest first, each scan with
 * its category, wording, clock and mostly a facility. A number without data
 * comes back with a notice instead.
 */
export function parseMagyarPosta(html: string, raw: string, readAt = Date.now()): CarrierResult {
  const number = normalizeMagyarPostaNumber(raw);
  const $ = load(html);
  const sections = $('div.result_section');
  if (sections.length !== 1) {
    if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Magyar Posta answered with a block page');
    throw new SchemaError(PROVIDER, 'Magyar Posta did not return a search result');
  }
  const section = sections.first();
  if (clean(section.children('h2').text(), 40) !== RESULTS) throw new SchemaError(PROVIDER, 'Magyar Posta did not answer in Hungarian');
  // The search the page answers, which is one number.
  const searched = $('input#Ids');
  if (searched.length !== 1 || returnedTrackingNumber(searched.attr('value')) !== number) {
    throw new SchemaError(PROVIDER, 'Magyar Posta answered for a different search');
  }

  const items = $('div.result_item.closed');
  if (!items.length) {
    const notices = section.find('div.result_error');
    if (notices.length === 1 && returnedTrackingNumber(notices.find('b').text()) === number
      && clean(notices.find('span').first().text(), 200) === NOT_FOUND) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Magyar Posta returned neither an item nor its not-found notice');
  }
  // Letters carry a placeholder in data-id, so the number is read from the item's first column.
  if (items.length !== 1 || returnedTrackingNumber(items.children('div.data_1').text()) !== number) {
    throw new SchemaError(PROVIDER, 'Magyar Posta returned a different or ambiguous item');
  }
  const item = items.first();
  const opened = item.nextAll('div.result_item.opened').first();
  if (opened.length !== 1 || returnedTrackingNumber(opened.children('div.data1').text()) !== number) {
    throw new SchemaError(PROVIDER, 'Magyar Posta returned an item without its log');
  }

  const rows = opened.find('div.more_details_item');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Magyar Posta returned an invalid item log');
  const scans: { event: CarrierEvent; index: number }[] = [];
  const seen = new Set<string>();
  rows.each((index, node) => {
    const row = $(node);
    const line = row.children('div.line_container');
    const code = category($, row);
    const time = wallClock(clean(line.children('div.data_more_1').text(), 40));
    const description = wording(line.children('div.data_more_3'));
    if (!code || !time || !description) throw new SchemaError(PROVIDER, 'Magyar Posta returned a scan without a category, clock or wording');
    if (isMagyarPostaSettlement(description)) return;
    if (firstOccurrence(DateTime.fromISO(time, { zone: HOME })).toMillis() > readAt + CLOCK_SKEW_MS) return;
    const location = place(line.children('div.data_more_4').text());
    const event: CarrierEvent = { local_time: time, description, ...(location ? { location } : {}), provider_code: code };
    // A delivery can repeat a scan with the same clock, place and wording.
    const identity = JSON.stringify(event);
    if (seen.has(identity)) return;
    seen.add(identity);
    scans.push({ event, index });
  });
  // The log is oldest first. Newest first; on equal clocks, the later row first.
  scans.sort((left, right) => right.event.local_time! > left.event.local_time! ? 1
    : right.event.local_time! < left.event.local_time! ? -1 : right.index - left.index);
  const events = withoutPlacelessTwins(scans, (scan) => Date.parse(`${scan.event.local_time!}Z`)).map(({ event }) => event);
  stageScans(events);

  const current = clean(item.children('div.data_2').text(), 300);
  const latest = events[0];
  if (!latest) {
    // An item the tracker knows by its current status alone.
    const time = wallClock(clean(item.children('div.data_3').text(), 40));
    const stage = current ? magyarPostaStage(category($, item) ?? null, current) : undefined;
    if (!current || !time) throw new IndeterminateError(PROVIDER, 'Magyar Posta returned an item without a status');
    return { status: stage ? languageStageStatus(stage) : 'unknown', ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
      last_status_text: current, last_update: null, last_update_local: time, expected_delivery: null, summary_only: true, events: [] };
  }
  // A parcel's details name its service; letters have none.
  const service = opened.find('div.details_item').filter((_, node) =>
    clean($(node).children('div.details_label').text(), 60).replace(/\s*:$/, '') === SERVICE).children('div.details_data');
  return history(events, current, service.length === 1 ? clean(service.text(), 100) : '', { last_update: null, last_update_local: latest.local_time! });
}

/**
 * The scans without a placeless copy of one the log also lists with its place: the same
 * category and wording under a minute apart. The log can list a scan twice, a second apart,
 * the second time without the office the item waits at.
 */
function withoutPlacelessTwins<T extends { event: CarrierEvent }>(scans: readonly T[], at: (scan: T) => number): T[] {
  return scans.filter((scan) => scan.event.location || !scans.some((other) => other.event.location
    && other.event.provider_code === scan.event.provider_code && other.event.description === scan.event.description
    && Math.abs(at(other) - at(scan)) < 60_000));
}

/** Stages scans, newest first. Oldest first: once the item is going back, a delivery reaches its sender. */
function stageScans(events: CarrierEvent[]): void {
  let returning = false;
  for (const event of [...events].reverse()) {
    let stage = magyarPostaStage(event.provider_code ?? null, event.description!);
    if (!stage) continue;
    if (stage === 'delivered' && returning) stage = 'returned';
    if (stage === 'returned') returning = true;
    Object.assign(event, { stage, stage_source: 'carrier_map' });
  }
}

/** The result for staged scans, newest first, with the item's current status and service. */
function history(events: CarrierEvent[], current: string, serviceName: string,
  clock: Partial<Pick<CarrierResult, 'last_update' | 'last_update_local'>>): CarrierResult {
  const latest = events[0]!;
  const staged = events.find(event => event.stage);
  const stage = staged?.stage as Stage | undefined;
  // The office or locker an item waits at is its pickup point. A delivered
  // item was collected there when it waited there last before the delivery.
  const earlier = events.slice(1);
  const waiting = latest.stage === 'ready_for_pickup' ? latest
    : latest.stage === 'delivered' && lastMovement(earlier) === 'ready_for_pickup'
      ? earlier.find(event => event.stage === 'ready_for_pickup') : undefined;
  const point = waiting?.location ?? '';
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: current || latest.description!,
    ...clock,
    expected_delivery: null,
    ...(serviceName ? { service_name: serviceName } : {}),
    ...(point ? { pickup_point: point } : {}),
    ...(events.length > 100 ? { history_truncated: true } : {}),
    events: events.slice(0, 100),
  };
}

/**
 * Why an addition's reply holds no item for the number, naming no number: an
 * empty list, the package under its shipment's number, which a package number
 * begins with, or other numbers. No such reply has been seen whole.
 */
export function magyarPostaAppMiss(payload: unknown, raw: string): string {
  const number = normalizeMagyarPostaNumber(raw);
  const items = isRecord(payload) && Array.isArray(payload.data) ? payload.data as unknown[] : [];
  if (!items.length) return 'Magyar Posta\'s app added the number but listed no item';
  const shipment = number.length === 26 ? number.slice(0, 13) : '';
  if (shipment && items.some(item => isRecord(item) && returnedTrackingNumber(item.package_id) === shipment)) {
    return 'Magyar Posta\'s app listed the package under its shipment\'s number';
  }
  return 'Magyar Posta\'s app added the number without returning it';
}

/**
 * The Posta app's guest reply: for each item added to an application id, its
 * scans with UTC instants and category names, the same wording as the
 * tracker, its current state and service. Null when the reply holds no item
 * for the number, which is how the app's list answers a number it does not hold.
 */
export function parseMagyarPostaApp(payload: unknown, raw: string, readAt = Date.now()): CarrierResult | null {
  const number = normalizeMagyarPostaNumber(raw);
  if (!isRecord(payload) || !Array.isArray(payload.data)) throw new SchemaError(PROVIDER, 'Magyar Posta app returned an invalid reply');
  const items = (payload.data as unknown[]).filter(item => isRecord(item) && returnedTrackingNumber(item.package_id) === number);
  if (!items.length) return null;
  const [item] = items;
  if (items.length > 1 || !isRecord(item) || !Array.isArray(item.events) || item.events.length > MAX_ROWS) {
    throw new SchemaError(PROVIDER, 'Magyar Posta app returned an ambiguous or invalid item');
  }
  const scans: { event: CarrierEvent; timestamp: number; index: number }[] = [];
  const seen = new Set<string>();
  item.events.forEach((row, index) => {
    const stamp = isRecord(row) ? clean(row.date, 40) : '';
    const time = APP_STAMP.test(stamp) ? explicitOffsetTime(stamp) : null;
    const description = isRecord(row) ? clean(row.message, 300) || clean(row.alias, 300) : '';
    if (!isRecord(row) || !time || !description) throw new SchemaError(PROVIDER, 'Magyar Posta app returned a scan without a clock or wording');
    if (isMagyarPostaSettlement(description)) return;
    // A dispatch from abroad can carry the planned time of its next leg. It is held back until then.
    if (time.timestamp > readAt + CLOCK_SKEW_MS) return;
    const code = APP_CATEGORIES.get(clean(row.status, 40).toLowerCase());
    const location = place(clean(row.location, 400));
    const event: CarrierEvent = { time: time.iso, description, ...(location ? { location } : {}), ...(code ? { provider_code: code } : {}) };
    // A delivery can repeat a scan with the same clock, place and wording.
    const identity = JSON.stringify(event);
    if (seen.has(identity)) return;
    seen.add(identity);
    scans.push({ event, timestamp: time.timestamp, index });
  });
  // Newest first; on equal clocks, the later row first.
  scans.sort((left, right) => right.timestamp - left.timestamp || right.index - left.index);
  const events = withoutPlacelessTwins(scans, (scan) => scan.timestamp).map(({ event }) => event);
  stageScans(events);

  const details = isRecord(item.delivery_info) ? item.delivery_info : {};
  const current = clean(details.text, 300) || clean(details.alias, 300);
  const service = isRecord(item.package_details) ? clean(item.package_details.consignment_title, 100) : '';
  if (!events.length) {
    // An item the app knows by its current state alone.
    const code = typeof item.current_status === 'number' ? String(item.current_status) : null;
    const stage = current ? magyarPostaStage(code, current) : undefined;
    if (!current) throw new IndeterminateError(PROVIDER, 'Magyar Posta app returned an item without a status');
    return { status: stage ? languageStageStatus(stage) : 'unknown', ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
      last_status_text: current, last_update: null, expected_delivery: null, ...(service ? { service_name: service } : {}), summary_only: true, events: [] };
  }
  return history(events, current, service, { last_update: events[0]!.time! });
}
