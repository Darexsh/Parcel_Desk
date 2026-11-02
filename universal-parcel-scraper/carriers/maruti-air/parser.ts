import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { calendarDay, firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { marutiAirStage } from './status.js';

export const PROVIDER = 'Maruti Air';
/** The tracker www.marutiair.com frames, which looks up the document number in its `AWB` parameter on the server. */
export const MARUTI_AIR_TRACKER = 'https://erp.marutiair.com/TrackpageWeb/WebAWBTracking.aspx';
// The page for an unknown number is under five kilobytes; a found one can hold a delivery image.
export const MARUTI_AIR_MAX_BYTES = 3 * 1024 * 1024;
// Maruti Air carries documents and parcels between its branches in India, which keeps one clock.
const INDIA_ZONE = 'Asia/Kolkata';

// A document number: a plain digit run. Customers quote eight or nine digits; a printed waybill has ten.
const NUMBER = /^\d{8,10}$/;
// The tracker's notice for a number it holds nothing under; the number stays in the field.
const NOT_FOUND = /^DETAIL NOT FOUND\s*!?$/i;
// The label before the summary's status: "Status :" or "Current Status".
const STATUS_LABEL = /^(?:(?:current|shipment|shipping)\s+)?status\s*[:.-]?\s*/i;
const DIGITS = /\d{6,}/g;
// A day as Indian branches write it, "13/10/2026", "13-10-2026", "13-Oct-2026" or "13 Oct 2026", or "2026-10-13".
const NUMERIC_DAY = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/;
const NAMED_DAY = /^(\d{1,2})[ -]([A-Za-z]{3,9})\.?[ -](\d{4})$/;
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// A time: "14:05", "14:05:00" or "2:05 PM", alone or after the day in one cell.
const CLOCK = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([AP])\.?M\.?)?$/i;
const DAY_AND_CLOCK = /^(.+?)\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]\.?M\.?)?)$/i;
// The history's columns, by their headings. Other columns, such as who received the document, are not read.
const COLUMNS = {
  date: /^(?:date|scan date|activity date|date\s*(?:&|and|\/)\s*time)$/i,
  time: /^(?:time|scan time|activity time)$/i,
  location: /^(?:location|branch|office|city|place|centre|center|hub)(?:\s+name)?$/i,
  activity: /^(?:activity|status|event|description|details|particulars|tracking status)$/i,
} as const;
type Column = keyof typeof COLUMNS;
// A delivery row names whoever received it after the wording, and an out-for-delivery row the delivery staff.
const NAMED_AFTER = /^(delivered|out for delivery)\b/i;
// Firewall and bot check pages, which could stand in for the tracker.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|\/cdn-cgi\/challenge-platform\/|_Incapsula_Resource|errors\.edgesuite\.net|requested URL was rejected|g-recaptcha|h-captcha|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)/i;
const MAX_ROWS = 300;

/** A Maruti Air document number: eight to ten digits. Anything else is not one the tracker is asked for. */
export function normalizeMarutiAirNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Maruti Air document numbers are eight to ten digits');
  return number;
}

function invalid(message: string): never {
  throw new SchemaError(PROVIDER, message);
}

