import { load, type CheerioAPI } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { hitchStage } from './status.js';

export const PROVIDER = 'Hitch';
export const CARRIER = 'hitch';
// A page is about 25 kB.
export const HITCH_MAX_BYTES = 512 * 1024;
/** Hitch delivers only in the Philippines, which keep one offset all year; the page prints its clocks without it. */
export const HITCH_ZONE = 'Asia/Manila';

// ZIP and twelve letters and digits: the tracking number.
const TRACKING = /^ZIP[0-9A-Z]{12}$/;
// B and seven digits: the booking's reference, which the tracker also finds.
const REFERENCE = /^B\d{7}$/;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// "April 12, 2022"
const DAY = /^([A-Z][a-z]+) (\d{1,2}), (\d{4})$/;
// "4:48:PM", a colon before the half of the day.
const CLOCK = /^(\d{1,2}):(\d{2}):?\s?([AP]M)$/i;
// Cloudflare's checks and refusals. The real page loads reCAPTCHA for its sign-up forms, so that is no sign.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required!|Access Denied)|Sorry, you have been blocked/i;
// The tracker's answer for a number it holds no booking under, quoting the number.
const NOT_FOUND = /^Oooops! we couldn['’]t find any bookings\/results matching "([^"]*)"$/i;
// "Ref. No.: B0000017" under the tracking number.
const REF = /^Ref\. No\.:\s*([0-9A-Z]+)$/i;
const MAX_STEPS = 100;

/** A number for Hitch's tracker, in capitals: a tracking number or a booking reference. */
export function normalizeHitchNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!TRACKING.test(number) && !REFERENCE.test(number)) {
    throw new InvalidInputError(PROVIDER, 'Hitch numbers are ZIP and twelve letters and digits, or a booking reference of B and seven digits');
  }
  return number;
}

type Selection = ReturnType<CheerioAPI>;

/** A step's day and minute as one wall clock. The page names no zone. */
function wallClock(day: string, clock: string): string {
  const date = DAY.exec(day);
  const time = CLOCK.exec(clock);
  const month = date ? MONTHS.indexOf(date[1]!) + 1 : 0;
  const calendar = date && month ? calendarDay(Number(date[3]), month, Number(date[2])) : null;
  const hour = time ? Number(time[1]) : 0;
  const minute = time ? Number(time[2]) : 60;
  if (!calendar || !time || hour < 1 || hour > 12 || minute > 59) throw new SchemaError(PROVIDER, 'Hitch returned an invalid step time');
  const hours = (hour % 12) + (time[3]!.toUpperCase() === 'PM' ? 12 : 0);
  return `${calendar}T${String(hours).padStart(2, '0')}:${time[2]}:00`;
}

/**
 * The timeline, oldest first as the page lists it: each step's day and minute,
 * its name, and for some steps a remark. The remark is free text and is not
 * kept. Newest first: the page's order is reversed before the sort keeps steps
 * of one minute in the order Hitch gave them.
 */
function stepsOf($: CheerioAPI, items: Selection): CarrierEvent[] {
  if (items.length > MAX_STEPS) throw new SchemaError(PROVIDER, 'Hitch returned an oversized history');
  const events = items.toArray().map((item): CarrierEvent => {
    const stamp = $(item).children('.timestamp');
    const day = clean(stamp.children('.strong').text(), 40);
    const clock = clean(stamp.children('div').not('.strong').first().text(), 20);
    const description = clean($(item).children('.item-title').text(), 120);
    if (stamp.length !== 1 || !description) throw new SchemaError(PROVIDER, 'Hitch returned an invalid step');
    const staged = hitchStage(description);
    return { local_time: wallClock(day, clock), description, ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) };
  });
  if (listsNewestFirst(events) !== true) events.reverse();
  return events.sort((left, right) => right.local_time!.localeCompare(left.local_time!));
}

/** The booking's table beside the timeline: each label, without its colon, and its cell. */
function bookingFields($: CheerioAPI): Map<string, Selection> {
  const tables = $('table').filter((_, table) => $(table).find('td > strong').toArray()
    .some((label) => clean($(label).text(), 40) === 'Tracking No.'));
  if (tables.length !== 1) throw new SchemaError(PROVIDER, 'Hitch returned a booking without its details');
  const fields = new Map<string, Selection>();
  for (const row of tables.find('tr').toArray()) {
    const cells = $(row).children('td');
    const label = clean(cells.eq(0).text(), 40).replace(/\s*:$/, '');
    if (cells.length === 2 && label && !fields.has(label)) fields.set(label, cells.eq(1));
  }
  return fields;
}

/**
 * The tracker's page for one number, `/tracking?no=`, which its server
 * renders: under "Tracking Details", the booking's timeline, and beside it the
 * tracking number with the booking's reference under it, the booking date and
 * the current status. The tracker finds a booking by either number, and the
 * one asked must be one of them. A number it holds no booking under gets
 * "Oooops! we couldn't find any bookings/results matching" with the number
 * quoted, and HTTP 200. The page shows no places, recipient or proof of
 * delivery; the remarks and the booking date are not kept.
 */
export function parseHitch(html: string, raw: string): CarrierResult {
  const number = normalizeHitchNumber(raw);
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Hitch answered with a browser check');
  const $ = load(html);
  $('script, style, noscript').remove();
  const heading = $('h3').filter((_, element) => clean($(element).text(), 40) === 'Tracking Details');
  if (heading.length !== 1) throw new SchemaError(PROVIDER, 'Hitch returned an unexpected page');
  const panel = heading.parent();
  const items = panel.find('ul.tl > li.tl-item');
  const notice = panel.find('h3.text-warning');
  if (notice.length) {
    const quoted = NOT_FOUND.exec(clean(notice.text(), 200))?.[1];
    if (quoted === undefined || items.length) throw new SchemaError(PROVIDER, 'Hitch returned an unexpected notice');
    if (quoted.trim().toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'Hitch answered for another number');
    throw new NotFoundError(PROVIDER, 'Hitch has no booking for this number');
  }

  const fields = bookingFields($);
  const numbers = fields.get('Tracking No.');
  const own = clean(numbers?.children('div').not('.small').first().text(), 40).toUpperCase();
  const reference = REF.exec(clean(numbers?.children('div.small').first().text(), 60))?.[1]?.toUpperCase();
  const current = clean(fields.get('Current Status')?.text(), 120);
  if (!own || !current) throw new SchemaError(PROVIDER, 'Hitch returned a booking without its number or status');
  if (own !== number && reference !== number) throw new IndeterminateError(PROVIDER, 'Hitch answered for another shipment');

  const events = stepsOf($, items);
  const newest = events[0];
  // The current status is the carrier's own state; the newest staged step decides only one it does not stage.
  const summary = hitchStage(current);
  const scanned = events.find((event) => event.stage);
  const stage = (summary?.stage ?? scanned?.stage) as Stage | undefined;
  const source = summary ? summary.source : scanned?.stage_source;
  if (!newest && !summary) throw new NoHistoryError(PROVIDER);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: current,
    last_update: null,
    last_update_local: newest?.local_time ?? null,
    expected_delivery: null,
    // Asked by its reference, the booking's tracking number is its own.
    ...(own !== number ? { canonical_tracking_number: own } : {}),
    timezone: HITCH_ZONE,
    ...(newest ? {} : { summary_only: true }),
    events,
  };
}
