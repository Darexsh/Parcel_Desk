import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { calendarDay, countryCode, firstOccurrence } from '../../core/time/index.js';
import { clean, escapeRegExp } from '../../core/transport/index.js';
import { atlanticCourierStage, isAtlanticCourierReceipt } from './status.js';

export const PROVIDER = 'Atlantic International Express';
// A found shipment's reply is about ten kilobytes; an unknown number's is a few hundred bytes.
export const ATLANTIC_COURIER_MAX_BYTES = 512 * 1024;
// The reply says its clocks are local to the place of each scan.
const INDIA_ZONE = 'Asia/Kolkata';

// An air waybill: a plain digit run. Archived lookups show six and seven digits; customers quote ten.
const NUMBER = /^\d{6,10}$/;
const HEADING = /^Travel History for AWB No\.?\s*:/i;
// The tracker's notice for a number it holds nothing under; it names no number.
const NOT_FOUND = /^No Tracking Data Available\.?\s*Please check your tracking number\.?$/i;
const DESTINATION = /^Destination\s*:\s*(.*)$/i;
// A country with its code after it, as "NEW ZEALAND : NZ".
const COUNTRY_WITH_CODE = /^(.+?)\s*:\s*([A-Z]{2})$/i;
// English names Atlantic writes that `countryCode` does not read.
const COUNTRY_NAMES: ReadonlyMap<string, string> = new Map([
  ['GREAT BRITAIN', 'GB'], ['UK', 'GB'], ['USA', 'US'], ['UAE', 'AE'],
]);
const SIGNING = /^Signing for\s*:?\s*(.*)$/i;
// What the "Signing for" line holds when it names no one: "SIGN", "delivered" or a partner's sentence.
const NOT_A_NAME = /deliver|\bsign\b|\d/i;
// A scan's clock, day first: "14/10/2026 1:07 PM".
const SCAN_CLOCK = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([AP])\.?M\.?)?)?$/i;
// The summary's delivery: "1st August 2026 , 1:18 PM".
const DELIVERY_CLOCK = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})(?:\s*,?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([AP])\.?M\.?)?)?$/i;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
// Places of Atlantic's network in India that no town abroad shares, or a place naming India.
// Delhi and Hyderabad alone are left out: Canada and the United States have a Delhi, Pakistan a Hyderabad.
const INDIA = /^(?:MUMBAI|NAVI MUMBAI|THANE|PUNE|NASHIK|SURAT|AHMEDABAD|NEW DELHI|BANGALORE|BENGALURU|CHENNAI|TIRUPUR|KOLKATA)$|(?:^|[\s,(])INDIA\)?$|\(IN\)$/i;
// A partner's wording that names who signed or took the parcel after it.
const SIGNED_BY = /\b(?:signed\s+(?:for\s+)?by|received\s+by)\b.*$/i;
// Firewall and bot check pages, which could stand in for the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|\/cdn-cgi\/challenge-platform\/|_Incapsula_Resource|errors\.edgesuite\.net|requested URL was rejected|captcha|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)/i;
// Separators a scrubbed name leaves at the end of a wording: "Delivered -".
const TRAILING = /[\s,;:\-–—(]+$/;
const MAX_ROWS = 300;

/** An Atlantic air waybill: six to ten digits. Anything else is not one the tracker is asked for. */
export function normalizeAtlanticCourierNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Atlantic air waybills are six to ten digits');
  return number;
}

/** Whether a reply is a firewall's or a bot check's rather than the tracker's. */
export function isAtlanticCourierBlockPage(html: string): boolean {
  return CHALLENGE.test(html.slice(0, 64_000));
}

function invalid(message: string): never {
  throw new SchemaError(PROVIDER, message);
}

/** A wall clock from a day and an optional time; null when either is not one. */
function wallClock(day: string | null, hour?: string, minute?: string, second?: string, half?: string): string | null {
  if (!day || hour === undefined) return day;
  let hours = Number(hour);
  const minutes = Number(minute);
  const seconds = Number(second ?? 0);
  if (half) {
    if (hours < 1 || hours > 12) return null;
    hours = (hours % 12) + (half.toUpperCase() === 'P' ? 12 : 0);
  }
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  return `${day}T${[hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':')}`;
}

/** A scan's clock as a wall clock, day first, or null when it is not one. */
function scanClock(text: string): string | null {
  const match = SCAN_CLOCK.exec(text);
  if (!match) return null;
  return wallClock(calendarDay(Number(match[3]), Number(match[2]), Number(match[1])), match[4], match[5], match[6], match[7]);
}

