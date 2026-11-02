import { returnedTrackingNumber } from '../../core/detection/returned.js';
import { load, type CheerioAPI } from 'cheerio';
import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { USPS_ROUTING_BARCODE, uspsPackageIdentifier } from '../../core/detection/usps.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { passportOwnWording, passportStage } from './status.js';

export const PROVIDER = 'Passport';
export const PASSPORT_ORIGIN = 'https://track.passportglobal.com';
// A shipment's page is some forty kilobytes, its scripts and styles linked.
export const PASSPORT_MAX_BYTES = 512 * 1024;
// PG, ten or eleven digits and the destination country.
const NUMBER = /^PG\d{10,11}[A-Z]{2}$/;
// The page hands its shipment to its script on one line, with the merchant's page name.
const INITIALIZE = /BrandedPage\.initialize\((\{.*\})\s*,\s*"[a-z0-9-]{0,63}"\s*\)\s*;/g;
const NOT_FOUND = /^We can['’]t find the tracking number\b/;
// The page the site shows a visitor it suspects of being automated, instead of the tracker.
const CHALLENGE = /<title>\s*Human Verification\s*</i;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY = /^([A-Z][a-z]{2}) (\d{2})$/;
const CLOCK = /^(\d{2}):(\d{2})$/;
// Passport converts these partners' scans to UTC, as its own; it relays the
// others' wall clocks under the same UTC label.
const UTC_PARTNERS = new Set(['uniuni', 'parcel right']);
// A scan dated weeks before the order belongs to the next year.
const ORDER_SLACK_MS = 30 * 86_400_000;
const MAX_ROWS = 300;
const MAX_EVENTS = 100;

/** A Passport tracking number; a partner's number stays with its own carrier. */
export function normalizePassportNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) {
    throw new InvalidInputError(PROVIDER, 'Passport tracking numbers are PG, ten or eleven digits and a country code');
  }
  return number;
}

interface Shipment {
  readonly orderedAt: number | null;
  readonly country: string;
}

/** The shipment the page's script receives, bound to the number asked for. Recipient fields are never read. */
function shipmentOf(html: string, number: string): Shipment {
  const calls = [...html.matchAll(INITIALIZE)];
  if (calls.length !== 1) throw new SchemaError(PROVIDER, 'Passport returned a page without one shipment');
  let shipment: unknown;
  try {
    shipment = JSON.parse(calls[0]![1]!);
  } catch (cause) {
    throw new SchemaError(PROVIDER, 'Passport returned an unreadable shipment', { cause });
  }
  if (!isRecord(shipment) || typeof shipment.tracking_code !== 'string') {
    throw new SchemaError(PROVIDER, 'Passport returned a shipment without its tracking number');
  }
  if (returnedTrackingNumber(shipment.tracking_code) !== number) {
    throw new SchemaError(PROVIDER, 'Passport returned another shipment');
  }
  const bought = shipment.time_bought;
  const country = typeof shipment.country_to === 'string' ? shipment.country_to.toUpperCase() : '';
  return {
    orderedAt: typeof bought === 'number' && Number.isSafeInteger(bought) && bought > 0 ? bought * 1_000 : null,
    country: /^[A-Z]{2}$/.test(country) ? country : '',
  };
}

/**
 * The page gives a day and month without a year. The order time sets it:
 * scans come after the order. Without one, the lookup's day does.
 */
function dayOf(raw: string, after: number): { year: number; month: number; day: number } {
  const match = DAY.exec(raw);
  const month = match ? MONTHS.indexOf(match[1]!) + 1 : 0;
  if (!match || !month) throw new SchemaError(PROVIDER, 'Passport returned an invalid scan date');
  const day = Number(match[2]);
  let year = new Date(after).getUTCFullYear();
  if (Date.UTC(year, month - 1, day, 23, 59) < after) year += 1;
  if (!calendarDay(year, month, day)) throw new SchemaError(PROVIDER, 'Passport returned an invalid scan date');
  return { year, month, day };
}

const pad = (value: number) => String(value).padStart(2, '0');

interface Row {
  readonly description: string;
  readonly day: string;
  readonly clock: string;
  readonly place: string;
}

