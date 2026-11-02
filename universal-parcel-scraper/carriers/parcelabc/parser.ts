import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { PROGRESS } from '../../core/result/partial.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { parcelAbcStage } from './status.js';

export const PROVIDER = 'ParcelABC';
export const CARRIER = 'parcelabc';
export const PARCELABC_ORIGIN = 'https://www.parcelabc.com';
// An order's page is about 200 kB, most of it the site's theme, and the home page about as much.
export const PARCELABC_MAX_BYTES = 2 * 1024 * 1024;

// The sending and destination countries' codes, then nine digits.
const NUMBER = /^[A-Z]{4}\d{9}$/;
// "16 06 2026 07:01": a wall clock to the minute, with no zone.
const CLOCK = /^(\d{2}) (\d{2}) (\d{4}) (\d{2}):(\d{2})$/;
// Bot checks and firewall refusals that could stand in for the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required!|Access Denied|403 Forbidden|Request Rejected)|awswaf|gokuProps|g-recaptcha|h-captcha/i;
// The notice the home page shows after the tracker sends an unknown code there.
const NOT_VALID = /^Your entered parcel tracking ID is not valid\.?$/i;
// The page's columns: the parcel's number on its newest row, the clock, the place, the status, the comment and a toggle.
const CELLS = 6;
const EMPTY = '-';
// Nine or more digits written as a phone number is; a reference with dots or a date stays.
const PHONE = /(?<![\w.+-])\+?\d(?:[ ()-]{0,2}\d){8,}(?![\w.-])/g;
const EMAIL = /[^\s@]+@[^\s@]+\.[a-z]{2,}/gi;
// Who took or signed for the parcel, and the rest of the comment after it.
const RECEIVER = /\s*(?:[,;:.\-–]|\band\b)?\s*\b(?:received by|signed(?: for)? by|signed for|signature|signatory|left with)\b[\s\S]*$/i;
// A British postcode, which a courier's place or comment can carry.
const POSTCODE = /\b[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}\b/g;
const MAX_PARCELS = 50;
const MAX_ROWS = 200;

/** A code for ParcelABC's tracker: four letters and nine digits, which customers quote without the hyphen too. */
export function normalizeParcelAbcNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'ParcelABC order codes are four letters and nine digits');
  return number;
}

/** The code as the tracker takes it, with the hyphen after the letters. */
export function parcelAbcCode(raw: string): string {
  const number = normalizeParcelAbcNumber(raw);
  return `${number.slice(0, 4)}-${number.slice(4)}`;
}

/** A bot wall's or the web server's refusal page instead of ParcelABC's own. */
export function isParcelAbcBlockPage(html: string): boolean {
  return CHALLENGE.test(html.slice(0, 64_000));
}

/** A row's wall clock. */
function wallClock(text: string): string {
  const parts = CLOCK.exec(text);
  if (parts) {
    const [day, month, year, hour, minute] = parts.slice(1).map(Number) as [number, number, number, number, number];
    const date = calendarDay(year, month, day);
    if (date && year >= 2000 && hour <= 23 && minute <= 59) return `${date}T${parts[4]}:${parts[5]}:00`;
  }
  throw new SchemaError(PROVIDER, 'ParcelABC returned an invalid scan time');
}

/** A place or comment without postcodes, phone numbers, e-mail addresses or who took the parcel. */
function scrubbed(text: string, maxLength: number): string {
  const value = clean(text, maxLength);
  if (value === EMPTY) return '';
  return clean(value.replace(RECEIVER, '').replace(EMAIL, '').replace(PHONE, '').replace(POSTCODE, ''))
    .replace(/^[\s,;:.\-–/]+|[\s,;:\-–/]+$/g, '');
}