/**
 * The summary's delivery as a wall clock. A delivery at midnight is how the
 * summary gives a day without a time, so it keeps the day alone.
 */
function deliveryClock(text: string): string | null {
  const match = DELIVERY_CLOCK.exec(text);
  // A month's English name or its first three letters or more.
  const month = match ? MONTHS.findIndex((name) => name.startsWith(match[2]!.toLowerCase())) + 1 : 0;
  if (!match || !month) return null;
  const day = calendarDay(Number(match[3]), month, Number(match[1]));
  const wall = wallClock(day, match[4], match[5], match[6], match[7]);
  return wall?.endsWith('T00:00:00') ? day : wall;
}

type Clock = { time: string } | { local_time: string };

/**
 * A wall clock at a place. One in India is an instant on India's clock, as the
 * reply's note makes it; any other stays a wall clock, as does a day without a
 * time.
 */
function clockAt(wall: string, location: string): Clock {
  if (!wall.includes('T') || !INDIA.test(location)) return { local_time: wall };
  const instant = firstOccurrence(DateTime.fromISO(wall, { zone: INDIA_ZONE })).toISO({ suppressMilliseconds: true });
  return instant ? { time: instant } : invalid('Atlantic returned an invalid scan time');
}

/** Patterns that find the shipment's own names, which scans could carry. */
function namePatterns(names: readonly string[]): RegExp[] {
  return names.filter((name) => name.length >= 3)
    .map((name) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, 'giu'));
}

/** Text without the shipment's own names, nor whoever a partner says signed for it. */
function scrub(value: string, names: readonly RegExp[]): string {
  return clean(names.reduce((text, name) => text.replace(name, ' '), value).replace(SIGNED_BY, '')).replace(TRAILING, '');
}

/** The lines of a cell, split where the page breaks them. */
function lines(cell: Cheerio<AnyNode>): string[] {
  return (cell.html() ?? '').split(/<br\s*\/?>/i).map((part) => clean(load(`<p>${part}</p>`)('p').text(), 300)).filter(Boolean);
}

/** The destination country, by its ISO code when the name or the code after it reads as one. */
function destinationOf(text: string): Pick<CarrierResult, 'destination_country' | 'destination_country_name'> {
  const name = clean(DESTINATION.exec(text)?.[1] ?? '', 80);
  if (!name) return {};
  const coded = COUNTRY_WITH_CODE.exec(name);
  const code = (coded ? countryCode(coded[2]!) : null) ?? countryCode(name) ?? COUNTRY_NAMES.get(name.toUpperCase());
  return code ? { destination_country: code } : { destination_country_name: name };
}

interface Row { key: string; wall: string; description: string; location: string }

/** The scans under the summary, newest first and once each. */
function history($: CheerioAPI, table: Cheerio<AnyNode>, names: readonly RegExp[]): Row[] {
  const nodes = table.find('tr').toArray();
  const heading = nodes.shift();
  const headings = heading ? $(heading).children('td, th').toArray().map((cell) => clean($(cell).text(), 40)) : [];
  if (headings.join('|') !== 'Date/Time|Activity|Location') invalid('Atlantic changed its activity table');
  if (nodes.length > MAX_ROWS) invalid('Atlantic returned an oversized history');
  const seen = new Set<string>();
  const rows: Row[] = [];
  for (const node of nodes) {
    const cells = $(node).children('td');
    if (cells.length !== 3) invalid('Atlantic changed its activity table');
    const wall = scanClock(clean(cells.eq(0).text(), 40));
    if (!wall) invalid('Atlantic returned an invalid scan time');
    const description = scrub(clean(cells.eq(1).text(), 300), names);
    if (!description) invalid('Atlantic returned a scan without its activity');
    const location = scrub(clean(cells.eq(2).text(), 120), names);
    const key = JSON.stringify([wall, description, location]);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ key, wall, description, location });
  }
  // The tracker lists the newest first; a list the other way round is turned round.
  return rows.length > 1 && rows[0]!.wall < rows.at(-1)!.wall ? rows.reverse() : rows;
}

/**
 * The rows' events. Atlantic's oldest receipt is the shipment's acceptance;
 * every later one is a hub's, on the way.
 */
function events(rows: readonly Row[]): CarrierEvent[] {
  const first = rows.reduce((oldest, row, index) => (isAtlanticCourierReceipt(row.description) ? index : oldest), -1);
  return rows.map((row, index) => {
    const staged: ClassifiedWording | null = isAtlanticCourierReceipt(row.description)
      ? { stage: index === first ? 'accepted' : 'in_transit', source: 'carrier_map' }
      : atlanticCourierStage(row.description);
    return {
      ...clockAt(row.wall, row.location),
      ...(row.location ? { location: row.location } : {}),
      description: row.description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    };
  });
}