/** A day as `YYYY-MM-DD`, or null when it is not one. Numeric days put the day first, as in India. */
function dayOf(text: string): string | null {
  const iso = ISO_DAY.exec(text);
  if (iso) return calendarDay(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const numeric = NUMERIC_DAY.exec(text);
  if (numeric) return calendarDay(Number(numeric[3]), Number(numeric[2]), Number(numeric[1]));
  const named = NAMED_DAY.exec(text);
  const month = named ? MONTHS.indexOf(named[2]!.slice(0, 3).toLowerCase()) + 1 : 0;
  return named && month ? calendarDay(Number(named[3]), month, Number(named[1])) : null;
}

/** A time of day as `HH:mm:ss`, or null when it is not one. */
function timeOf(text: string): string | null {
  const match = CLOCK.exec(text);
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

type Clock = { time: string } | { local_time: string };

/**
 * A row's day and time. Every branch is in India, so a time is an instant on
 * India's clock. A day without a time, or at midnight, which the tracker
 * prints for a day entered without one, keeps only its day.
 */
function clockOf(date: string, time: string): Clock & { wall: string } {
  const joined = time ? null : DAY_AND_CLOCK.exec(date);
  const day = dayOf(joined ? joined[1]! : date);
  const written = joined ? joined[2]! : time;
  const clock = written ? timeOf(written) : null;
  if (!day || (written && !clock)) invalid('Maruti Air returned an invalid scan time');
  if (!clock || clock === '00:00:00') return { local_time: day, wall: day };
  const wall = `${day}T${clock}`;
  const instant = firstOccurrence(DateTime.fromISO(wall, { zone: INDIA_ZONE })).toISO({ suppressMilliseconds: true });
  return instant ? { time: instant, wall } : invalid('Maruti Air returned an invalid scan time');
}

/** An element's text, with a space where its elements meet so that their words stay apart. */
function textOf(element: Cheerio<AnyNode>, limit: number): string {
  const spaced = element.clone();
  spaced.find('*').append(' ');
  return clean(spaced.text(), limit);
}

/** The cells of a table row, as text. */
function cellsOf($: CheerioAPI, row: Element, tag: 'td' | 'th'): string[] {
  return $(row).children(tag).toArray().map((cell) => textOf($(cell), 300));
}

/** The column of each heading the history is read by, from a table's heading row; null when the table is not the history. */
function columnsOf(headings: readonly string[]): Map<Column, number> | null {
  const columns = new Map<Column, number>();
  headings.forEach((heading, index) => {
    for (const [column, pattern] of Object.entries(COLUMNS) as [Column, RegExp][]) {
      if (!pattern.test(heading)) continue;
      if (columns.has(column)) invalid('Maruti Air repeated a column of its history');
      columns.set(column, index);
    }
  });
  return columns.has('date') && columns.has('activity') ? columns : null;
}

interface Row { key: string; wall: string; event: CarrierEvent }

/** The history's rows, newest first and once each. A page without a history has none. */
function historyOf($: CheerioAPI): Row[] {
  const histories = $('table.shipingtable').toArray().flatMap((table) => {
    const rows = $(table).find('tr').toArray();
    const heading = rows.find((row) => $(row).children('th').length && !$(row).children('td').length);
    if (!heading) return [];
    const columns = columnsOf(cellsOf($, heading, 'th'));
    return columns ? [{ rows: rows.filter((row) => row !== heading), width: $(heading).children('th').length, columns }] : [];
  });
  if (histories.length > 1) invalid('Maruti Air returned several histories for the document');
  const history = histories[0];
  if (!history) return [];
  if (history.rows.length > MAX_ROWS) invalid('Maruti Air returned an oversized history');
  const seen = new Set<string>();
  const rows: Row[] = [];
  for (const node of history.rows) {
    const cells = cellsOf($, node, 'td');
    if (!cells.length) continue;
    if (cells.length !== history.width) invalid('Maruti Air changed its history');
    const at = (column: Column) => (history.columns.has(column) ? cells[history.columns.get(column)!]! : '');
    const { wall, ...clock } = clockOf(at('date'), at('time'));
    const activity = at('activity');
    if (!activity) invalid('Maruti Air returned a scan without its activity');
    // The receiver's or the delivery staff's name after the wording is not kept.
    const description = NAMED_AFTER.exec(activity)?.[1] ?? activity;
    const location = at('location');
    const staged = marutiAirStage(description);
    const event: CarrierEvent = {
      ...clock,
      ...(location ? { location } : {}),
      description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    };
    const key = JSON.stringify([wall, location, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ key, wall, event });
  }
  // The newest row comes first; a history listed the other way round is turned round.
  return rows.length > 1 && rows[0]!.wall < rows.at(-1)!.wall ? rows.reverse() : rows;
}

/** The number the tracker's field holds, which it fills with the number it looked up. */
function fieldNumber($: CheerioAPI): string {
  const value = $('#dzName').attr('value') ?? '';
  // A value too long to be one number is compared whole, so a second number cannot hide behind the first.
  return value.length > 64 ? value : normalizeTrackingNumber(value);
}

/** The document numbers the result's heading shows. */
function shownNumbers(block: Cheerio<AnyNode>): string[] {
  const text = textOf(block, 1000);
  if (text.length >= 1000) invalid('Maruti Air returned an oversized document heading');
  return [...new Set(text.match(DIGITS) ?? [])];
}

/**
 * The page `erp.marutiair.com/TrackpageWeb/WebAWBTracking.aspx?AWB=` renders
 * for one document number, as the tracker www.marutiair.com frames posts it
 * too. A number the tracker holds nothing under gets the notice "DETAIL NOT
 * FOUND !" under the form, with the number left in the field. A document is
 * read as the tracker's stylesheet lays one out: a heading with the document
 * number and its status, then its history in a table. Its other details, who
 * sent and received it and the delivery image, are not read.
 */
export function parseMarutiAir(html: string, rawNumber: string): CarrierResult {
  const number = normalizeMarutiAirNumber(rawNumber);
  const $ = load(html);
  if (!$('form#form1 #dzName').length) {
    if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Maruti Air answered with a block page');
    invalid('Maruti Air did not return its tracker');
  }
  const field = fieldNumber($);
  const notices = $('div.alert').toArray().map((alert) => clean($(alert).text(), 120)).filter(Boolean);
  const results = $('.tracking');
  if (notices.some((notice) => NOT_FOUND.test(notice))) {
    if (notices.length > 1 || results.length) invalid('Maruti Air listed a document under its notice');
    if (field !== number) throw new IndeterminateError(PROVIDER, 'Maruti Air answered for another number');
    throw new NotFoundError(PROVIDER);
  }
  if (notices.length) invalid('Maruti Air answered with an unexpected notice');
  if (!results.length) invalid('Maruti Air returned its form without an answer');
  if (results.length > 1) throw new IndeterminateError(PROVIDER, 'Maruti Air listed several documents for the number');

  const shown = shownNumbers(results.find('.billno'));
  if (!shown.length) invalid('Maruti Air returned a document without its number');
  if (shown.length > 1 || shown[0] !== number || (field && field !== number)) {
    throw new IndeterminateError(PROVIDER, 'Maruti Air answered for another document');
  }
  const summary = textOf(results.find('.shippingstatus'), 120).replace(STATUS_LABEL, '');
  const rows = historyOf($);
  const events = rows.map(({ event }) => event);
  if (!events.length && !summary) throw new NoHistoryError(PROVIDER);

  // A delivery in a row or in the summary settles the document; otherwise the newest staged row does, else the summary.
  const delivery = events.find((event) => event.stage === 'delivered');
  const headline = summary ? marutiAirStage(summary) : null;
  const staged = events.find((event) => event.stage);
  const row: ClassifiedWording | null = staged ? { stage: staged.stage as Stage, source: staged.stage_source! } : null;
  const fromSummary = !delivery && headline !== null && (headline.stage === 'delivered' || !row);
  const decided = delivery ? { stage: 'delivered' as Stage, source: delivery.stage_source! } : fromSummary ? headline : row;
  const newest = events[0];
  return {
    status: decided ? languageStageStatus(decided.stage) : 'unknown',
    ...(decided ? { current_stage: decided.stage, current_stage_source: decided.source } : {}),
    last_status_text: (fromSummary ? summary : (delivery ?? newest)?.description ?? summary) || null,
    last_update: newest?.time ?? null,
    ...(newest?.local_time ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    ...(delivery?.time ? { delivered_at: delivery.time } : {}),
    ...(events.length ? {} : { summary_only: true }),
    events,
  };
}
