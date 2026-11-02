import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { fleetopticsStage } from './status.js';

export const PROVIDER = 'FleetOptics';
// A delivered page is about 100 kB, most of it the page's own help text.
export const FLEETOPTICS_MAX_BYTES = 1024 * 1024;
export const FLEETOPTICS_ZONE = 'America/Toronto';
// F, the shipper's code and a run of digits, sometimes with letters, as on the
// seven shippers' labels the tracker shows; a SON package ID, which the tracker
// files as the parcel's own barcode.
const NUMBER = /^(?:F[A-Z]{3,5}\d[0-9A-Z]{6,15}|SON1\d{10})$/;
// The labels the page puts after each clock: the zone of the parcel's destination.
const ZONES: Readonly<Record<string, string>> = { ET: FLEETOPTICS_ZONE, MT: 'America/Edmonton', PT: 'America/Vancouver' };
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
// "14:13 PT" and "Oct 1".
const CLOCK = /^(\d{1,2}):(\d{2})(?: ([A-Z]{1,4}))?$/;
const DAY = /^([A-Za-z]{3}) (\d{1,2})$/;
// "Thu, Sep 17", or "Today, 15:21 - 17:21" on the delivery day.
const ESTIMATE = /^([A-Za-z]{3}), ([A-Za-z]{3}) (\d{1,2})$/;
const TODAY = /^Today,/i;
// The notice for a number the tracker does not hold; older pages said "Please Enter Valid Tracking Number".
const NOT_FOUND = /^(?:Tracking number not found\.?|Please Enter Valid Tracking (?:Number|ID))$/i;
// A firewall or bot check's page, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Request Rejected|Access Denied|Attention Required|Just a moment)|requested URL was rejected|_cf_chl_opt|cf-turnstile|g-recaptcha|h-captcha|captcha-delivery|Incapsula|sgcaptcha/i;
const MAX_ROWS = 200;
const MAX_EVENTS = 100;

/** A FleetOptics number in capitals, as the tracker files it; anything else is not one FleetOptics issues. */
export function normalizeFleetopticsNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'FleetOptics numbers are F, a shipper code and digits');
  return number;
}

const monthOf = (name: string) => MONTHS.indexOf(name.toLowerCase()) + 1;
const text = (node: Cheerio<Element>, maxLength = 200) => clean(node.text(), maxLength);

/** The parcel's zone a clock's label names, or null for one the page has not been seen to use. */
export function fleetopticsZone(label: string): string | null {
  return Object.hasOwn(ZONES, label) ? ZONES[label]! : null;
}

interface Scan {
  event: CarrierEvent & { description: string };
  wall: string;
  zone: string | null;
}

/**
 * A row's clock: a day and month without a year, and a time with the label of
 * the destination's zone. The year is the latest that puts the clock no later
 * than the day after the lookup; the tracker keeps parcels for some months.
 */
