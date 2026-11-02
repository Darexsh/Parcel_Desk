import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import { DateTime } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { returnedTrackingNumber } from '../../core/detection/returned.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { lastMovement } from '../../core/result/pickup.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { isoTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { RECEIVER, southAfricanPostStage } from './status.js';

export const PROVIDER = 'South African Post Office';
// The tracker's page is under 4 kB, and a long history adds a few hundred bytes a scan.
export const SOUTH_AFRICAN_POST_MAX_BYTES = 1_000_000;

const MAX_ROWS = 500;
// The tracker shows only the Post Office's own scans, all made in South Africa,
// which keeps one civil time all year.
const CLOCK_ZONE = 'Africa/Johannesburg';
const RESULTS = 'PARCEL TRACKING RESULTS';
const HEADINGS = ['#', 'Type', 'Date', 'Time', 'Branch', 'Comments'];
// The page's notice for a number its records do not hold.
const NO_RECORD = 'No tracking record found';
// A firewall or bot check's page, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Request Rejected|Access Denied|Attention Required|Just a moment)|requested URL was rejected|_cf_chl_opt|cf-turnstile|captcha/i;
const DATE = /^\d{4}\/\d{2}\/\d{2}$/;
const CLOCK = /^(?:0?[1-9]|1[0-2]):[0-5]\d [AP]M$/i;
// A run of nine or more digits, with the separators phone numbers are written with.
const PHONE = /(?<![A-Z\d])\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;

/**
 * The tracker looks up S10 item codes: the Post Office's own, ending ZA, and
 * those of the posts that send items to South Africa. The code needs a valid
 * check digit.
 */
export function normalizeSouthAfricanPostNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (isValidS10TrackingNumber(number)) return number;
  throw new InvalidInputError(PROVIDER, 'The South African Post Office tracks S10 item codes');
}

/**
 * A scan's wording: its comment, as the page shows it under the scan's type,
 * or the type when the comment is empty. A delivery loses the clause naming
 * who took the item, and every comment loses phone numbers.
 */
export function southAfricanPostWording(type: string, comment: string): string {
  let own = comment.replace(RECEIVER, '');
  // Nothing after a colon on a delivery is kept: it names a person.
  if (/deliver|collect/i.test(type)) own = own.replace(/\s*:[\s\S]*$/, '');
  return clean(own.replace(PHONE, '')).replace(/[\s,;:-]+$/, '') || clean(type);
}

