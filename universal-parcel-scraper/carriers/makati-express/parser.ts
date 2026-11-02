import { load, type CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { MAKATI_EXPRESS_FORECAST, makatiExpressStage } from './status.js';

export const PROVIDER = 'Makati Express Cargo';
// The page is about 150 kB, nearly all of it the site's theme.
export const MAKATI_EXPRESS_MAX_BYTES = 1024 * 1024;
// The sending branch's three-letter code, then the AWB serial: seven or eight
// digits on the numbers seen, with room for other branches' serials.
const NUMBER = /^[A-Z]{3}\d{6,9}$/;
// The tracker's answer for a number no branch has uploaded.
const NOT_FOUND = /Data not found/i;
// Bot checks a CDN, firewall or the site's anti-spam plugin could put in place of the page.
const CHALLENGE = /SpamFireWall|_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied)|Sucuri WebSite Firewall|g-recaptcha|h-captcha/i;
const HEADERS = ['#', 'Date', 'Activity', 'Customer Note'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
// A run of nine or more digits, with spaces, brackets, dots or hyphens
// between them, as phone numbers are written.
const PHONE = /(?<![A-Z\d])\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
// Who took the box, after a delivery's wording.
const RECEIVER = /\s*[,;:.\-–]?\s*\b(?:to|by)\b[\s\S]*$/i;
const DELIVERY = /^(?:BOX\s+)?DELIVERED\b/i;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A Makati Express AWB with its branch code, in capitals as the tracker prints it; anything else is not one it issues. */
export function normalizeMakatiExpressNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Makati Express AWBs are a three-letter branch code and the AWB serial');
  return number;
}

export function isMakatiExpressChallenge(html: string): boolean {
  return CHALLENGE.test(html.slice(0, 64_000));
}

/** The value beside a label in the shipment's summary; null when the label is not there once. */
function field($: CheerioAPI, label: string): string | null {
  const labels = $('td').filter((_, node) => clean($(node).text(), 80) === label);
  if (labels.length !== 1) return null;
  const value = labels.first().next('td');
  return value.length ? clean(value.text(), 200) : null;
}

/**
 * A row's day. Branches on the older system print `2026-01-31`; the newer
 * one prints `31-January-2026, Saturday`, whose weekday must agree.
 */
function rowDay(text: string): string {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const long = /^(\d{1,2})-([A-Za-z]+)-(\d{4})(?:,\s*([A-Za-z]+))?$/.exec(text);
  const day = iso ? calendarDay(Number(iso[1]), Number(iso[2]), Number(iso[3]))
    : long ? calendarDay(Number(long[3]), MONTHS.indexOf(long[2]!.toLowerCase()) + 1, Number(long[1])) : null;
  const weekday = long?.[4]?.toLowerCase();
  // The calendar day alone, read in UTC for its weekday; the row keeps no clock.
  const actual = day ? WEEKDAYS[DateTime.fromISO(day, { zone: 'UTC' }).weekday - 1] : undefined;
  if (!day || day < '2000-01-01' || (weekday && weekday !== actual)) throw new SchemaError(PROVIDER, 'Makati Express returned an invalid day');
  return day;
}

interface Row { index: number; day: string; activity: string }