function wallClock(day: string, clock: string, now: number): { wall: string; label: string } {
  const date = DAY.exec(day);
  const time = CLOCK.exec(clock);
  const month = date ? monthOf(date[1]!) : 0;
  const [hour, minute] = time ? [Number(time[1]), Number(time[2])] : [0, 0];
  if (!date || !time || !month || hour > 23 || minute > 59) throw new SchemaError(PROVIDER, 'FleetOptics returned an invalid scan time');
  const label = time[3] ?? '';
  const latest = DateTime.fromMillis(now, { zone: fleetopticsZone(label) ?? FLEETOPTICS_ZONE }).plus({ days: 1 });
  const bound = latest.toFormat("yyyy-MM-dd'T'HH:mm:ss");
  const at = `T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
  for (let year = latest.year; year >= latest.year - 1; year -= 1) {
    const calendar = calendarDay(year, month, Number(date[2]));
    if (calendar && `${calendar}${at}` <= bound) return { wall: `${calendar}${at}`, label };
  }
  throw new SchemaError(PROVIDER, 'FleetOptics returned an invalid scan time');
}

/**
 * One row of the tracking history. An Eastern clock is an instant: it matches
 * the service's own records and the drivers' photo clocks. Another label names
 * the destination's zone, which the page's first row and a scan at a terminal
 * elsewhere do not keep, so that clock stays local.
 */
function scanOf(row: Cheerio<Element>, now: number): Scan {
  const description = text(row.find('.fo-status-title'), 300);
  if (!description) throw new SchemaError(PROVIDER, 'FleetOptics returned a scan without wording');
  const { wall, label } = wallClock(text(row.find('.fo-month p'), 20), text(row.find('.fo-time p'), 20), now);
  const place = text(row.find('.fo-sub-status'), 80);
  // A town and its province; anything with a digit could be an address or a postal code.
  const location = /\d/.test(place) ? '' : place;
  const staged = fleetopticsStage(description);
  const eastern = label === 'ET'
    ? firstOccurrence(DateTime.fromISO(wall, { zone: FLEETOPTICS_ZONE })).toISO({ suppressMilliseconds: true })
    : null;
  return {
    event: {
      ...(eastern ? { time: eastern } : { local_time: wall }),
      description,
      ...(location ? { location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    },
    wall,
    zone: fleetopticsZone(label),
  };
}

/**
 * The summary's delivery estimate, a calendar day. A weekday and a day pick
 * the year nearest the lookup with that weekday; on the delivery day the page
 * gives today's time window instead.
 */
function estimate($: CheerioAPI, zone: string, now: number): string | null {
  const box = $('.fo-estimated-info');
  if (box.length !== 1 || !/^Estimated Delivery:?$/i.test(text(box.find('h2'), 40))) return null;
  const value = text(box.find('p'), 60);
  const today = DateTime.fromMillis(now, { zone });
  if (TODAY.test(value)) return today.toISODate();
  const match = ESTIMATE.exec(value);
  const weekday = match ? WEEKDAYS.indexOf(match[1]!.toLowerCase()) + 1 : 0;
  const month = match ? monthOf(match[2]!) : 0;
  if (!match || !weekday || !month) return null;
  // Calendar days, compared as dates without a zone.
  const date = (day: string) => DateTime.fromISO(day, { zone: 'utc' });
  const days = [today.year - 1, today.year, today.year + 1]
    .map((year) => calendarDay(year, month, Number(match[3])))
    .filter((day): day is string => day !== null && date(day).weekday === weekday);
  const distance = (day: string) => Math.abs(date(day).diff(date(today.toISODate()!), 'days').days);
  return days.sort((left, right) => distance(left) - distance(right))[0] ?? null;
}

/** The number the page's search field was filled with, which the page repeats as it was typed. */
function echoed($: CheerioAPI): string {
  const fields = $('form.fo-search input[name="tracking_number"]');
  return fields.length === 1 ? normalizeTrackingNumber(fields.attr('value') ?? '').toUpperCase() : '';
}

/**
 * FleetOptics' tracking page for one number, rendered by its server. A number
 * the tracker holds gets the summary and the tracking history, newest first; an
 * unknown one gets a notice in place of both. The page repeats the number only
 * in its search field. The service redirects a number that is not a parcel's
 * own barcode, such as one in lower case, to that barcode, so the page answered
 * for the address asked is the parcel's.
 */
export function parseFleetoptics(html: string, rawNumber: string, now = Date.now()): CarrierResult {
  const number = normalizeFleetopticsNumber(rawNumber);
  const $ = load(html);
  if (!$('form.fo-search').length) {
    if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'FleetOptics answered with a block page');
    throw new SchemaError(PROVIDER, 'FleetOptics did not return its tracking page');
  }
  if (echoed($) !== number) throw new IndeterminateError(PROVIDER, 'FleetOptics answered for another number');
  const notice = $('.fo-no-search .fo-trak-info-desc > p');
  if (notice.length) {
    if (NOT_FOUND.test(text(notice.first(), 120))) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'FleetOptics answered with another notice');
  }
  const list = $('ul.fo-tracking-history-list');
  if (list.length !== 1) throw new SchemaError(PROVIDER, 'FleetOptics returned a page without its tracking history');
  const rows = list.children('li');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'FleetOptics returned an oversized history');

  const seen = new Set<string>();
  const scans: Scan[] = [];
  rows.each((_, row) => {
    const scan = scanOf($(row), now);
    const key = JSON.stringify([scan.wall, scan.event.description, scan.event.location ?? '']);
    if (seen.has(key)) return;
    seen.add(key);
    scans.push(scan);
  });
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the page lists them; an oldest-first page is turned round.
  if (scans.length > 1 && scans[0]!.wall < scans.at(-1)!.wall) scans.reverse();

  const events = scans.map((scan) => scan.event);
  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  const stage = scanned?.stage as Stage | undefined;
  const delivered = stage === 'delivered' ? scanned : undefined;
  // The zone the local clocks are in, when the page names one for all of them.
  const zones = new Set(scans.filter((scan) => !scan.event.time).map((scan) => scan.zone));
  const local = zones.size === 1 ? [...zones][0] ?? null : null;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: scanned!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description,
    last_update: typeof newest.time === 'string' ? newest.time : null,
    ...(typeof newest.local_time === 'string' ? { last_update_local: newest.local_time } : {}),
    expected_delivery: stage === 'delivered' || stage === 'returned' ? null : estimate($, scans[0]!.zone ?? FLEETOPTICS_ZONE, now),
    ...(typeof delivered?.time === 'string' ? { delivered_at: delivered.time } : {}),
    ...(local ? { timezone: local } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