/** A scan's date ("2026/05/04") and 12-hour time ("3:43 PM"): the office's wall clock, read on South Africa's. */
function scanTime(date: string, time: string): string {
  // Parsing in UTC checks the calendar fields only; the zone comes after.
  const parsed = DATE.test(date) && CLOCK.test(time)
    ? DateTime.fromFormat(`${date} ${time.toUpperCase()}`, 'yyyy/MM/dd h:mm a', { zone: 'UTC', locale: 'en-US' }) : null;
  const instant = parsed?.isValid ? isoTime(parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss"), CLOCK_ZONE)?.iso : undefined;
  if (!instant) throw new SchemaError(PROVIDER, 'The South African Post Office returned an invalid scan time');
  return instant;
}

interface Scan { event: CarrierEvent; index: number }

function scanOf($: CheerioAPI, row: Cheerio<Element>, index: number): Scan {
  const cells = row.children('td').map((_, cell) => $(cell).text()).get();
  if (cells.length !== HEADINGS.length || !/^\d{1,4}$/.test(clean(cells[0], 8))) {
    throw new SchemaError(PROVIDER, 'The South African Post Office history columns changed');
  }
  const type = clean(cells[1], 80);
  const comment = clean(cells[5], 300);
  const description = southAfricanPostWording(type, comment);
  if (!description) throw new SchemaError(PROVIDER, 'The South African Post Office returned a scan without wording');
  const location = clean(cells[4], 120);
  const staged = southAfricanPostStage(description, type);
  const event: CarrierEvent = {
    time: scanTime(clean(cells[2], 16), clean(cells[3], 16)),
    ...(location ? { location } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { event, index };
}

/** The labelled values of the summary above the history, by label in lower case. */
function summaryOf($: CheerioAPI, table: Cheerio<AnyNode>): Map<string, string> {
  const values = new Map<string, string>();
  table.find('tr').each((_, row) => {
    const cells = $(row).children('td');
    if (cells.length === 2) values.set(clean(cells.eq(0).text(), 60).toLowerCase(), cells.eq(1).text());
  });
  return values;
}

/**
 * The tracker's page for one number, as its form's GET returns it: a summary
 * naming the item, then its scans newest first, each with its type, date,
 * time, branch and comment. A number its records do not hold comes back with
 * the form's notice instead.
 */
export function parseSouthAfricanPost(html: string, rawNumber: string): CarrierResult {
  const number = normalizeSouthAfricanPostNumber(rawNumber);
  const $ = load(html);
  const forms = $('form#form-buscar');
  if (forms.length !== 1 || forms.find('input[name="ParcelId"]').length !== 1) {
    if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'The South African Post Office answered with a block page');
    throw new SchemaError(PROVIDER, 'The South African Post Office did not return its tracking page');
  }
  const headings = $('th').filter((_, node) => clean($(node).text(), 60) === RESULTS);
  if (!headings.length) {
    // The notice comes alone: a page with tables but no results heading has changed.
    if ($('table').length) throw new SchemaError(PROVIDER, 'The South African Post Office results changed');
    const notice = clean($('#dvInfo').text(), 200);
    // Only the page's own notice is a missing item.
    if (notice === NO_RECORD) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, notice ? 'The South African Post Office did not complete the lookup'
      : 'The South African Post Office returned its form without an answer');
  }
  if (headings.length !== 1) throw new SchemaError(PROVIDER, 'The South African Post Office returned several items for one number');
  const item = summaryOf($, headings.first().closest('table')).get('item number');
  if (item === undefined) throw new SchemaError(PROVIDER, 'The South African Post Office returned a result without its item number');
  if (returnedTrackingNumber(item) !== number) throw new SchemaError(PROVIDER, 'The South African Post Office answered for a different item');

  const tables = $('table.table');
  if (tables.length !== 1) throw new SchemaError(PROVIDER, 'The South African Post Office did not return one item history');
  const table = tables.first();
  const columns = table.find('th').map((_, node) => clean($(node).text(), 40)).get();
  if (JSON.stringify(columns) !== JSON.stringify(HEADINGS)) throw new SchemaError(PROVIDER, 'The South African Post Office history columns changed');
  const rows = table.find('tr').filter((_, row) => $(row).children('td').length > 0);
  if (!rows.length) throw new NoHistoryError(PROVIDER);
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'The South African Post Office returned an oversized history');

  const scans: Scan[] = [];
  const seen = new Set<string>();
  rows.each((index, row) => {
    const scan = scanOf($, $(row), index);
    // A scan the page lists twice is kept once.
    const identity = JSON.stringify(scan.event);
    if (seen.has(identity)) return;
    seen.add(identity);
    scans.push(scan);
  });
  // Newest first, as the page lists them; scans at the same minute keep the page's order.
  scans.sort((left, right) => Date.parse(right.event.time!) - Date.parse(left.event.time!) || left.index - right.index);
  const events = scans.map(({ event }) => event);

  const latest = events[0]!;
  // A scanner's note has no stage; the newest scan with one sets the item's.
  const current = events.find(event => event.stage);
  const stage = current?.stage as Stage | undefined;
  // The office that sent a notice to collect the item is its pickup point. A
  // delivered item was collected there when that notice was its last movement.
  const earlier = current ? events.slice(events.indexOf(current) + 1) : [];
  const waiting = stage === 'ready_for_pickup' ? current
    : stage === 'delivered' && lastMovement(earlier) === 'ready_for_pickup'
      ? earlier.find(event => event.stage === 'ready_for_pickup')
      : undefined;
  const point = waiting?.location ?? '';
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: latest.time!,
    ...(stage === 'delivered' ? { delivered_at: current!.time! } : {}),
    expected_delivery: null,
    ...(point ? { pickup_point: point } : {}),
    events,
  };
}
