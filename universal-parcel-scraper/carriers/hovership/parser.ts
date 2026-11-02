import { load, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { hovershipHeadlineStage, hovershipStage } from './status.js';

export const PROVIDER = 'Hovership';
export const CARRIER = 'hovership';
// A parcel's page is about 45 kilobytes, most of it the site's menus.
export const HOVERSHIP_MAX_BYTES = 512 * 1024;
// The tracking form's rule, six to thirty letters, digits, underscores and
// dashes, without the dashes the library's normalization removes.
const NUMBER = /^(?=[A-Z0-9_]*[A-Z0-9])[A-Z0-9_]{6,30}$/;
// The line over a parcel's status, "Tracking · {number}".
const MARKER = /^Tracking\s*·\s*(\S+)$/;
// The page's answer for a number it has no shipment for.
const NOT_FOUND = /^Tracking number not found$/i;
// The page's headline note for a parcel not yet delivered: its latest delivery time.
const ESTIMATE = /^Arriving (?:no later than|by) (.+)$/;
const DELIVERED = /^Delivered (.+)$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "Sep 9, 2026, 2:15 PM PDT": the clock in US English, then its zone's short name.
const STAMP = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2}) ([AP]M)(?: (\S{2,9}))?$/;
// The short names US English gives the zones of the states Hovership serves, and their offsets in minutes.
const OFFSETS: Readonly<Record<string, number>> = {
  EST: -300, EDT: -240, CST: -360, CDT: -300, MST: -420, MDT: -360, PST: -480, PDT: -420,
  AKST: -540, AKDT: -480, HST: -600, HDT: -540, AST: -240, UTC: 0, GMT: 0,
};
// A zone US English has no short name for, written as its offset ("GMT-7", "GMT+5:30").
const GMT_OFFSET = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/;
// Bot checks a CDN or firewall could put in place of the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required|Access Denied|ERROR: The request could not be satisfied)|AwsWafIntegration|awswaf\.com|gokuProps/i;
// A run of nine or more digits, with spaces, brackets, dots or hyphens between them, as phone numbers are written.
const PHONE = /(?<![A-Z\d])\+?\(?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
// Who took a delivered parcel, after the scan's line ("Delivered, signed by …").
const RECEIVER = /\s*[,;:.\-–]?\s*\b(?:signed(?: for)? by|received by|accepted by|left with)\b[\s\S]*$/i;
const MAX_ROWS = 300;
const MAX_EVENTS = 100;

/** A number for Hovership's tracker, in upper case as its form sends it; anything else is not one it issues. */
export function normalizeHovershipNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Hovership numbers are six to thirty letters, digits and underscores');
  return number;
}

function invalid(message: string): never {
  throw new SchemaError(PROVIDER, message);
}

