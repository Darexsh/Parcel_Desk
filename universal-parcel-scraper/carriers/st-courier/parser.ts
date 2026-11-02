import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { stCourierStage } from './status.js';

export const PROVIDER = 'ST Courier';
/** The lookup the tracking form posts the number to; it files the number in the visitor's session. */
export const ST_COURIER_CHECK = 'https://stcourier.com/track/doCheck';
/** The result page the form opens next, which shows the number filed in the session. */
export const ST_COURIER_RESULT = 'https://stcourier.com/track/shipment';
// The page is about forty kilobytes, and each scan adds one or two.
export const ST_COURIER_MAX_BYTES = 512 * 1024;

// Eleven digits, the first not a zero: the tracker refuses any other number as "not in the correct format".
const NUMBER = /^[1-9]\d{10}$/;
// Every scan is at an ST Courier branch or hub in India, which keeps UTC+5:30 all year.
const ZONE = 'Asia/Kolkata';
// A scan's day and clock, as "Sep 25, 2025" and "07:24 PM".
const SCAN_DAY = /^[A-Z][a-z]{2} \d{2}, \d{4}$/;
const SCAN_CLOCK = /^\d{2}:\d{2} [AP]M$/;
// The summary's delivery time, as "11-04-2026 8:09 PM", day first.
const SUMMARY_CLOCK = /^\d{2}-\d{2}-\d{4} \d{1,2}:\d{2} [AP]M$/;
const RESULT = /^Status of AWB No\.\s*(\S{1,64})$/;
// The page's answer for a number it has no consignment for, which names the number.
const NOT_FOUND = /^Sorry, Invalid AWB Number\.*!?\s*\((\S{0,64})\)$/;
// Bot checks a CDN or firewall could put in place of the page or the reply. The result
// page's own complaint form carries a reCAPTCHA, so a captcha alone is no bot check.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|_Incapsula_Resource|AwsWafIntegration|captcha-delivery/i;
// A branch or hub and its state's code, as "Sample hub, TN". A line of another shape can name a person, so it is not kept.
const PLACE = /^[A-Za-z][A-Za-z0-9 .&()'/-]{0,80}, [A-Z]{2}$/;
// "Delivered to SAMPLE NAME": the name of who took the parcel follows the wording.
const DELIVERED_TO = /^(Delivered)\s+to\b[\s\S]*$/i;
// A run of nine or more digits, with spaces, brackets, dots or hyphens between them, as phone numbers are written.
const PHONE = /(?<!\d)\+?\d(?:[\s().-]{0,2}\d){8,}(?!\d)/g;
const MAX_ROWS = 300;
const MAX_EVENTS = 100;

/** An ST Courier AWB number: eleven digits, the first not a zero. Anything else is not one its tracker takes. */
export function normalizeStCourierNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'ST Courier AWB numbers are eleven digits');
  return number;
}

/** Whether a page or reply is a bot check instead of ST Courier's own. */
export function isStCourierChallenge(body: string): boolean {
  return CHALLENGE.test(body.slice(0, 64_000));
}

/** The lines of a cell, split where the page breaks them, without the empty ones. */
function lines(cell: Cheerio<Element>): string[] {
  const copy = cell.clone();
  copy.find('br').replaceWith('\n');
  return copy.text().split('\n').map((line) => clean(line, 300)).filter(Boolean);
}

/** A wall clock read in India and read back unchanged, as an instant. */
function indianTime(local: string, format: string): string | null {
  const wall = firstOccurrence(DateTime.fromFormat(local, format, { zone: ZONE, locale: 'en-US' }));
  // Luxon rolls an impossible day over; only a clock that reads back unchanged is kept.
  if (!wall.isValid || wall.toFormat(format, { locale: 'en-US' }) !== local) return null;
  return wall.toUTC().toISO({ suppressMilliseconds: true });
}

/** A scan's wording without phone numbers; a delivery loses the name of who took the parcel. */
export function stCourierWording(wording: string): string {
  return clean(wording.replace(DELIVERED_TO, '$1').replace(PHONE, ''), 200).replace(/^[\s,;:.\-–]+|[\s,;:\-–]+$/g, '');
}

interface Scan { event: CarrierEvent; at: string; index: number; key: string }