/** The summary table's top rows, by the label in their first cell. */
function labelled($: CheerioAPI, table: Cheerio<AnyNode>, label: string): Cheerio<AnyNode> {
  const body = table.children('tbody');
  const rows = (body.length ? body : table).children('tr')
    .filter((_, row) => clean($(row).children('td').first().text(), 60).toLowerCase() === label.toLowerCase());
  if (rows.length > 1) invalid(`Atlantic repeated the shipment's ${label}`);
  return rows.children('td');
}

/**
 * The fragment the tracking page's lookup returns for one air waybill: a
 * summary headed by the number, then a table with the consignee's name, the
 * destination, the delivery's day and time, who signed for it and the
 * partner's forwarding number, and the scans newest first. A number without a
 * shipment gets a notice that names no number. The names and the forwarding
 * number, which comes without its partner, are never kept.
 */
export function parseAtlanticCourier(html: string, rawNumber: string): CarrierResult {
  const number = normalizeAtlanticCourierNumber(rawNumber);
  const $ = load(html);
  const headings = $('.atl-md-shipment-overview h2.header');
  const notice = $('th').filter((_, cell) => NOT_FOUND.test(clean($(cell).text(), 200))).length > 0;
  if (!headings.length) {
    if (notice && !$('table.table-striped').length) throw new NotFoundError(PROVIDER);
    if (isAtlanticCourierBlockPage(html)) throw new ChallengeError(PROVIDER, 'Atlantic answered with a block page');
    invalid('Atlantic did not return its tracking reply');
  }
  if (notice) invalid('Atlantic listed a shipment under its notice');
  if (headings.length > 1) throw new IndeterminateError(PROVIDER, 'Atlantic listed several shipments for the number');
  if (!HEADING.test(clean(headings.text(), 120))) invalid('Atlantic changed its shipment summary');
  const shown = normalizeTrackingNumber(clean(headings.find('em').text(), 60));
  if (!shown) invalid('Atlantic returned a shipment without its number');
  if (shown !== number) throw new IndeterminateError(PROVIDER, 'Atlantic answered for another shipment');

  const tables = $('table.table-bordered.mt10');
  const scans = tables.find('table.table-striped');
  if (tables.length !== 1 || scans.length !== 1) invalid('Atlantic changed its shipment details');
  const consignee = labelled($, tables, 'Consignee Name');
  const delivery = labelled($, tables, 'Delivery Date');
  if (delivery.length !== 3) invalid('Atlantic changed its delivery details');
  // The consignee's and the signer's names are only scrubbed from the scans.
  const signer = lines(delivery.eq(2)).map((line) => SIGNING.exec(line)?.[1] ?? '').find(Boolean) ?? '';
  const names = namePatterns([clean(consignee.eq(1).text(), 120), ...(NOT_A_NAME.test(signer) ? [] : [signer])]);
  const deliveryText = clean(delivery.eq(1).text(), 80);
  const delivered = deliveryText ? { wall: deliveryClock(deliveryText) } : null;

  const scanned = events(history($, scans, names));
  const deliveredRow = scanned.some((event) => event.stage === 'delivered');
  // A delivery the summary dates before its scan comes in is the newest event; its place is not shown.
  const all = [
    ...(delivered?.wall && !deliveredRow ? [deliveryEvent(delivered.wall)] : []),
    ...scanned,
  ];
  if (!all.length && !delivered) throw new NoHistoryError(PROVIDER);

  const staged = all.find((event) => event.stage);
  const decided: ClassifiedWording | null = delivered ? atlanticCourierStage('Delivered')
    : staged ? { stage: staged.stage as Stage, source: staged.stage_source! } : null;
  const newest = all[0];
  return {
    status: decided ? languageStageStatus(decided.stage) : 'unknown',
    ...(decided ? { current_stage: decided.stage, current_stage_source: decided.source } : {}),
    last_status_text: (delivered && !deliveredRow ? 'Delivered' : newest?.description) ?? null,
    last_update: newest?.time ?? null,
    ...(newest?.local_time ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    ...destinationOf(clean(consignee.eq(2).text(), 120)),
    ...(scanned.length ? {} : { summary_only: true }),
    events: all,
  };
}

function deliveryEvent(wall: string): CarrierEvent {
  return { local_time: wall, description: 'Delivered', stage: 'delivered', stage_source: 'carrier_map' };
}
