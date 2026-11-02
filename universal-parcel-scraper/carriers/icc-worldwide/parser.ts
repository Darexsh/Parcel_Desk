import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { calendarDay, firstOccurrence } from '../../core/time/index.js';
import { clean, escapeRegExp } from '../../core/transport/index.js';
import { iccWorldwideStage } from './status.js';

export const PROVIDER = 'ICC Worldwide';
// The page for an unknown number is about fifteen kilobytes, most of it the site around the tracking.
export const ICC_WORLDWIDE_MAX_BYTES = 512 * 1024;
// The page says its times are local to the service area that recorded the checkpoint.
const INDIA_ZONE = 'Asia/Kolkata';

// An air waybill: a plain digit run. The public one has eleven digits.
const NUMBER = /^\d{7,12}$/;
const LABEL = /^Tracking \/ Airwaybill Number\s*:\s*/i;
// The summary's notice for a number the tracker holds no shipment under; the block around it names no number.
const NOT_FOUND = /^Record not found\.?$/i;
// The summary's line for a delivered shipment, after the receiver's name: "Shipment Delivered at October 9, 2026 15:40".
const DELIVERY = /^(Shipment Delivered) at\s+(.+)$/i;
// The delivery's day and the time after it; four digits alone there are a year.
const DELIVERY_CLOCK = /^(.+?)\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]\.?M\.?)?)$/i;
const REPORT = /^(\S*)\s*-\s*Detailed Report$/i;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
// A day as the tracker writes it, "October 9, 2026", or as "9 Oct 2026", "09-Oct-2026" and "2026-10-09".
const MONTH_FIRST = /^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})$/;
const DAY_FIRST = /^(\d{1,2})[ -]([A-Za-z]{3,9})\.?[ -](\d{4})$/;
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
// A time: "15:40", "15:40:00", "1540" or "3:40 PM".
const CLOCK = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([AP])\.?M\.?)?$/i;
const HHMM = /^(\d{2})(\d{2})$/;
// A service area in India: a city of ICC's Indian network written alone, or a place that names India.
// Delhi alone is left out: New York State has a Delhi too.
const INDIA = /^(?:MUMBAI|NEW DELHI|CHENNAI|KOLKATA|BENGALURU|BANGALORE)(?:\s*,?\s*INDIA)?$|(?:^|[\s,(])INDIA\)?$/i;
// The partners the summary links a shipment's own number to, by the label before it: "BLUE DART - 69000000011".
// DHL is DHL Worldwide's express network. Other labels the older tracker printed, such as the UK's City-Link, name no catalog carrier.
const PARTNERS: ReadonlyMap<string, string> = new Map([
  ['DHL', 'dhl-express'], ['UPS', 'ups'], ['FEDEX', 'fedex'], ['ARAMEX', 'aramex'], ['BLUE DART', 'blue-dart'],
  ['TNT INTERNTIONAL', 'tnt'], ['TNT INTERNATIONAL', 'tnt'], ['USPS', 'usps'], ['DPEX', 'dpex'],
]);
const PARTNER_LINK = /^(.+?)\s+-\s+([A-Za-z0-9][A-Za-z0-9 -]{3,59})$/;
// Firewall and bot check pages, which could stand in for the tracking page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|\/cdn-cgi\/challenge-platform\/|_Incapsula_Resource|errors\.edgesuite\.net|requested URL was rejected|captcha|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)/i;
// Separators a scrubbed name leaves at the end of a row: "SHIPMENT DELIVERED -".
const TRAILING = /[\s,;:\-–—(]+$/;
const MAX_ROWS = 300;

/** An ICC air waybill: seven to twelve digits. Anything else is not one the tracker is asked for. */
export function normalizeIccWorldwideNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'ICC Worldwide air waybills are seven to twelve digits');
  return number;
}

/** Whether a page is a firewall's or a bot check's rather than the carrier's. */
export function isIccWorldwideBlockPage(html: string): boolean {
  return CHALLENGE.test(html.slice(0, 64_000));
}

function invalid(message: string): never {
  throw new SchemaError(PROVIDER, message);
}

/** A month's number from its English name or the name's first three letters or more. */
function monthOf(name: string): number {
  const lower = name.toLowerCase();
  return MONTHS.findIndex((month) => month.startsWith(lower)) + 1;
}

/** A day as `YYYY-MM-DD`, or null when it is not one. */
function dayOf(text: string): string | null {
  const iso = ISO_DAY.exec(text);
  if (iso) return calendarDay(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const named = MONTH_FIRST.exec(text);
  if (named) return monthOf(named[1]!) ? calendarDay(Number(named[3]), monthOf(named[1]!), Number(named[2])) : null;
  const first = DAY_FIRST.exec(text);
  return first && monthOf(first[2]!) ? calendarDay(Number(first[3]), monthOf(first[2]!), Number(first[1])) : null;
}

/** A time of day as `HH:mm:ss`, or null when it is not one. */
function timeOf(text: string): string | null {
  const match = CLOCK.exec(text) ?? HHMM.exec(text);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? 0);
  const half = match[4]?.toUpperCase();
  if (half) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (half === 'P' ? 12 : 0);
  }
  if (hour > 23 || minute > 59 || second > 59) return null;
  return [hour, minute, second].map((part) => String(part).padStart(2, '0')).join(':');
}

