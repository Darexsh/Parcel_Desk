import { load, type Cheerio } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { DateTime } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, countryCode, firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { jordanPostStage } from './status.js';

export const PROVIDER = 'Jordan Post';
// The pages are under 10 kB; a long history adds a few hundred bytes a scan.
export const JORDAN_POST_MAX_BYTES = 512 * 1024;
/** The tracking page's form, which Jordan Post's website embeds. */
export const JORDAN_POST_SEARCH = 'https://212.35.69.84/NewWebTrack/WebTrack_Submit.aspx';
/** The IPS Web Tracking page the form sends an item of the UPU's IPS system to. */
export const JORDAN_POST_ITEM = 'https://212.35.69.85/webtracking/IPSWeb_item_events.aspx';

const ZONE = 'Asia/Amman';
const MAX_ROWS = 500;
// The IPS page's columns. Its extra information spans two cells, the second unread.
const HEADINGS = ['Local Date and Time', 'Country', 'Location', 'Event Type', 'Mail Category', 'Next Office', 'Extra Information'];
const CELLS = HEADINGS.length + 1;
// The columns of the form's own table: the fields of the domestic records it binds.
const GRID_HEADINGS = ['track', 'EventDate', 'EVENT_TYPE_NM', 'DELIV_LOCATION', 'SIGNATORY_NM'];
const NO_INFORMATION = 'No information, please check your item identifier';
const ITEM = /^ITEM n° ([A-Z0-9]{1,40})$/;
// "2/19/2026 11:31:00 AM", the wall clock of the office that scanned the item.
const CLOCK = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2}) ([AP]M)$/;
// The details of the extra information that are kept: why an item was not
// delivered, what happens next, and why it is held.
const DETAIL = /^(?:Reason|Measure|Retention reason)\s*:\s*(.+)$/i;
// An inward scan, in the country the item was sent to.
const INWARD = /\(inb\)$/i;
// A run of four or more digits, as an office's postcode is written.
const DIGITS = /(?:^|\s)\d{4,}(?=\s|$)/g;
const FIELD = /^__[A-Z]{1,30}$/;
const MAX_FIELD_LENGTH = 50_000;
const FORM = {
  option: 'ctl00$ContentPlaceHolder1$a',
  number: 'ctl00$ContentPlaceHolder1$txtItemNo',
  search: 'ctl00$ContentPlaceHolder1$btnSubmit',
} as const;
// A firewall's, CDN's or bot check's page in place of the tracker's, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Request Rejected|Access Denied|Attention Required|Just a moment|Web Page Blocked|Bot Verification)|requested URL was rejected|_cf_chl_opt|cf-turnstile|g-recaptcha|lsrecaptcha/i;

/**
 * Jordan Post's trackers look up UPU S10 item codes: its own, ending JO, and
 * those of the posts that send mail to Jordan. The code needs a valid check digit.
 */