/** One row of the timeline: its clock, an icon, then the wording over the branch or hub. */
function projectRow($: CheerioAPI, row: Element, index: number): Scan {
  const cells = $(row).children('div');
  if (cells.length !== 3) throw new SchemaError(PROVIDER, 'ST Courier returned an incomplete scan');
  const [day, clock, ...rest] = lines(cells.first());
  if (!day || !clock || rest.length || !SCAN_DAY.test(day) || !SCAN_CLOCK.test(clock)) {
    throw new SchemaError(PROVIDER, 'ST Courier returned an invalid scan time');
  }
  const time = indianTime(`${day} ${clock}`, 'MMM dd, yyyy hh:mm a');
  if (!time) throw new SchemaError(PROVIDER, 'ST Courier returned an invalid scan time');
  // Lines after the place are not read.
  const [wording = '', second = ''] = lines(cells.last());
  const description = stCourierWording(wording);
  if (!description) throw new SchemaError(PROVIDER, 'ST Courier returned a scan without wording');
  const location = PLACE.test(second) ? second : '';
  const staged = stCourierStage(description);
  const event: CarrierEvent = {
    time,
    ...(location ? { location } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { event, at: time, index, key: JSON.stringify([time, description, location]) };
}

/** The summary table's rows, by label. */
function summaryFields($: CheerioAPI): Map<string, string> {
  const tables = $('table').filter((_, table) => $(table).find('th').toArray().some((th) => clean($(th).text(), 60) === 'Delivery Status'));
  if (tables.length !== 1) throw new SchemaError(PROVIDER, 'ST Courier returned no shipment summary');
  const fields = new Map<string, string>();
  tables.find('tbody tr').each((_, row) => {
    const cells = $(row).children('td');
    if (!cells.length) return;
    if (cells.length !== 2) throw new SchemaError(PROVIDER, 'ST Courier returned an invalid summary row');
    const label = clean(cells.eq(0).text(), 60);
    if (fields.has(label)) throw new SchemaError(PROVIDER, 'ST Courier returned ambiguous summary fields');
    fields.set(label, clean(cells.eq(1).text(), 120));
  });
  return fields;
}

/**
 * The tracker's result page for the number filed in the session. A number it
 * knows gets "Status of AWB No." with its scans, newest first, beside a summary;
 * an unknown one gets "Sorry, Invalid AWB Number..!" with the number. Both name
 * the number, which must be the one asked. The summary's branches, the
 * consignment's kind and count, the booking time and the complaint form are
 * not read.
 */
export function parseStCourier(html: string, raw: string): CarrierResult {
  const number = normalizeStCourierNumber(raw);
  const $ = load(html);
  if (!$('form#track_form').length) {
    if (isStCourierChallenge(html)) throw new ChallengeError(PROVIDER, 'ST Courier answered with a browser check');
    throw new SchemaError(PROVIDER, 'ST Courier returned a page without its tracker');
  }

  const missing = $('h4.text-danger').toArray().map((heading) => NOT_FOUND.exec(clean($(heading).text(), 200))).find(Boolean);
  if (missing) {
    if (normalizeTrackingNumber(missing[1]!) !== number) throw new IndeterminateError(PROVIDER, 'ST Courier answered for another shipment');
    throw new NotFoundError(PROVIDER);
  }
  const headings = $('h4').filter((_, heading) => RESULT.test(clean($(heading).text(), 200)));
  // The page shows neither when the session holds no lookup.
  if (!headings.length) throw new IndeterminateError(PROVIDER, 'ST Courier showed no lookup for the session', { reason: 'session_rejected' });
  if (headings.length > 1) throw new SchemaError(PROVIDER, 'ST Courier returned ambiguous shipments');
  const shown = RESULT.exec(clean(headings.text(), 200))![1]!;
  const filed = clean($('input[name="awb_no_comp"]').attr('value'), 64);
  if (normalizeTrackingNumber(shown) !== number || (filed && normalizeTrackingNumber(filed) !== number)) {
    throw new IndeterminateError(PROVIDER, 'ST Courier answered for another shipment');
  }

  const rows = headings.nextAll('div').first().children('div').toArray();
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'ST Courier returned an oversized history');
  const seen = new Set<string>();
  const scans: Scan[] = [];
  rows.forEach((row, index) => {
    const scan = projectRow($, row, index);
    if (seen.has(scan.key)) return;
    seen.add(scan.key);
    scans.push(scan);
  });
  // Newest first; scans on one minute keep the page's order, which is newest first too.
  const events = scans.sort((a, b) => (a.at === b.at ? a.index - b.index : a.at < b.at ? 1 : -1)).map(({ event }) => event);

  // A consignment the page has no booking for gets "In Transit" and empty
  // booking fields whatever its scans say, so only a booked summary counts.
  const fields = summaryFields($);
  const booked = ['Orgin SRC', 'Origin SRC', 'Destination', 'Consignment'].some((label) => fields.get(label));
  const summary = booked ? fields.get('Current Status') ?? '' : '';
  const summed = summary ? stCourierStage(summary) : null;
  // The summary's word stands for a delivery or a return, which the history can lack.
  const final = summed?.stage === 'delivered' || summed?.stage === 'returned' ? summed : null;
  const clock = final?.stage === 'delivered' ? fields.get('Delivery Date/Time') ?? '' : '';
  const deliveredOn = clock && SUMMARY_CLOCK.test(clock) ? indianTime(clock, 'dd-MM-yyyy h:mm a') : null;
  if (clock && !deliveredOn) throw new SchemaError(PROVIDER, 'ST Courier returned an invalid delivery time');

  if (!events.length) {
    if (!summary) throw new NoHistoryError(PROVIDER);
    return {
      status: summed ? languageStageStatus(summed.stage) : 'unknown',
      ...(summed ? { current_stage: summed.stage, current_stage_source: summed.source } : {}),
      last_status_text: summary,
      last_update: deliveredOn,
      expected_delivery: null,
      ...(deliveredOn ? { delivered_at: deliveredOn } : {}),
      timezone: ZONE,
      summary_only: true,
      events: [],
    };
  }

  const newest = events[0]!;
  const ending = final ? events.find((event) => event.stage === final.stage) : undefined;
  const current = final ? undefined : events.find((event) => event.stage);
  const stage = (final?.stage ?? current?.stage ?? summed?.stage) as Stage | undefined;
  const source = final?.source ?? current?.stage_source ?? summed?.source;
  const delivered = stage === 'delivered' ? deliveredOn ?? events.find((event) => event.stage === 'delivered')?.time : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source! } : {}),
    last_status_text: final ? ending?.description ?? summary : newest.description!,
    last_update: deliveredOn && deliveredOn > newest.time! ? deliveredOn : newest.time!,
    expected_delivery: null,
    ...(delivered ? { delivered_at: delivered } : {}),
    timezone: ZONE,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