/** A day and an optional time as a wall clock; a row without a time keeps its day. */
function wallClock(date: string, time: string): string | null {
  const day = dayOf(date);
  if (!day || !time) return day;
  const clock = timeOf(time);
  return clock ? `${day}T${clock}` : null;
}

type Clock = { time: string } | { local_time: string };

/**
 * A wall clock at a service area. One in India is an instant on India's clock,
 * which the page's note makes it; any other stays a wall clock, as does a day
 * without a time.
 */
function clockAt(wall: string, location: string): Clock {
  if (!wall.includes('T') || !INDIA.test(location)) return { local_time: wall };
  const instant = firstOccurrence(DateTime.fromISO(wall, { zone: INDIA_ZONE })).toISO({ suppressMilliseconds: true });
  return instant ? { time: instant } : invalid('ICC Worldwide returned an invalid scan time');
}

/** Patterns that find the shipment's own names, which rows could carry. */
function namePatterns(names: readonly string[]): RegExp[] {
  return names.filter((name) => name.length >= 3)
    .map((name) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, 'giu'));
}

/** Text without the shipment's own names. */
function scrub(value: string, names: readonly RegExp[]): string {
  return clean(names.reduce((text, name) => text.replace(name, ' '), value)).replace(TRAILING, '');
}

/** The lines of an element, split where the page breaks them. */
function lines(element: Cheerio<AnyNode>): string[] {
  return (element.html() ?? '').split(/<br\s*\/?>/i).map((part) => clean(load(`<p>${part}</p>`)('p').text(), 300)).filter(Boolean);
}

interface Delivery { description: string; wall: string | null }

/**
 * The summary's delivery: the receiver's name, then the delivery line with its
 * day and time. The name is never kept; it is returned to be scrubbed from the rows.
 */
function deliveryOf(status: Cheerio<AnyNode>, names: string[]): Delivery | null {
  const spans = status.find('span.delivered');
  if (spans.length > 1) invalid('ICC Worldwide repeated the delivery of the shipment');
  let delivery: Delivery | null = null;
  for (const line of lines(spans)) {
    const match = DELIVERY.exec(line);
    if (!match) {
      names.push(line);
      continue;
    }
    if (delivery) invalid('ICC Worldwide repeated the delivery of the shipment');
    // The delivery's own clock; one the parser cannot read leaves the delivery without a clock.
    const timed = DELIVERY_CLOCK.exec(match[2]!);
    delivery = { description: match[1]!, wall: timed ? wallClock(timed[1]!, timed[2]!) : wallClock(match[2]!, '') };
  }
  return delivery;
}

/**
 * The partner the summary links the shipment's own number to. Only a label the
 * page is known to print for a catalog carrier is read, and only one partner.
 */
function partnerOf($: CheerioAPI, status: Cheerio<AnyNode>, number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const found = new Map<string, Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'>>();
  status.find('.tracking-status a').each((_, link) => {
    const match = PARTNER_LINK.exec(clean($(link).text(), 100));
    const carrier = match ? PARTNERS.get(match[1]!.toUpperCase()) : undefined;
    const reference = match ? normalizeTrackingNumber(match[2]!) : '';
    if (!carrier || !/^[A-Z0-9]{4,40}$/.test(reference) || reference === number) return;
    found.set(`${carrier} ${reference}`, { delivery_carrier: carrier, delivery_tracking_number: reference });
  });
  return found.size === 1 ? [...found.values()][0]! : {};
}

interface Row { key: string; wall: string; event: CarrierEvent }