/** A parcel's rows, newest first as the page lists them. */
function parcelEvents($: CheerioAPI, parcel: Cheerio<Element>): CarrierEvent[] {
  const rows = parcel.children('.current-status, .status-history').find('tr').toArray();
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'ParcelABC returned an invalid history');
  return rows.map((row) => {
    const cells = $(row).children('td').toArray().map((cell) => $(cell).text());
    if (cells.length !== CELLS) throw new SchemaError(PROVIDER, 'ParcelABC returned an invalid scan');
    const label = clean(cells[3], 80);
    if (!label || label === EMPTY) throw new SchemaError(PROVIDER, 'ParcelABC returned a scan without a status');
    const location = scrubbed(cells[2]!, 120);
    const comment = scrubbed(cells[4]!, 300);
    const staged = parcelAbcStage(label);
    return {
      local_time: wallClock(clean(cells[1], 40)), description: comment ? `${label}: ${comment}` : label,
      ...(location ? { location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    };
  });
}

/** The parcel's newest row that moved it: notes that move nothing do not change where it stands. */
const milestone = (events: readonly CarrierEvent[]) => events.find((event) => event.stage && event.stage !== 'pending');
/** How far a parcel has come; a problem, or no step yet, counts as least. */
const progress = (events: readonly CarrierEvent[]) => PROGRESS[milestone(events)?.stage as Stage] ?? -1;

/**
 * Every parcel's rows, newest first. Parcels of one order usually repeat the
 * same rows, which are kept once: a row stays as often as one parcel has it.
 */
function orderEvents(parcels: readonly CarrierEvent[][]): CarrierEvent[] {
  const kept = new Map<string, number>();
  const events = parcels.flatMap((rows) => {
    const seen = new Map<string, number>();
    return rows.filter((event) => {
      const key = JSON.stringify([event.local_time, event.description, event.location]);
      const count = (seen.get(key) ?? 0) + 1;
      seen.set(key, count);
      if (count <= (kept.get(key) ?? 0)) return false;
      kept.set(key, count);
      return true;
    });
  });
  // Newest first; rows of one clock keep the page's order.
  return events.map((event, index) => ({ event, index }))
    .sort((left, right) => right.event.local_time!.localeCompare(left.event.local_time!) || left.index - right.index)
    .map(({ event }) => event);
}

/**
 * The tracker's page for one order, `/track/<code>`, which its server renders:
 * the code asked for in its heading, then each parcel's rows newest first, each
 * a clock, a place, ParcelABC's status and the courier's or ParcelABC's comment.
 * The page draws each parcel twice, for wide and narrow screens; only the wide
 * one is read.
 */
export function parseParcelAbc(html: string, raw: string): CarrierResult {
  const number = normalizeParcelAbcNumber(raw);
  if (isParcelAbcBlockPage(html)) throw new ChallengeError(PROVIDER, 'ParcelABC answered with a browser check');
  const $ = load(html);
  const root = $('#parcel-track');
  if (root.length !== 1) throw new SchemaError(PROVIDER, 'ParcelABC returned a page without its tracker');
  const heading = /"([^"]{1,64})"/.exec(clean(root.find('.inner-top-header .main-text').first().text(), 200));
  if (!heading) throw new SchemaError(PROVIDER, 'ParcelABC returned a page without the order code');
  if (normalizeTrackingNumber(heading[1]!) !== number) throw new IndeterminateError(PROVIDER, 'ParcelABC answered for another code');
  const wrapper = root.find('.statuses-wrapper');
  if (wrapper.length !== 1) throw new SchemaError(PROVIDER, 'ParcelABC returned a page without its history');

  const blocks = wrapper.children('.visible-lg').children('.status-wrapper').toArray();
  if (blocks.length > MAX_PARCELS) throw new SchemaError(PROVIDER, 'ParcelABC returned an invalid order');
  const parcels = blocks.map((block) => parcelEvents($, $(block))).filter((events) => events.length);
  if (!parcels.length && wrapper.find('tr').length) throw new SchemaError(PROVIDER, 'ParcelABC returned an unexpected history');
  if (!parcels.length) throw new NoHistoryError(PROVIDER);
  // The order stands where its least advanced parcel does: one parcel's delivery does not deliver the order.
  const trailing = parcels.reduce((least, events) => (progress(events) < progress(least) ? events : least));
  const current = milestone(trailing) ?? trailing.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const newest = trailing[0]!;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time!,
    expected_delivery: null,
    events: orderEvents(parcels),
  };
}

/** Where an unknown code's redirect leads: the home page, which the session then shows a notice on. */
export function isHomeRedirect(location: string | null): boolean {
  if (!location) return false;
  try {
    const url = new URL(location, PARCELABC_ORIGIN);
    return url.origin === PARCELABC_ORIGIN && url.pathname === '/' && !url.search && !url.hash;
  } catch {
    return false;
  }
}

/**
 * The home page after the tracker redirected a code there. Only its notice
 * that the tracking ID is not valid means the order is missing: the tracker
 * gives it for a well-formed code it has no order under.
 */
export function parseParcelAbcHome(html: string): never {
  if (isParcelAbcBlockPage(html)) throw new ChallengeError(PROVIDER, 'ParcelABC answered with a browser check');
  const $ = load(html);
  const notices = $('#flashes .flash-message').toArray().map((notice) => clean($(notice).text(), 300));
  if (notices.some((notice) => NOT_VALID.test(notice))) throw new NotFoundError(PROVIDER, 'ParcelABC has no order under this code');
  throw new IndeterminateError(PROVIDER, notices.length ? 'ParcelABC refused the lookup' : 'ParcelABC sent the lookup to its home page without a notice');
}
