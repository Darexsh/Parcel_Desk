import { load, type CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, firstOccurrence, townKey } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { placedInIndia } from './clock.js';
import { shiprocketStage } from './status.js';

export const PROVIDER = 'Shiprocket';
export const SHIPROCKET_ORIGIN = 'https://shiprocket.co';
// A shipment's page is some 220 kilobytes, its styles and scripts inline.
export const SHIPROCKET_MAX_BYTES = 1024 * 1024;
// Shiprocket's tracker takes the AWB of any courier it books, so the number is any AWB.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,30}$/;
const ZONE = 'Asia/Kolkata';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY = /^(\d{1,2}) ([A-Z][a-z]{2})$/;
// "12 Oct 2026", or "12th Oct 2026" on older pages.
const ORDER_DAY = /^(\d{1,2})(?:st|nd|rd|th)? ([A-Z][a-z]{2}) (\d{4})$/;
const CLOCK = /^(\d{2}):(\d{2}) ([AP]M)$/;
// A bot check a CDN or firewall could put in place of the page. The tracking page loads reCAPTCHA for its own forms.
export const SHIPROCKET_CHALLENGE = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request blocked|ERROR: The request could not be satisfied)|_cf_chl_opt|cf-turnstile|captcha-delivery\.com/i;
// A scan dated weeks before the order belongs to the next year.
const ORDER_SLACK_MS = 30 * 86_400_000;
const DAY_MS = 86_400_000;
// A wall clock read on India's may be up to this much ahead of it (UTC+14).
const AHEAD_MS = 8.5 * 3_600_000;
// Shiprocket's own rows: its order, and its export hub's arrival and departure, which it places in Delhi or nowhere.
const OWN_ROWS = new Set(['order received', 'order arrived at facility', 'order departed from facility']);
const ORDER_ROW = 'order received';
// Shiprocket's couriers within India, as its pages name them ("Delhivery Surface", "Xpressbees Surface 2kg"): all their rows are in India.
const DOMESTIC = ['amazon', 'bluedart', 'blitz', 'delhivery', 'dtdc', 'ecomexpress', 'ekart', 'elasticrun', 'kerryindev', 'shadowfax', 'smartr', 'xpressbees'];
const MAX_ROWS = 300;
const MAX_EVENTS = 100;

/** An AWB the tracker can be asked for; anything else is not sent. */
export function normalizeShiprocketNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Shiprocket AWBs are 8 to 30 letters and digits');
  return number;
}

const pad = (value: number) => String(value).padStart(2, '0');

/** A day with its year as `YYYY-MM-DD`. */
function dayOf(text: string): string | null {
  const match = ORDER_DAY.exec(clean(text, 40));
  const month = match ? MONTHS.indexOf(match[2]!) + 1 : 0;
  return match && month ? calendarDay(Number(match[3]), month, Number(match[1])) : null;
}

/** The day the order was placed, as the order details give it. */
function orderDayOf($: CheerioAPI): number | null {
  const rows = $('.information_block .clearfix').toArray()
    .filter((row) => clean($(row).children('.pull-left').first().text(), 40) === 'Order Placed On');
  const day = rows.length === 1 ? dayOf($(rows[0]).find('.right_info').first().text()) : null;
  return day ? firstOccurrence(DateTime.fromISO(day, { zone: ZONE })).toMillis() : null;
}

interface Row {
  readonly description: string;
  readonly location: string;
  readonly day: string;
  readonly clock: string;
}

/** The text after a row's label, "Activity :" or "Location :", bold or not as the merchant's page template has it. */
function labelled($: CheerioAPI, item: ReturnType<CheerioAPI>, label: string): string {
  const spans = item.children('span').toArray().filter((span) => clean($(span).contents().not('activity').text(), 40) === label);
  if (spans.length > 1) throw new SchemaError(PROVIDER, `Shiprocket returned a scan with two ${label} fields`);
  return spans.length ? clean($(spans[0]).children('activity').text(), 300) : '';
}

