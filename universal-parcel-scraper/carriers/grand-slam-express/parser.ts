import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { calendarDay, countryCode } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { grandSlamStage } from './status.js';

export const PROVIDER = 'Grand Slam Express';
/** The lookup the tracking page's script posts the number to. */
export const GRAND_SLAM_LOOKUP = 'https://www.grandslamexpress.in/Web/AwbNoTracking';
// A shipment's reply is about four kilobytes, and each scan adds about a hundred bytes.
export const GRAND_SLAM_MAX_BYTES = 512 * 1024;

// An AWB number: nine digits, as on the tracker's archived lookup.
const NUMBER = /^\d{9}$/;
// The lookup's message for a nine-digit number it holds no shipment under.
const NOT_FOUND = /^Please enter valid AWB number\s*!?$/i;
// The heading's "AWB No. : 000000000".
const AWB = /\bAWB No\.?\s*:\s*([A-Za-z0-9]{1,64})(?![A-Za-z0-9])/i;
// A scan's clock, "26-Oct-2026 13:04"; the day alone is accepted too.
const CLOCK = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// The history's columns, by their headings.
const COLUMNS = {
  date: /^date$/i,
  location: /^location$/i,
  activity: /^activit(?:y|ies)$/i,
} as const;
type Column = keyof typeof COLUMNS;
// A delivery can name who took the parcel after its wording, and a delivery round the staff member.
const NAMED_AFTER = /^(.*?\b(?:delivered|out for delivery))\b[\s\S]*$/i;
// A run of nine or more digits, with spaces, brackets, dots or hyphens between them, as phone numbers are written.
const PHONE = /(?<!\d)\+?\d(?:[\s().-]{0,2}\d){8,}(?!\d)/g;
const MAX_ROWS = 300;

/** A Grand Slam Express AWB number: nine digits. Anything else is not one the adapter asks for. */
export function normalizeGrandSlamNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Grand Slam Express AWB numbers are nine digits');
  return number;
}

function invalid(message: string): never {
  throw new SchemaError(PROVIDER, message);
}

/** An element's text, with a space where its elements meet so that their words stay apart. */
function textOf(element: Cheerio<AnyNode>, limit: number): string {
  const spaced = element.clone();
  spaced.find('*').append(' ');
  return clean(spaced.text(), limit);
}

/**
 * A scan's wall clock, or its day when it is at midnight, which the service
 * prints for a day entered without a time. The reply names no zone, and some
 * scans are at hubs abroad, so the clock keeps no offset.
 */
function clockOf(text: string): string {
  const match = CLOCK.exec(text);
  const month = match ? MONTHS.indexOf(match[2]!.toLowerCase()) + 1 : 0;
  const day = match && month ? calendarDay(Number(match[3]), month, Number(match[1])) : null;
  if (!day) invalid('Grand Slam Express returned an invalid scan time');
  const [hour, minute, second] = [match![4], match![5], match![6]].map((part) => (part === undefined ? 0 : Number(part)));
  if (hour! > 23 || minute! > 59 || second! > 59) invalid('Grand Slam Express returned an invalid scan time');
  if (!hour && !minute && !second) return day;
  return `${day}T${[hour, minute, second].map((part) => String(part).padStart(2, '0')).join(':')}`;
}

/** A scan's wording without phone numbers; a delivery or a delivery round loses the name after it. */
export function grandSlamWording(activity: string): string {
  const kept = NAMED_AFTER.exec(activity)?.[1] ?? activity;
  return clean(kept.replace(PHONE, ' '), 200).replace(/^[\s,;:.\-–]+|[\s,;:\-–]+$/g, '');
}

/** The cells of a table row, as text. */
function cellsOf($: CheerioAPI, row: Element, tag: 'td' | 'th'): string[] {
  return $(row).children(tag).toArray().map((cell) => textOf($(cell), 300));
}

/** The column of each heading the history is read by; null when the table is not the history. */
function columnsOf(headings: readonly string[]): Map<Column, number> | null {
  const columns = new Map<Column, number>();
  headings.forEach((heading, index) => {
    for (const [column, pattern] of Object.entries(COLUMNS) as [Column, RegExp][]) {
      if (!pattern.test(heading)) continue;
      if (columns.has(column)) invalid('Grand Slam Express repeated a column of its history');
      columns.set(column, index);
    }
  });
  return columns.has('date') && columns.has('activity') ? columns : null;
}