/** The history's scan rows, newest first. Estimated rows the page fills in for a milestone are no scans. */
function rowsOf($: CheerioAPI): Row[] {
  if ($('.history-old').length || $('.tracking-details .history').length !== 1) {
    throw new SchemaError(PROVIDER, 'Passport returned an unexpected history');
  }
  const items = $('.tracking-details .history .tab .tab-content .detail-item');
  if (items.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Passport returned an oversized history');
  const rows: Row[] = [];
  items.each((_, item) => {
    const row = $(item);
    if (row.find('.virtual-milestone').length) return;
    const date = row.children('.date');
    const description = clean(row.children('.message').text(), 500);
    const day = clean(date.contents().filter((__, node) => node.nodeType === 3).text(), 20);
    const clock = clean(date.children('.time').text(), 10);
    if (date.length !== 1 || !description || !CLOCK.test(clock)) throw new SchemaError(PROVIDER, 'Passport returned an invalid scan');
    const place = clean(row.children('.address').text(), 200);
    // A bare country is the order's, not where a scan happened; a digit may be a street or a postcode.
    rows.push({ description, day, clock, place: /^[A-Z]{2}$/.test(place) || /\d/.test(place) ? '' : place });
  });
  return rows;
}

function eventOf(row: Row, after: number, utcPartner: boolean): CarrierEvent {
  const { year, month, day } = dayOf(row.day, after);
  const [, hour, minute] = CLOCK.exec(row.clock)!;
  if (Number(hour) > 23 || Number(minute) > 59) throw new SchemaError(PROVIDER, 'Passport returned an invalid scan time');
  const wall = `${year}-${pad(month)}-${pad(day)}T${hour}:${minute}:00`;
  const staged = passportStage(row.description);
  return {
    // Passport's own scans and the partners it converts carry its UTC clock; it
    // labels the other partners' wall clocks as UTC too, so only their wall clock is kept.
    ...(passportOwnWording(row.description) || utcPartner ? { time: `${wall}Z` } : { local_time: wall }),
    description: row.description,
    ...(row.place ? { location: row.place } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/** The estimate the page shows, a day or a range, while the parcel is on its way. */
function estimateOf($: CheerioAPI, orderedAt: number | null): Pick<CarrierResult, 'expected_delivery' | 'expected_delivery_from'> {
  const block = $('.delivery-date-block').first();
  if (orderedAt === null || clean(block.find('.title-container .title').first().text(), 80) !== 'Estimated delivery date') {
    return { expected_delivery: null };
  }
  const days = block.find('.date-container .date').toArray()
    .map((node) => clean($(node).text(), 20).replace(/\s*-$/, ''));
  if (!days.length || days.length > 2) return { expected_delivery: null };
  const [from, to] = days.map((raw) => {
    const { year, month, day } = dayOf(raw, orderedAt - ORDER_SLACK_MS);
    return `${year}-${pad(month)}-${pad(day)}`;
  });
  return to && to > from! ? { expected_delivery: to, expected_delivery_from: from! } : { expected_delivery: from! };
}

/** The partner's number, without the recipient's ZIP code a USPS routing barcode opens with. */
function partnerNumber(raw: string, number: string): string | undefined {
  const compact = normalizeTrackingNumber(raw);
  const code = USPS_ROUTING_BARCODE.test(compact) ? uspsPackageIdentifier(compact) ?? '' : compact;
  return /^[A-Z0-9]{4,40}$/.test(code) && code !== number ? code : undefined;
}

interface Partner {
  readonly name: string;
  readonly carrier?: string;
  readonly number?: string;
}

/** The local delivery partner the page names, with its tracking link and number. Its phone number is not read. */
function partnerOf($: CheerioAPI, number: string): Partner {
  const block = $('.last-mile-carrier').first();
  const name = clean(block.find('.name').first().text(), 80);
  const code = block.find('a.tracking-code').first();
  const url = clean(code.attr('href') ?? block.find('.name a').first().attr('href') ?? '', 500);
  const carrier = name ? carrierIdFromPartner(name, url) : undefined;
  const delivery = partnerNumber(clean(code.text(), 64), number);
  return { name, ...(carrier && carrier !== 'passport' ? { carrier } : {}), ...(delivery ? { number: delivery } : {}) };
}

/**
 * The page `track.passportglobal.com/{number}` leads to: Passport's page for
 * the merchant, with the shipment its script receives and the history it shows.
 * The page counts only when its shipment is the number asked for. The
 * recipient's town and the order reference are never read.
 */
export function parsePassport(html: string, raw: string, readAt = Date.now()): CarrierResult {
  const number = normalizePassportNumber(raw);
  if (CHALLENGE.test(html)) throw new ChallengeError(PROVIDER, 'Passport answered with its human verification page');
  const $ = load(html);
  if (!html.includes('BrandedPage.initialize')) return passportAbsence($, number);
  const shipment = shipmentOf(html, number);
  const rows = rowsOf($);
  if (!rows.length) throw new NoHistoryError(PROVIDER);
  const partner = partnerOf($, number);
  const utcPartner = UTC_PARTNERS.has(partner.name.toLowerCase());
  // Scans come after the order; without its time, none is later than the lookup.
  const after = shipment.orderedAt === null ? readAt + 2 * 86_400_000 - 365 * 86_400_000 : shipment.orderedAt - ORDER_SLACK_MS;
  const seen = new Set<string>();
  const events = rows.filter((row) => {
    const key = JSON.stringify(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((row) => eventOf(row, after, utcPartner));

  // A receipt after the parcel moved on is the next depot's or the partner's, not its acceptance.
  let moved = false;
  for (const event of [...events].reverse()) {
    const stage = event.stage as Stage | undefined;
    if (stage === 'accepted' && moved) event.stage = 'in_transit';
    if (stage && !['registered', 'accepted', 'exception'].includes(stage)) moved = true;
  }

  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    ...(stage === 'delivered' ? { expected_delivery: null } : estimateOf($, shipment.orderedAt)),
    ...(stage === 'delivered' && current === newest && newest.time ? { delivered_at: newest.time } : {}),
    ...(partner.carrier ? { delivery_carrier: partner.carrier } : {}),
    ...(partner.number ? { delivery_tracking_number: partner.number } : {}),
    ...(shipment.country ? { destination_country: shipment.country } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}

/** A page without a shipment: Passport's notice for a number it does not know names that number. */
function passportAbsence($: CheerioAPI, number: string): never {
  const notice = $('.container > div').first();
  const codes = notice.find('.tracking-code');
  if (NOT_FOUND.test(clean(notice.text(), 500)) && codes.length === 1) {
    if (clean(codes.text(), 64) === `${number}.`) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'Passport answered for another number');
  }
  throw new IndeterminateError(PROVIDER, 'Passport returned no shipment page');
}