/** The progress table's rows, as the page lists them. */
function rows($: CheerioAPI): Row[] {
  const tables = $('table').filter((_, node) => {
    const head = $(node).find('tr').first().children('td, th').map((__, cell) => clean($(cell).text(), 40)).get();
    return head.slice(0, 4).join('|') === HEADERS.join('|') && (head.length === 4 || (head.length === 5 && head[4] === 'Office Note'));
  });
  // The page heads the table with "Shipment Progress of AWB No."; that heading over no table read here is a changed table.
  const headed = $('strong').filter((_, node) => /^Shipment Progress of AWB No\./i.test(clean($(node).text(), 80))).length > 0;
  if (tables.length > 1 || (headed && !tables.length)) throw new SchemaError(PROVIDER, 'Makati Express progress table changed');
  if (!tables.length) return [];
  const lines = tables.first().find('tr').slice(1);
  if (lines.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Makati Express returned an oversized history');
  const width = tables.first().find('tr').first().children('td, th').length;
  return lines.toArray().map((line) => {
    const cells = $(line).children('td').toArray().map((cell) => clean($(cell).text(), 300));
    const index = /^\d{1,4}$/.test(cells[0] ?? '') ? Number(cells[0]) : Number.NaN;
    if (cells.length !== width || !Number.isInteger(index) || !cells[2]) throw new SchemaError(PROVIDER, 'Makati Express progress table changed');
    return { index, day: rowDay(cells[1]!), activity: cells[2] };
  });
}

/** An activity's wording, without phone numbers or who took a delivered box. */
function wording(activity: string): string {
  const own = (DELIVERY.test(activity) ? activity.replace(RECEIVER, '') : activity).replace(PHONE, '');
  return clean(own.replace(/\s+([,;:.])/g, '$1'), 300).replace(/^[\s,;:.\-–]+|[\s,;:\-–]+$/g, '');
}

/**
 * The tracking page after its form posted one AWB. A known AWB adds a summary
 * (the booking day, shipper, consignee, their city, the box count, a status,
 * the delivery day and who received it) and the progress table, one day and
 * activity per row, numbered from the oldest. Only the progress is kept. An
 * unknown AWB adds the tracker's "Data not found" line. Either names the AWB,
 * which must be the one asked.
 */
export function parseMakatiExpress(html: string, raw: string): CarrierResult {
  const number = normalizeMakatiExpressNumber(raw);
  if (isMakatiExpressChallenge(html)) throw new ChallengeError(PROVIDER, 'Makati Express answered with a browser check');
  const $ = load(html);
  const awb = field($, 'AWB No.');
  if (awb === null) {
    const notices = $('h4').filter((_, node) => NOT_FOUND.test($(node).text()));
    if (notices.length !== 1) throw new SchemaError(PROVIDER, 'Makati Express returned a page without an answer');
    if (clean(notices.first().find('b').first().text(), 64).toUpperCase() !== number) {
      throw new IndeterminateError(PROVIDER, 'Makati Express answered for another AWB');
    }
    throw new NotFoundError(PROVIDER);
  }
  if (awb.toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'Makati Express answered for another AWB');

  const seen = new Set<string>();
  const kept: (Row & { event: CarrierEvent })[] = [];
  for (const row of rows($)) {
    const description = wording(row.activity);
    if (!description) throw new SchemaError(PROVIDER, 'Makati Express returned a row without an activity');
    if (MAKATI_EXPRESS_FORECAST.test(description)) continue;
    const key = JSON.stringify([row.day, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = makatiExpressStage(description);
    kept.push({ ...row, event: {
      local_time: row.day,
      description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  }
  // Newest first; the page numbers its rows from the oldest.
  const newestFirst = kept.length > 1 && kept[0]!.index < kept.at(-1)!.index ? kept.reverse() : kept;
  const events = newestFirst.map((row) => row.event);

  const status = wording(field($, 'Status') ?? '');
  if (!events.length) {
    // A booking without progress yet: the summary's status is all there is.
    if (!status || MAKATI_EXPRESS_FORECAST.test(status)) throw new NoHistoryError(PROVIDER);
    const staged = makatiExpressStage(status);
    return {
      status: staged ? languageStageStatus(staged.stage) : 'unknown',
      ...(staged ? { current_stage: staged.stage, current_stage_source: staged.source } : {}),
      last_status_text: status,
      last_update: null,
      expected_delivery: null,
      summary_only: true,
      events: [],
    };
  }
  const newest = events[0]!;
  const decider = events.find((event) => event.stage);
  const stage = decider?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: decider!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