/** The history's rows, newest first. */
function rowsOf($: CheerioAPI): Row[] {
  const lists = $('.delievery_list_wrap > ul');
  if (lists.length !== 1) throw new SchemaError(PROVIDER, 'Shiprocket returned a page without its history');
  const items = lists.children('li');
  if (items.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Shiprocket returned an oversized history');
  return items.toArray().map((node) => {
    const item = $(node);
    const description = labelled($, item, 'Activity :');
    const date = item.children('.date_info_wrap, .date_for_activities');
    const day = clean(date.children('.date').text(), 20);
    const clock = clean(date.children('.time').text(), 20);
    if (!description || date.length !== 1 || !DAY.test(day) || !CLOCK.test(clock)) {
      throw new SchemaError(PROVIDER, 'Shiprocket returned an invalid scan');
    }
    return { description, location: labelled($, item, 'Location :'), day, clock };
  });
}

/**
 * A row's day and clock, read on India's clock; a wall clock abroad keeps only
 * its digits. The page gives a day and month without a year; the order's day
 * sets it, as scans come after the order. Without one, the year is the latest
 * that puts the row no later than the day after the read.
 */
function wallClock(row: Row, after: number | null, readAt: number): DateTime {
  const [, date, monthName] = DAY.exec(row.day)!;
  const [, hourText, minute, half] = CLOCK.exec(row.clock)!;
  const hour = Number(hourText);
  if (hour < 1 || hour > 12 || Number(minute) > 59) throw new SchemaError(PROVIDER, 'Shiprocket returned an invalid scan time');
  const month = MONTHS.indexOf(monthName!) + 1;
  const at = (year: number) => {
    const day = calendarDay(year, month, Number(date));
    return day ? firstOccurrence(DateTime.fromISO(`${day}T${pad((hour % 12) + (half === 'PM' ? 12 : 0))}:${minute}:00`, { zone: ZONE })) : null;
  };
  const reference = DateTime.fromMillis(after ?? readAt + DAY_MS, { zone: ZONE });
  for (const year of after === null ? [reference.year, reference.year - 1] : [reference.year, reference.year + 1]) {
    const wall = at(year);
    if (wall?.isValid && (after === null ? wall.toMillis() <= readAt + DAY_MS : wall.toMillis() >= after)) return wall;
  }
  // 29 February in a year that has none.
  throw new SchemaError(PROVIDER, 'Shiprocket returned an invalid scan date');
}

const wording = (description: string) => description.toLowerCase().split(/\s+/).join(' ');

/**
 * Whether a row's clock is India's: every row of a courier within India, and
 * otherwise a row placed in India or one of Shiprocket's own.
 */
function indiaClock(row: Row, domestic: boolean): boolean {
  return domestic || OWN_ROWS.has(wording(row.description)) || (row.location !== '' && placedInIndia(row.location));
}

function eventOf(row: Row, wall: DateTime, domestic: boolean): CarrierEvent {
  const staged = shiprocketStage(row.description);
  // A row at midnight, such as the order's, gives its day only. Rows abroad
  // keep their wall clock: their zones are their partners', and the page names none.
  const clock = row.clock === '12:00 AM' ? { local_time: wall.toISODate()! }
    : indiaClock(row, domestic) ? { time: wall.toISO({ suppressMilliseconds: true, includeOffset: true })! }
      : { local_time: wall.toFormat("yyyy-MM-dd'T'HH:mm:ss") };
  // The order's place is the buyer's, not the parcel's.
  const location = wording(row.description) === ORDER_ROW ? '' : row.location;
  return {
    ...clock,
    description: row.description,
    ...(location ? { location } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/** The service the page names beside the AWB, such as "SRX Economy", in either of the page's templates. */
function serviceOf($: CheerioAPI): string {
  return clean($('.courier_info .pull-left span b').first().text(), 80) || clean($('.courier_info .courier-name').first().text(), 80);
}

export interface ShiprocketPage {
  readonly result: CarrierResult;
  /** Shiprocket's id for the order, which its delivery estimate is asked by; never returned. */
  readonly orderId: string | null;
}

// The archived view's AWB: its last characters masked, five as seen.
const MASKED = /^([A-Z0-9]+)(\*{1,5})$/;

/**
 * The view Shiprocket gives an older shipment: its last status and that
 * status's day, its service and its AWB, shown with the last characters masked
 * and held whole for the buyer's check. The rows are shown only to the buyer,
 * after a code sent to their phone.
 */
function archivedOf($: CheerioAPI, number: string): CarrierResult | null {
  const sections = $('.tracking-card .status-section');
  if (!sections.length) return null;
  const held = $('#verifyContext');
  const shown = $('.tracking-id-value').toArray().map((node) => clean($(node).text(), 64).replace(/\s+/g, '').toUpperCase());
  const text = clean(sections.first().children('.status-value').first().text(), 80);
  const masked = shown.length === 1 ? MASKED.exec(shown[0]!) : null;
  if (sections.length !== 1 || held.length !== 1 || !text || !masked) {
    throw new SchemaError(PROVIDER, 'Shiprocket returned an archived page without its status or AWB');
  }
  if (normalizeTrackingNumber(clean(held.attr('data-awb'), 64)) !== number || shown[0]!.length !== number.length || !number.startsWith(masked[1]!)) {
    throw new IndeterminateError(PROVIDER, 'Shiprocket answered for another shipment');
  }
  const day = dayOf(sections.first().children('.delivered-date').first().text());
  const staged = shiprocketStage(text);
  const service = clean($('.courier-inline .courier-name').first().text(), 80);
  return {
    status: staged ? languageStageStatus(staged.stage) : 'unknown',
    ...(staged ? { current_stage: staged.stage, current_stage_source: staged.source } : {}),
    last_status_text: text,
    last_update: null,
    ...(day ? { last_update_local: day } : {}),
    expected_delivery: null,
    ...(service ? { service_name: service } : {}),
    summary_only: true,
    events: [],
  };
}

/** The answer for an unknown AWB: HTTP 400 and Shiprocket's "AWB Not Found" page. */
export function isShiprocketNotFound(html: string): boolean {
  const $ = load(html);
  return clean($('title').first().text(), 80) === 'AWB Not Found - Shiprocket' && clean($('.error-title').first().text(), 80) === 'AWB Not Found';
}

/**
 * The page `shiprocket.co/tracking/{awb}` serves: the merchant's tracking page
 * with the shipment's status, its courier and its rows, newest first, or the
 * archived view of an older shipment. The page counts only when the AWB it
 * shows is the one asked. The merchant, the order's reference and contents,
 * the buyer and the map of the delivery address are never read.
 */
export function parseShiprocket(html: string, raw: string, readAt = Date.now()): ShiprocketPage {
  const number = normalizeShiprocketNumber(raw);
  if (SHIPROCKET_CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Shiprocket answered with a browser check');
  const $ = load(html);
  const archived = archivedOf($, number);
  if (archived) return { result: archived, orderId: null };
  const awb = $('input#awb');
  const shown = $('.tracking_id').toArray().map((node) => normalizeTrackingNumber(clean($(node).text(), 64)));
  if (awb.length !== 1 || !shown.length) {
    if (isShiprocketNotFound(html)) throw new IndeterminateError(PROVIDER, 'Shiprocket answered its not-found page without its not-found status');
    throw new SchemaError(PROVIDER, 'Shiprocket returned a page without a shipment');
  }
  if (normalizeTrackingNumber(clean(awb.attr('value'), 64)) !== number || shown.some((value) => value !== number)) {
    throw new IndeterminateError(PROVIDER, 'Shiprocket answered for another shipment');
  }
  const rows = rowsOf($);
  if (!rows.length) throw new NoHistoryError(PROVIDER);
  const ordered = orderDayOf($);
  const after = ordered === null ? null : ordered - ORDER_SLACK_MS;
  const service = serviceOf($);
  const domestic = DOMESTIC.some((name) => townKey(service).startsWith(name));

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    const key = JSON.stringify(row);
    if (seen.has(key)) continue;
    seen.add(key);
    const wall = wallClock(row, after, readAt);
    // A row dated after the read is not a scan yet; a wall clock abroad may be ahead of India's.
    if (wall.toMillis() > readAt + (indiaClock(row, domestic) ? 0 : AHEAD_MS)) continue;
    events.push(eventOf(row, wall, domestic));
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);

  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const orderId = clean($('input#order_id').attr('value'), 32);
  return {
    result: {
      status: stage ? languageStageStatus(stage) : 'unknown',
      ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
      last_status_text: newest.description!,
      last_update: newest.time ?? null,
      ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
      expected_delivery: null,
      ...(stage === 'delivered' && current!.time ? { delivered_at: current!.time } : {}),
      ...(service ? { service_name: service } : {}),
      events: events.slice(0, MAX_EVENTS),
      ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
    },
    orderId: /^\d{1,20}$/.test(orderId) ? orderId : null,
  };
}

/**
 * The day of the delivery estimate the page loads from
 * `apiv2.shiprocket.co/pocx/tracking-order-edd/{order id}`, as `YYYY-MM-DD`, or
 * null when it gives none.
 */
export function parseShiprocketEstimate(payload: unknown): string | null {
  if (!isRecord(payload) || !isRecord(payload.current_etd_1)) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2}) /.exec(clean(payload.current_etd_1.date, 40));
  return match ? calendarDay(Number(match[1]), Number(match[2]), Number(match[3])) : null;
}