/** The offset a zone's short name stands for, as an ISO suffix; null for a name not on the list. */
function zoneOffset(name: string | undefined): string | null {
  const gmt = name ? GMT_OFFSET.exec(name) : null;
  const minutes = name && Object.hasOwn(OFFSETS, name) ? OFFSETS[name]!
    : gmt && Number(gmt[2]) <= 14 && Number(gmt[3] ?? 0) <= 59 ? (gmt[1] === '-' ? -1 : 1) * (Number(gmt[2]) * 60 + Number(gmt[3] ?? 0))
      : null;
  if (minutes === null) return null;
  if (minutes === 0) return 'Z';
  const whole = Math.abs(minutes);
  return `${minutes < 0 ? '-' : '+'}${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
}

interface Stamp { day: string; wall: string; offset: string | null }

/** A clock the page prints, or null when it is not one. Date libraries accept 0:00 PM, so the fields are checked here. */
function readStamp(text: string): Stamp | null {
  const match = STAMP.exec(text);
  if (!match) return null;
  const [, monthName, date, year, hour, minute, half, zone] = match;
  const day = calendarDay(Number(year), MONTHS.indexOf(monthName!) + 1, Number(date));
  if (!day || Number(hour) < 1 || Number(hour) > 12 || Number(minute) > 59) return null;
  const hours = (Number(hour) % 12) + (half === 'PM' ? 12 : 0);
  return { day, wall: `${day}T${String(hours).padStart(2, '0')}:${minute}:00`, offset: zoneOffset(zone) };
}

/**
 * A scan's clock: an instant in the offset of the zone the page names after
 * it. A zone the page names some other way leaves the wall clock in
 * `local_time`.
 */
function scanClock(text: string): Pick<CarrierEvent, 'time'> & { local_time?: string } {
  const stamp = readStamp(text) ?? invalid('Hovership returned an invalid scan time');
  return stamp.offset ? { time: `${stamp.wall}${stamp.offset}` } : { local_time: stamp.wall };
}

/** A scan's line without phone numbers, and a delivery's without who took the parcel. */
export function hovershipWording(detail: string, delivered: boolean): string {
  const line = delivered ? detail.replace(RECEIVER, '') : detail;
  return clean(line.replace(PHONE, ' ').replace(/\s+([,;:.])/g, '$1'), 300).replace(/^[\s,;:.\-–]+|[\s,;:\-–]+$/g, '');
}

/** The history's rows, newest first as the page lists them; none when the page has no history. */
function historyRows($: CheerioAPI): Element[] {
  const labels = $('main p.stat-card-label').filter((_, label) => clean($(label).text()) === 'Tracking history');
  if (labels.length > 1) invalid('Hovership returned repeated histories');
  if (!labels.length) return [];
  const lists = labels.parent().find('ol');
  if (lists.length !== 1) invalid('Hovership returned a history without its list');
  return lists.children('li').toArray();
}

function projectRow($: CheerioAPI, row: Element): CarrierEvent {
  const times = $(row).find('time');
  if (times.length !== 1) invalid('Hovership returned an incomplete scan');
  const header = times.parent();
  const label = clean(header.children('p').first().text(), 80);
  if (!label) invalid('Hovership returned a scan without its title');
  const clock = scanClock(clean(times.text(), 60));
  const detail = clean(header.nextAll('p').first().text(), 400);
  const staged = hovershipStage(label, detail);
  const description = hovershipWording(detail, staged?.stage === 'delivered') || label;
  return {
    ...clock,
    description,
    provider_code: label,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/** The headline note's clock after `pattern`, as an instant or else its day; null when the note is something else. */
function noteClock(note: string, pattern: RegExp): { time: string | null; day: string } | null {
  const text = pattern.exec(note)?.[1];
  const stamp = text ? readStamp(text) : null;
  return stamp ? { time: stamp.offset ? `${stamp.wall}${stamp.offset}` : null, day: stamp.day } : null;
}

/** Whether a page is the tracker's own answer for a number it has no shipment for. */
export function isHovershipNotFound(html: string): boolean {
  return NOT_FOUND.test(clean(load(html)('main h1').first().text(), 120));
}

/**
 * The page `www.hovership.com/track/{number}/` answers. The server renders the
 * parcel under its number, a headline status with its latest delivery time or
 * its delivery, and the history newest first, each scan a title, a clock and a
 * line. The progress rail, the origin and destination towns and the form that
 * unlocks the address and proof of delivery for the delivery ZIP code are not
 * read.
 */
export function parseHovership(html: string, raw: string): CarrierResult {
  const number = normalizeHovershipNumber(raw);
  const $ = load(html);
  const headline = $('main h1').first();
  const heading = clean(headline.text(), 120);
  if (NOT_FOUND.test(heading)) throw new NotFoundError(PROVIDER);
  const markers = $('main p.section-marker').map((_, marker) => clean($(marker).text(), 80)).get()
    .filter((text) => MARKER.test(text));
  if (markers.length !== 1 || !heading) {
    if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Hovership answered with a browser check');
    invalid('Hovership returned a page without a parcel');
  }
  const verify = $('form[data-verify-form]').attr('data-tracking');
  if (MARKER.exec(markers[0]!)![1]!.toUpperCase() !== number || (verify !== undefined && clean(verify, 64).toUpperCase() !== number)) {
    throw new IndeterminateError(PROVIDER, 'Hovership answered for another parcel');
  }

  const rows = historyRows($);
  if (rows.length > MAX_ROWS) invalid('Hovership returned an oversized history');
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    const event = projectRow($, row);
    const key = JSON.stringify([event.time ?? event.local_time, event.provider_code, event.description]);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(event);
  }
  // Newest first, as the page lists them; an oldest-first list is turned round.
  const first = events[0]?.time;
  const last = events.at(-1)?.time;
  if (first && last && Date.parse(first) < Date.parse(last)) events.reverse();

  const note = clean(headline.nextAll('p').first().text(), 120);
  const summary = hovershipHeadlineStage(heading);
  const current = events.find((event) => event.stage);
  const stage = (current?.stage ?? summary) as Stage | undefined;
  const final = stage === 'delivered' || stage === 'returned';
  const estimate = final ? null : noteClock(note, ESTIMATE);
  const delivered = stage === 'delivered' ? current?.time ?? noteClock(note, DELIVERED)?.time : undefined;
  const newest = events[0];
  if (!newest && !summary) throw new NoHistoryError(PROVIDER);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current?.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest?.description ?? heading,
    last_update: newest?.time ?? null,
    ...(typeof newest?.local_time === 'string' ? { last_update_local: newest.local_time } : {}),
    expected_delivery: estimate ? estimate.time ?? estimate.day : null,
    ...(delivered ? { delivered_at: delivered } : {}),
    ...(newest ? {} : { summary_only: true }),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