/** One row of the detailed report: its date, its time, the service area and the details. */
function row($: CheerioAPI, node: AnyNode, names: readonly RegExp[]): Row {
  const cells = $(node).children('td');
  if (cells.length !== 4) invalid('ICC Worldwide changed its detailed report');
  const wall = wallClock(clean(cells.eq(0).text(), 40), clean(cells.eq(1).text(), 20));
  if (!wall) invalid('ICC Worldwide returned an invalid scan time');
  const location = scrub(clean(cells.eq(2).text(), 120), names);
  const description = scrub(clean(cells.eq(3).text(), 300), names);
  if (!description) invalid('ICC Worldwide returned a scan without its details');
  const staged = iccWorldwideStage(description);
  const event: CarrierEvent = {
    ...clockAt(wall, location),
    ...(location ? { location } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([wall, location, description]), wall, event };
}

/** The rows of the detailed report, newest first and once each. */
function history($: CheerioAPI, report: Cheerio<AnyNode>, names: readonly RegExp[]): Row[] {
  const tables = report.find('table.tracking-report-table');
  if (tables.length > 1) invalid('ICC Worldwide repeated its detailed report');
  const nodes = tables.find('tbody tr').toArray();
  if (nodes.length > MAX_ROWS) invalid('ICC Worldwide returned an oversized history');
  const seen = new Set<string>();
  const rows: Row[] = [];
  for (const node of nodes) {
    const parsed = row($, node, names);
    if (seen.has(parsed.key)) continue;
    seen.add(parsed.key);
    rows.push(parsed);
  }
  // The tracker lists the newest first; a list the other way round is turned round.
  return rows.length > 1 && rows[0]!.wall < rows.at(-1)!.wall ? rows.reverse() : rows;
}

/** The air waybill a summary block is headed with, or '' when the block names none. */
function shownNumber(block: Cheerio<AnyNode>): string {
  const text = clean(block.text(), 120);
  if (!LABEL.test(text)) invalid('ICC Worldwide changed its shipment summary');
  return normalizeTrackingNumber(text.replace(LABEL, ''));
}

/**
 * The page `www.iccworld.com/track-result.php?track_no=` renders for one air
 * waybill: a shipment summary headed by the number, with the origin, the
 * destination and, once delivered, the receiver's name and the delivery's day
 * and time, then a detailed report with the customer, the consignee and a row
 * per checkpoint, newest first. A number without a shipment gets the
 * summary's "Record not found" with no number. Names, origin and destination
 * are never kept.
 */
export function parseIccWorldwide(html: string, rawNumber: string): CarrierResult {
  const number = normalizeIccWorldwideNumber(rawNumber);
  const $ = load(html);
  const summary = $('.shipment-summary');
  if (summary.length !== 1) {
    if (isIccWorldwideBlockPage(html)) throw new ChallengeError(PROVIDER, 'ICC Worldwide answered with a block page');
    invalid('ICC Worldwide did not return its tracking page');
  }
  const blocks = summary.find('.tracking-number');
  const statuses = summary.find('.tracking-summary');
  const reports = $('.shipment-report');
  if (!blocks.length || blocks.length !== statuses.length || blocks.length !== reports.length) {
    invalid('ICC Worldwide changed its shipment summary');
  }
  if (blocks.length > 1) throw new IndeterminateError(PROVIDER, 'ICC Worldwide listed several shipments for the number');
  const shown = shownNumber(blocks);
  const notFound = statuses.find('td').filter((_, cell) => NOT_FOUND.test(clean($(cell).text(), 80))).length > 0;
  const rows = reports.find('table.tracking-report-table tbody tr');
  if (notFound) {
    if (shown && shown !== number) throw new IndeterminateError(PROVIDER, 'ICC Worldwide answered for another number');
    if (rows.length) invalid('ICC Worldwide listed a history under its notice');
    throw new NotFoundError(PROVIDER);
  }
  if (!shown) invalid('ICC Worldwide returned a shipment without its number');
  if (shown !== number) throw new IndeterminateError(PROVIDER, 'ICC Worldwide answered for another shipment');
  const titled = REPORT.exec(clean(reports.find('.title').first().text(), 120))?.[1] ?? '';
  if (titled && normalizeTrackingNumber(titled) !== number) {
    throw new IndeterminateError(PROVIDER, 'ICC Worldwide reported on another shipment');
  }

  // The customer's and the consignee's names, and the receiver's on a delivery, are only scrubbed.
  const names = reports.find('.cust-info-row strong').toArray().map((name) => clean($(name).text(), 120));
  const delivery = deliveryOf(statuses, names);
  const scanned = history($, reports, namePatterns(names));
  const deliveredRow = scanned.some(({ event }) => event.stage === 'delivered');
  // A delivery the summary dates before its row comes in is the newest checkpoint; its place is not shown.
  const events = [
    ...(delivery?.wall && !deliveredRow ? [deliveryEvent(delivery.description, delivery.wall)] : []),
    ...scanned.map(({ event }) => event),
  ];
  if (!events.length && !delivery) throw new NoHistoryError(PROVIDER);

  const staged = events.find((event) => event.stage);
  const settled: ClassifiedWording | null = delivery ? iccWorldwideStage(delivery.description) : null;
  const decided = settled ?? (staged ? { stage: staged.stage as Stage, source: staged.stage_source! } : null);
  const newest = events[0];
  const delivered = decided?.stage === 'delivered' ? events.find((event) => event.stage === 'delivered') : undefined;
  return {
    status: decided ? languageStageStatus(decided.stage) : 'unknown',
    ...(decided ? { current_stage: decided.stage, current_stage_source: decided.source } : {}),
    last_status_text: (settled ? delivery!.description : newest?.description) ?? null,
    last_update: newest?.time ?? null,
    ...(newest?.local_time ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    ...(delivered?.time ? { delivered_at: delivered.time } : {}),
    ...partnerOf($, statuses, number),
    ...(scanned.length ? {} : { summary_only: true }),
    events,
  };
}

function deliveryEvent(description: string, wall: string): CarrierEvent {
  const staged = iccWorldwideStage(description);
  return { local_time: wall, description, ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) };
}