export function normalizeJordanPostNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (isValidS10TrackingNumber(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Jordan Post tracks S10 item codes');
}

/** The IPS page for one item, as the form's redirect opens it. */
export function jordanPostItemUrl(number: string): string {
  return `${JORDAN_POST_ITEM}?${new URLSearchParams({ itemid: number, Submit: 'Submit' })}`;
}

/** Whether the form's redirect opens the IPS page for the whole number. */
export function isJordanPostItemRedirect(location: string, number: string): boolean {
  let target: URL;
  try { target = new URL(location, JORDAN_POST_SEARCH); } catch { return false; }
  const item = new URL(JORDAN_POST_ITEM);
  return target.origin === item.origin && target.pathname.toLowerCase() === item.pathname.toLowerCase()
    && normalizeTrackingNumber(target.searchParams.get('itemid') ?? '') === number;
}

/** A page without what the tracker's has: a block page, else a changed page. */
function unexpected(html: string, message: string): never {
  if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Jordan Post answered with a block page');
  throw new SchemaError(PROVIDER, message);
}

/** What the form posts to look an item code up, as its search button does with the item option chosen. */
export function jordanPostSearchFields(html: string, number: string): URLSearchParams {
  const $ = load(html);
  const form = $('form#aspnetForm');
  if (form.length !== 1 || form.find(`input[name="${FORM.number}"]`).length !== 1
    || form.find(`input[name="${FORM.option}"][value="RdbByItem"]`).length !== 1 || form.find(`input[name="${FORM.search}"]`).length !== 1) {
    unexpected(html, 'Jordan Post returned a tracking page without its form');
  }
  const fields = new URLSearchParams();
  form.find('input[type="hidden"]').each((_, element) => {
    const name = $(element).attr('name') ?? '';
    const value = $(element).attr('value') ?? '';
    if (FIELD.test(name) && value.length <= MAX_FIELD_LENGTH) fields.set(name, value);
  });
  if (!fields.get('__VIEWSTATE') || !fields.get('__EVENTVALIDATION')) {
    throw new SchemaError(PROVIDER, 'Jordan Post returned a tracking page without its state');
  }
  fields.set(FORM.option, 'RdbByItem');
  fields.set(FORM.number, number);
  fields.set(FORM.search, 'Search');
  return fields;
}

/** A scan's wall clock, calendar-checked, on a 24-hour clock. */
function wallClock(text: string): string {
  const match = CLOCK.exec(text);
  const day = match ? calendarDay(Number(match[3]), Number(match[1]), Number(match[2])) : null;
  const hour = match ? Number(match[4]) : 0;
  if (!match || !day || hour < 1 || hour > 12 || Number(match[5]) > 59 || Number(match[6]) > 59) {
    throw new SchemaError(PROVIDER, 'Jordan Post returned an invalid scan time');
  }
  const hours = String((hour % 12) + (match[7] === 'PM' ? 12 : 0)).padStart(2, '0');
  return `${day}T${hours}:${match[5]}:${match[6]}`;
}

/**
 * When a scan happened. The page heads its clocks "Local Date and Time": a
 * Jordanian office's is Amman's, a repeated autumn hour by its first
 * occurrence. A clock Amman skipped, and an office abroad's, stay wall clocks.
 */
function clockOf(wall: string, jordan: boolean): { time: string } | { local_time: string } {
  if (jordan) {
    const zoned = firstOccurrence(DateTime.fromISO(wall, { zone: ZONE }));
    if (zoned.isValid && zoned.toFormat("yyyy-MM-dd'T'HH:mm:ss") === wall) return { time: zoned.toISO({ suppressMilliseconds: true }) };
  }
  return { local_time: wall };
}

/** An office without its postcode; a dash is none. */
function officeOf(text: string): string {
  const office = text.replace(DIGITS, ' ').replace(/\s+/g, ' ').trim();
  return /[A-Za-z؀-ۿ]/.test(office) ? office : '';
}

interface Scan { event: CarrierEvent; country: string | null; wording: string }

function scanOf(clock: string, wording: string, details: readonly string[], office: string, countryName: string): Scan {
  if (!wording) throw new SchemaError(PROVIDER, 'Jordan Post returned a scan without wording');
  const country = countryName ? countryCode(countryName) : null;
  const place = officeOf(office);
  // The office, then its country, which a scan can name alone.
  const location = place.toLowerCase() === countryName.toLowerCase() ? countryName : [place, countryName].filter(Boolean).join(', ');
  const description = details.length ? `${wording}: ${details.join('; ')}` : wording;
  const staged = jordanPostStage(wording);
  const event: CarrierEvent = {
    ...clockOf(wallClock(clock), country === 'JO'),
    ...(location ? { location } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { event, country, wording };
}

/** The extra information's kept details, one a line; anything else, such as who signed, is dropped. */
function detailsOf(cell: Cheerio<AnyNode>): string[] {
  const copy = cell.clone();
  copy.find('br').replaceWith('\n');
  return copy.text().split('\n').map((line) => DETAIL.exec(clean(line, 200))?.[1]).filter((detail): detail is string => Boolean(detail))
    .map((detail) => clean(detail, 120));
}

/** The result for an item's scans, oldest first as both pages list them. */
function resultOf(scans: Scan[]): CarrierResult {
  const seen = new Set<string>();
  const unique = scans.filter((scan) => {
    // A scan the page lists twice is kept once.
    const identity = JSON.stringify(scan.event);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  }).reverse();
  if (!unique.length) throw new NoHistoryError(PROVIDER);
  const events = unique.map(({ event }) => event);
  const latest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const delivered = stage === 'delivered' ? current!.time ?? null : null;
  // An inward scan is recorded in the country the item was sent to.
  const destination = unique.find((scan) => scan.country && INWARD.test(scan.wording))?.country;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    ...(latest.time ? {} : { last_update_local: latest.local_time }),
    expected_delivery: null,
    ...(delivered ? { delivered_at: delivered } : {}),
    ...(destination ? { destination_country: destination } : {}),
    events,
  };
}

/**
 * The IPS Web Tracking page for one item: a heading naming it, then its
 * scans, oldest first. A code the IPS system holds nothing for gets the page's
 * notice instead, which this returns as null. The next office is a plan, not a
 * scan, and the mail category and the second extra-information cell are not read.
 */
export function parseJordanPostItem(html: string, rawNumber: string): CarrierResult | null {
  const number = normalizeJordanPostNumber(rawNumber);
  const $ = load(html);
  const headings = $('td > strong').filter((_, node) => clean($(node).text(), 80).startsWith('ITEM n°'));
  if (!headings.length) {
    const notices = $('p > strong').map((_, node) => clean($(node).text(), 120)).get();
    if ($('title').text().trim() === 'IPS Web Tracking/Item Events' && notices.includes(NO_INFORMATION)) return null;
    unexpected(html, 'Jordan Post returned a page without the item');
  }
  if (headings.length !== 1) throw new SchemaError(PROVIDER, 'Jordan Post returned several items for one code');
  if (ITEM.exec(clean(headings.text(), 80))?.[1] !== number) throw new SchemaError(PROVIDER, 'Jordan Post answered for a different item');
  const rows = headings.closest('table').children('tbody').children('tr');
  const headers = rows.eq(1).children('td').map((_, cell) => clean($(cell).text(), 40)).get();
  if (JSON.stringify(headers) !== JSON.stringify(HEADINGS)) throw new SchemaError(PROVIDER, 'Jordan Post history columns changed');
  if (rows.length - 2 > MAX_ROWS) throw new SchemaError(PROVIDER, 'Jordan Post returned an oversized history');
  const scans = rows.slice(2).toArray().map((row) => {
    const cells = $(row).children('td');
    if (cells.length !== CELLS) throw new SchemaError(PROVIDER, 'Jordan Post returned an invalid history row');
    const text = (index: number, length: number) => clean(cells.eq(index).text(), length);
    return scanOf(text(0, 40), text(3, 200), detailsOf(cells.eq(6)), text(2, 120), text(1, 80).replace(/\s*\(the\)$/i, ''));
  });
  return resultOf(scans);
}

/**
 * The form's answer when it did not send the item to the IPS page: the form
 * again, the code in its field, and the domestic records it found in its own
 * table. A code with none gets no table, which is not found. Who signed is
 * never read.
 */
export function parseJordanPostSearch(html: string, rawNumber: string): CarrierResult {
  const number = normalizeJordanPostNumber(rawNumber);
  const $ = load(html);
  const field = $(`form#aspnetForm input[name="${FORM.number}"]`);
  if (field.length !== 1) unexpected(html, 'Jordan Post returned a tracking page without its form');
  if (normalizeTrackingNumber(field.attr('value') ?? '') !== number) throw new SchemaError(PROVIDER, 'Jordan Post answered for a different item');
  const grid = $('table#ctl00_ContentPlaceHolder1_GridView1');
  if (!grid.length) throw new NotFoundError(PROVIDER);
  const rows = grid.find('tr');
  const headers = rows.first().children('th').map((_, cell) => clean($(cell).text(), 40)).get();
  if (JSON.stringify(headers) !== JSON.stringify(GRID_HEADINGS)) throw new SchemaError(PROVIDER, 'Jordan Post domestic history columns changed');
  if (rows.length - 1 > MAX_ROWS) throw new SchemaError(PROVIDER, 'Jordan Post returned an oversized history');
  const scans = rows.slice(1).toArray().map((row) => {
    const cells = $(row).children('td');
    if (cells.length !== GRID_HEADINGS.length) throw new SchemaError(PROVIDER, 'Jordan Post returned an invalid history row');
    const text = (index: number, length: number) => clean(cells.eq(index).text(), length);
    if (normalizeTrackingNumber(text(0, 64)) !== number) throw new SchemaError(PROVIDER, 'Jordan Post answered for a different item');
    // Domestic records are Jordanian offices' scans.
    return scanOf(text(1, 40), text(2, 200), [], text(3, 120), 'Jordan');
  });
  return resultOf(scans);
}
