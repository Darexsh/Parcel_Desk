import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { DateTime } from 'luxon';
import { DELIVERY_POSTCODE, deliveryPostcodeText } from '../../core/catalog/postcode.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import {
  ChallengeError, IndeterminateError, InputRequiredError, InvalidInputError, NoHistoryError, SchemaError,
} from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { arrowXlStage } from './status.js';

export const PROVIDER = 'ArrowXL';
// A long history is about 25 kB of page.
export const ARROW_XL_MAX_BYTES = 512 * 1024;
export const ARROW_XL_ZONE = 'Europe/London';
// The help page's 10 to 13 letters and digits, and the label's 16 with a three-digit suffix.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{10,16}$/;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// "05-May 11:27" on current pages, "28-Jun-2018 18:38" on older ones.
const CLOCK = /^(\d{2})-([A-Za-z]{3})(?:-(\d{4}))? (\d{2}):(\d{2})$/;
// The day a booking, a route plan or a postponement is for, as "Customer Booked 05-MAY-2026".
const BOOKED = /^(?:Customer Booked|Route Planned For|Customer Postponed) (\d{2})-([A-Za-z]{3})-(\d{4})$/i;
const PROGRESS = /\/wismo-progress-stage([1-4])\.png$/i;
const NOT_FOUND = 'Invalid UPI number';
// A firewall or bot check's page, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Request Rejected|Access Denied|Attention Required|Just a moment)|requested URL was rejected|_cf_chl_opt|cf-turnstile|g-recaptcha|h-captcha/i;
// A depot name; the current pages put "Local Hub", which names no place, for every depot.
const NO_PLACE = /^local hub$|\d/i;
// The tracker's four steps, as its progress bar shows them.
const DELIVERY_STEPS: readonly Stage[] = ['registered', 'in_transit', 'out_for_delivery', 'delivered'];
const COLLECTION_STEPS: readonly Stage[] = ['registered', 'registered', 'registered', 'accepted'];
// A booking's day has passed once the crew tried it, or the parcel was delivered or sent back.
const ENDS_BOOKING: ReadonlySet<string> = new Set(['delivered', 'returned', 'failed_attempt']);
const MAX_ROWS = 300;
const MAX_EVENTS = 100;

/** An ArrowXL reference in capitals, as the form takes it; anything else is not one ArrowXL issues. */
export function normalizeArrowXlNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'ArrowXL references are 10 to 16 letters and digits');
  return number;
}

/**
 * The delivery postcode the tracker asks for with every reference: trimmed
 * and in capitals. Without it ArrowXL shows nothing, so no request is made.
 */
export function normalizeArrowXlPostcode(raw: string | null | undefined): string {
  const postcode = deliveryPostcodeText(raw ?? '');
  if (!postcode) throw new InputRequiredError(PROVIDER, 'the delivery postcode', 'ArrowXL shows a parcel only with its delivery postcode');
  if (!DELIVERY_POSTCODE.test(postcode)) throw new InvalidInputError(PROVIDER, 'ArrowXL requires a valid delivery postcode');
  return postcode;
}

const pad = (value: number) => String(value).padStart(2, '0');
const monthOf = (name: string) => MONTHS.indexOf(name.toLowerCase()) + 1;

/**
 * A row's wall clock. Current pages give a day and month without a year: the
 * year is the latest that puts the clock no later than the day after the
 * lookup in the UK. No offset is assigned.
 */
function wallClock(text: string, now: number): string {
  const match = CLOCK.exec(text);
  const month = match ? monthOf(match[2]!) : 0;
  const [day, hour, minute] = match ? [Number(match[1]), Number(match[4]), Number(match[5])] : [0, 0, 0];
  if (!match || !month || hour > 23 || minute > 59) throw new SchemaError(PROVIDER, 'ArrowXL returned an invalid scan time');
  const clock = `${pad(hour)}:${pad(minute)}:00`;
  if (match[3]) {
    const date = calendarDay(Number(match[3]), month, day);
    if (!date) throw new SchemaError(PROVIDER, 'ArrowXL returned an invalid scan time');
    return `${date}T${clock}`;
  }
  const latest = DateTime.fromMillis(now, { zone: ARROW_XL_ZONE }).plus({ days: 1 });
  const bound = latest.toFormat("yyyy-MM-dd'T'HH:mm:ss");
  for (let year = latest.year; year >= latest.year - 1; year -= 1) {
    const date = calendarDay(year, month, day);
    if (date && `${date}T${clock}` <= bound) return `${date}T${clock}`;
  }
  throw new SchemaError(PROVIDER, 'ArrowXL returned an invalid scan time');
}

type Scan = CarrierEvent & { local_time: string; description: string };