/** The history's scans in the reply's order, once each. A shipment without a history table has none. */
function historyOf($: CheerioAPI, details: Cheerio<Element>): CarrierEvent[] {
  const tables = details.find('.packet-history table');
  if (tables.length > 1) invalid('Grand Slam Express returned several histories for the shipment');
  if (!tables.length) return [];
  const heading = tables.find('thead tr').first();
  const columns = heading.length ? columnsOf(cellsOf($, heading[0]!, 'th')) : null;
  if (!columns) invalid('Grand Slam Express changed its history');
  const width = heading.children('th').length;
  const rows = tables.find('tbody tr').toArray();
  if (rows.length > MAX_ROWS) invalid('Grand Slam Express returned an oversized history');
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    const cells = cellsOf($, row, 'td');
    if (!cells.length) continue;
    if (cells.length !== width) invalid('Grand Slam Express changed its history');
    const at = (column: Column) => (columns.has(column) ? cells[columns.get(column)!]! : '');
    const local = clockOf(at('date'));
    const description = grandSlamWording(at('activity'));
    if (!description) invalid('Grand Slam Express returned a scan without its activity');
    const location = clean(at('location'), 120);
    const staged = grandSlamStage(description);
    const key = JSON.stringify([local, location, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push({
      local_time: local,
      ...(location ? { location } : {}),
      description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    });
  }
  return events;
}

/** The value of a row of the shipment's "Packet Status" table, by its heading. */
function detail($: CheerioAPI, details: Cheerio<Element>, label: string): string {
  const row = details.find('tr').toArray().find((candidate) => clean($(candidate).children('th').first().text(), 80).toLowerCase() === label);
  return row ? clean($(row).children('td').first().text(), 120) : '';
}

/** The shipment block of the reply's HTML, bound to the number asked. */
function shipmentOf($: CheerioAPI, number: string): { status: string; details: Cheerio<Element> } {
  const headings = $('.track-top');
  if (!headings.length) invalid('Grand Slam Express returned a reply without a shipment');
  if (headings.length > 1) throw new IndeterminateError(PROVIDER, 'Grand Slam Express listed several shipments for the number');
  const summary = textOf(headings.find('ul'), 1000);
  if (summary.length >= 1000) invalid('Grand Slam Express returned an oversized shipment heading');
  const shown = AWB.exec(summary)?.[1];
  if (!shown) invalid('Grand Slam Express returned a shipment without its AWB number');
  const details = $('[id^="track-data"]');
  if (details.length !== 1) invalid('Grand Slam Express returned a shipment without its details');
  // The heading and the details' anchor both carry the AWB number the shipment is filed under.
  if (normalizeTrackingNumber(shown) !== number || details.attr('id') !== `track-data${number}`) {
    throw new IndeterminateError(PROVIDER, 'Grand Slam Express answered for another shipment');
  }
  return { status: clean(headings.children('a').first().text(), 120), details };
}

/**
 * The reply of `Web/AwbNoTracking` for one AWB number: `Error`, empty for a
 * shipment, and `Result`, the HTML the page shows. A shipment has a heading
 * with its status, AWB number, reference, booking day and piece count, then its
 * origin and destination and its history, newest first. A number without a
 * shipment gets the message "Please enter valid AWB number!" and no HTML. The
 * reference, origin, booking day and piece count are not read.
 */
export function parseGrandSlam(payload: unknown, raw: string): CarrierResult {
  const number = normalizeGrandSlamNumber(raw);
  if (!isRecord(payload) || typeof payload.Error !== 'string') invalid('Grand Slam Express returned an invalid reply');
  const html = payload.Result ?? '';
  if (typeof html !== 'string') invalid('Grand Slam Express returned an invalid result');
  const error = clean(payload.Error, 200);
  if (error) {
    if (NOT_FOUND.test(error) && !html.trim()) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Grand Slam Express answered with another message');
  }
  if (!html.trim()) throw new IndeterminateError(PROVIDER, 'Grand Slam Express answered with neither a shipment nor its not-found message');

  const $ = load(html);
  const { status: summary, details } = shipmentOf($, number);
  const events = historyOf($, details);
  if (!events.length && !summary) throw new NoHistoryError(PROVIDER);

  // A delivery in a scan or in the heading settles the shipment: a delivery entered
  // without a time sorts at midnight, below that day's other scans. Otherwise the
  // newest staged scan does, else the heading.
  const delivery = events.find((event) => event.stage === 'delivered');
  const headline = summary ? grandSlamStage(summary) : null;
  const staged = events.find((event) => event.stage);
  const row: ClassifiedWording | null = staged ? { stage: staged.stage as Stage, source: staged.stage_source! } : null;
  const fromSummary = !delivery && headline !== null && (headline.stage === 'delivered' || !row);
  const decided = delivery ? { stage: 'delivered' as Stage, source: delivery.stage_source! } : fromSummary ? headline : row;
  const newest = events[0];
  const country = countryCode(detail($, details, 'destination'));
  return {
    status: decided ? languageStageStatus(decided.stage) : 'unknown',
    ...(decided ? { current_stage: decided.stage, current_stage_source: decided.source } : {}),
    last_status_text: (fromSummary ? summary : (delivery ?? newest)?.description ?? summary) || null,
    last_update: null,
    ...(newest ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    ...(country ? { destination_country: country } : {}),
    ...(events.length ? {} : { summary_only: true }),
    events,
  };
}
