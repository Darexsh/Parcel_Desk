import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { straightshipStage } from './status.js';

export const PROVIDER = 'Straightship';
// A page is about 10 kB; a long history of delivery attempts doubles it.
export const STRAIGHTSHIP_MAX_BYTES = 512 * 1024;
// STRTD and nine, sixteen or seventeen digits, or STRCA and thirteen, as
// `straightship-1` claims them, or STSH, two letters and eleven digits, as `straightship-2` offers them.
const NUMBER = /^(?:STR(?:TD\d{9}|TD\d{16,17}|CA\d{13})|STSH[A-Z]{2}\d{11})$/;
const CLOCK = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
// The note under the history: "All timestamps are shown in Coordinated Universal Time (UTC)."
const UTC_NOTE = /\btimestamps are shown in (?:Coordinated Universal Time|UTC)\b/i;
// A row later than the lookup by more than this means the note no longer holds.
const CLOCK_SKEW_MS = 15 * 60_000;
// "Delivered (Sampleton, BC)": the town and province a row's wording ends with.
const PLACE = /^(.*\S) \(([^()\d@]+, [A-Z]{2})\)$/;
// A firewall or bot check's page, which can come back with HTTP 200.
const BLOCKED = /_cf_chl_opt|cf-turnstile|g-recaptcha|h-captcha|_Incapsula_Resource|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)/i;
const MAX_ROWS = 300;
const MAX_EVENTS = 100;

/** A Straightship number in capitals; anything else is not one Straightship issues. */
export function normalizeStraightshipNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Straightship numbers are STRTD, STRCA or STSH and digits');
  return number;
}

const text = (node: Cheerio<Element>, maxLength = 300) => clean(node.text(), maxLength);

interface Row {
  wall: string;
  description: string;
  location: string;
  index: number;
}

/** "2026-10-15 20:12:19" as an offset-less ISO clock, checked against the calendar. */
function wallClock(value: string): string {
  const wall = value.replace(' ', 'T');
  // Parsing in UTC checks the calendar digits only.
  if (!CLOCK.test(value) || DateTime.fromISO(wall, { zone: 'utc' }).toFormat("yyyy-MM-dd'T'HH:mm:ss") !== wall) {
    throw new SchemaError(PROVIDER, 'Straightship returned an invalid scan time');
  }
  return wall;
}

/** A row's wording without the town and province it ends with, and that place, else the City column. */
function rowOf(cells: Cheerio<Element>, index: number): Row | null {
  const wording = text(cells.eq(1));
  // An older page listed a parcel's creation once more without wording.
  if (!wording) return null;
  const place = PLACE.exec(wording);
  const city = text(cells.eq(2), 80);
  // A place with a digit could be an address or a postal code.
  const location = place ? place[2]! : /\d/.test(city) ? '' : city;
  return { wall: wallClock(text(cells.eq(0), 40)), description: place ? place[1]! : wording, location, index };
}

/** The value the summary table gives a label, such as `Tracking ID`. */
function summaryValue($: CheerioAPI, summary: Cheerio<Element>, label: string): string {
  const row = summary.find('tr').filter((_, tr) => text($(tr).children('th'), 60).toLowerCase() === label.toLowerCase());
  return row.length === 1 ? text(row.children('td'), 80) : '';
}

/** The history table, found by its headings. */
function historyTable($: CheerioAPI, primary: Cheerio<Element>): Cheerio<Element> {
  const tables = primary.find('table').filter((_, table) => {
    const headings = $(table).find('thead th').map((__, th) => text($(th), 40).toLowerCase()).get();
    return headings.join('|') === 'timestamp|status|city';
  });
  if (tables.length !== 1) throw new SchemaError(PROVIDER, 'Straightship returned a page without its history');
  return tables.first();
}

/**
 * Straightship's tracking page for one number, rendered by its server. A
 * number the tracker holds gets a summary table and the history, oldest
 * first; an unknown one gets `No results found!`. Both repeat the number as
 * it was asked in the page's title, and the summary repeats it as its
 * Tracking ID. The tracker matches the whole number in any case.
 *
 * The page states under the history that every clock is UTC; archived
 * lookups agree, with rows that predate their capture only as UTC and
 * deliveries before the driver's 9 pm deadline. Without that note, or with a
 * row after the lookup, the clocks stay as the page shows them.
 */
export function parseStraightship(html: string, rawNumber: string, now = Date.now()): CarrierResult {
  const number = normalizeStraightshipNumber(rawNumber);
  const $ = load(html);
  const primary = $('#primary');
  if (primary.length !== 1 || !/^Canada B2C Shipment Tracking$/i.test(text(primary.children('h3').first(), 80))) {
    if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Straightship answered with a block page');
    throw new SchemaError(PROVIDER, 'Straightship did not return its tracking page');
  }
  const asked = /^Straightship - Tracking (\S+)$/i.exec(text($('title').first(), 120))?.[1] ?? '';
  if (asked.toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'Straightship answered for another number');
  if (primary.children('h3').filter((_, h3) => /^No results found!?$/i.test(text($(h3), 60))).length) throw new NotFoundError(PROVIDER);

  const summary = primary.children('table').first();
  if (summaryValue($, summary, 'Tracking ID').toUpperCase() !== number) {
    throw new IndeterminateError(PROVIDER, 'Straightship answered for another number');
  }
  const rows = historyTable($, primary).find('tbody > tr');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Straightship returned an oversized history');

  const seen = new Set<string>();
  const scans: Row[] = [];
  rows.each((index, tr) => {
    const cells = $(tr).children('td');
    if (cells.length !== 3) throw new SchemaError(PROVIDER, 'Straightship returned a changed history row');
    const row = rowOf(cells, index);
    const key = row && JSON.stringify([row.wall, row.description, row.location]);
    if (!row || seen.has(key!)) return;
    seen.add(key!);
    scans.push(row);
  });
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first; rows with one clock keep the page's order, reversed.
  scans.sort((left, right) => (left.wall === right.wall ? right.index - left.index : left.wall < right.wall ? 1 : -1));

  const instant = (wall: string) => DateTime.fromISO(wall, { zone: 'utc' });
  const utc = UTC_NOTE.test(text($('.alert-note'), 1000)) && instant(scans[0]!.wall).toMillis() <= now + CLOCK_SKEW_MS;
  const events: CarrierEvent[] = scans.slice(0, MAX_EVENTS).map((scan) => {
    const staged = straightshipStage(scan.description);
    return {
      ...(utc ? { time: instant(scan.wall).toISO({ suppressMilliseconds: true })! } : { local_time: scan.wall }),
      description: scan.description,
      ...(scan.location ? { location: scan.location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    };
  });
  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  const stage = scanned?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: scanned!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description ?? null,
    last_update: typeof newest.time === 'string' ? newest.time : null,
    ...(typeof newest.local_time === 'string' ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    ...(stage === 'delivered' && typeof scanned!.time === 'string' ? { delivered_at: scanned!.time } : {}),
    events,
    ...(scans.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