/** One "keeping track" row: the bullet, the clock, then the wording with the depot after it. */
function scanOf(cells: Cheerio<AnyNode>, now: number): Scan {
  if (cells.length !== 3) throw new SchemaError(PROVIDER, 'ArrowXL returned an unexpected history row');
  const wording = cells.eq(2);
  const description = clean(wording.contents().filter((_, node) => node.nodeType === 3).text(), 300);
  if (!description) throw new SchemaError(PROVIDER, 'ArrowXL returned a scan without wording');
  const depot = clean(wording.children('span.keeping-track-location').text(), 80);
  const location = NO_PLACE.test(depot) ? '' : depot;
  const staged = arrowXlStage(description);
  return {
    local_time: wallClock(clean(cells.eq(1).text(), 40), now),
    description,
    ...(location ? { location } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/**
 * The day the newest booking, route plan or postponement is for, while the
 * delivery is still to come: not after an attempt or once delivered, and not
 * a day before the newest scan.
 */
function bookedDay(events: readonly Scan[]): string | null {
  for (const event of events) {
    if (event.stage && ENDS_BOOKING.has(event.stage)) return null;
    const match = BOOKED.exec(event.description);
    if (!match) continue;
    const day = calendarDay(Number(match[3]), monthOf(match[2]!), Number(match[1]));
    return day && day >= events[0]!.local_time.slice(0, 10) ? day : null;
  }
  return null;
}

/** The step the progress bar shows, with its label, for a delivery or a collection. */
function progressOf($: CheerioAPI, collection: boolean): { stage: Stage; label: string } | null {
  const images = $('table.progress-table img.progress-image');
  const step = images.length === 1 ? PROGRESS.exec(images.attr('src') ?? '') : null;
  if (!step) return null;
  const index = Number(step[1]) - 1;
  const label = clean($('table.progress-table td.progress-text').eq(index).text(), 80);
  return { stage: (collection ? COLLECTION_STEPS : DELIVERY_STEPS)[index]!, label };
}

/** The page the tracker shows with the history of a delivery or a collection. */
function historyPage($: CheerioAPI, now: number): CarrierResult {
  const heading = clean($('.zone-content h1 span.font-light').first().text(), 80).toLowerCase();
  const collection = heading === 'is my collection?';
  if (!collection && heading !== 'is my delivery?') throw new SchemaError(PROVIDER, 'ArrowXL returned an unexpected tracking page');
  const trs = $('.wismo-table > table > tbody > tr');
  if (trs.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'ArrowXL returned an oversized history');
  const seen = new Set<string>();
  const scans: Scan[] = [];
  trs.each((_, tr) => {
    const scan = scanOf($(tr).children('td'), now);
    const key = JSON.stringify([scan.local_time, scan.description, scan.location ?? '']);
    if (seen.has(key)) return;
    seen.add(key);
    scans.push(scan);
  });
  // Current pages list the newest row first, older ones the oldest; equal clocks keep the page's order.
  if (scans.length > 1 && scans[0]!.local_time < scans.at(-1)!.local_time) scans.reverse();
  const events = scans.sort((left, right) => (left.local_time < right.local_time ? 1 : left.local_time > right.local_time ? -1 : 0));
  const progress = progressOf($, collection);

  if (!events.length) {
    if (!progress?.label) throw new NoHistoryError(PROVIDER);
    return {
      status: languageStageStatus(progress.stage), current_stage: progress.stage, current_stage_source: 'carrier_map',
      last_status_text: progress.label, last_update: null, expected_delivery: null, summary_only: true, events: [],
    };
  }
  const scanned = events.find((event) => event.stage);
  const newest = events[0]!;
  // The bar's last step settles a delivery whose success scan is not listed.
  const bar = !collection && progress?.stage === 'delivered' && !['delivered', 'returned'].includes(scanned?.stage ?? '') ? progress : null;
  const stage = bar ? bar.stage : scanned?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: bar ? 'carrier_map' : scanned?.stage_source ?? 'carrier_map' } : {}),
    last_status_text: bar?.label || newest.description,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: collection || stage === 'delivered' || stage === 'returned' ? null : bookedDay(events),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}

/**
 * The page the tracker shows on the day while the crew is on its rounds: the
 * crew's first names, the stops before the customer's, today's window and a
 * map of the van. None of that is kept; it is today's delivery under way.
 */
function crewPage($: CheerioAPI, now: number): CarrierResult {
  const top = clean($('.hismo-top').text(), 400);
  const delivery = /^Your delivery crew\b/i.test(top);
  if (!delivery && !/^Your collection crew\b/i.test(top)) throw new SchemaError(PROVIDER, 'ArrowXL returned an unexpected crew page');
  const stage: Stage = delivery ? 'out_for_delivery' : 'registered';
  return {
    status: languageStageStatus(stage), current_stage: stage, current_stage_source: 'carrier_map',
    // The words the progress bar uses for that step.
    last_status_text: delivery ? 'Out for Delivery' : 'On the Road',
    last_update: null,
    expected_delivery: delivery ? DateTime.fromMillis(now, { zone: ARROW_XL_ZONE }).toISODate() : null,
    summary_only: true,
    events: [],
  };
}

/** The tracker's notice for a reference and postcode it shows nothing for, bound to the reference it echoes. */
function notice($: CheerioAPI, number: string): never {
  const title = clean($('.error-container h1.error-title').text(), 120);
  const fields = $('form input#upi');
  const echoed = fields.length === 1 ? normalizeTrackingNumber(fields.attr('value') ?? '') : '';
  if (title !== NOT_FOUND) throw new IndeterminateError(PROVIDER, 'ArrowXL answered with another notice');
  if (echoed !== number) throw new IndeterminateError(PROVIDER, 'ArrowXL answered for another reference');
  // A wrong postcode and a parcel the tracker no longer holds get the same notice.
  throw new IndeterminateError(PROVIDER, 'ArrowXL shows nothing for that reference and postcode', { reason: 'portal_not_found' });
}

/**
 * ArrowXL's tracking page for one reference and postcode. A delivery or a
 * collection comes with its rows newest first; on the day, while the crew is
 * out, the crew's page replaces them. The found pages do not repeat the
 * reference: they answer the request. A reference and postcode the tracker
 * shows nothing for come back on the form, with a notice and the reference.
 */
export function parseArrowXl(html: string, rawNumber: string, now = Date.now()): CarrierResult {
  const number = normalizeArrowXlNumber(rawNumber);
  const $ = load(html);
  if ($('.error-container h1.error-title').length) notice($, number);
  if ($('.hismo-top').length) return crewPage($, now);
  if ($('.wismo-table').length || $('table.progress-table').length) return historyPage($, now);
  if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'ArrowXL answered with a block page');
  throw new SchemaError(PROVIDER, 'ArrowXL did not return a tracking page');
}
