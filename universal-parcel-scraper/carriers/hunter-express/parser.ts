import { load, type CheerioAPI } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, epochMillisTime, explicitOffsetTime, type ParsedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { hunterExpressStage } from './status.js';

export const PROVIDER = 'Hunter Express';
export const CARRIER = 'hunter-express';
// A consignment page is under twenty kilobytes.
export const HUNTER_EXPRESS_MAX_BYTES = 1024 * 1024;

// Consignments are three letters and six digits; the tracker takes other references too.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,30}$/;
const DAY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
// "28/09/2026 2:20 PM AEST": the day, a twelve-hour clock and, usually, the zone's abbreviation.
const CLOCK = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}) ([AP]M)(?: ([A-Z]{3,5}))?$/;
const HEADING = /^Current Status:\s*(.+)$/;
const TIMED_STATUS = /^(.+?):\s*(\d{1,2}\/\d{1,2}\/\d{4} \d{1,2}:\d{2} [AP]M(?: [A-Z]{3,5})?)$/;
const WEIGHT = /^(\d{1,6}(?:\.\d{1,3})?)\s*kgs?$/i;
// The tracker's answer for a number it has no consignment for, which is also its empty form's.
const NO_CONSIGNMENT = /Missing or incorrect tracking number/i;
// Firewall and bot-check pages that could stand in for the tracker's own.
const BLOCK = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden)|_cf_chl_opt|cf-turnstile|challenge-platform|captcha|incapsula|imunify360/i;
// The Australian zones the page names, by abbreviation. Another stays a wall clock.
const OFFSETS: ReadonlyMap<string, string> = new Map([
  ['AEST', '+10:00'], ['AEDT', '+11:00'], ['ACST', '+09:30'], ['ACDT', '+10:30'], ['AWST', '+08:00'],
]);
// .NET ticks (100 ns since 0001-01-01) at the Unix epoch.
const EPOCH_TICKS = 621_355_968_000_000_000n;
const HOUR_MS = 3_600_000;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A number for Hunter Express's tracker, in upper case; anything else is not one it issues. */
export function normalizeHunterExpressNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Hunter Express numbers are six to thirty letters and digits');
  return number;
}

/** A firewall or bot-check page in place of the tracker's own. */
export function isBlockPage(html: string): boolean {
  return BLOCK.test(html.slice(0, 64_000));
}

interface Clock {
  /** The calendar day the page shows, `YYYY-MM-DD`. */
  day: string;
  /** The instant, when the page names the zone or the scan carries one. */
  instant?: ParsedTime;
  /** The wall clock or day, when it does not. */
  local?: string;
}

/** A `d/MM/yyyy` day, validated. */
function dayOf(text: string): string | null {
  const match = DAY.exec(text);
  return match ? calendarDay(Number(match[3]), Number(match[2]), Number(match[1])) : null;
}

/** A `d/MM/yyyy h:mm AM ZONE` clock: an instant when the zone is known, else a wall clock. */
function clockOf(text: string): Clock | null {
  const match = CLOCK.exec(text);
  if (!match) return null;
  const day = calendarDay(Number(match[3]), Number(match[2]), Number(match[1]));
  const hour = Number(match[4]);
  if (!day || hour < 1 || hour > 12 || Number(match[5]) > 59) return null;
  const hours = String((hour % 12) + (match[6] === 'PM' ? 12 : 0)).padStart(2, '0');
  const wall = `${day}T${hours}:${match[5]}:00`;
  const offset = match[7] ? OFFSETS.get(match[7]) : undefined;
  const instant = offset ? explicitOffsetTime(`${wall}${offset}`) : null;
  return instant ? { day, instant } : { day, local: wall };
}

/**
 * The instant a grouped scan row carries in the address of its detail panel:
 * `{wording}:{place}||{day}||{consignment}||{first scan}||{last scan}`, the
 * scans as UTC ticks. Its detail panel shows the same scans in the page's
 * zone. Used only when the address names this row and this consignment, and
 * the first scan falls on the row's day in an Australian zone.
 */
function rowInstant(url: string | undefined, head: string, shownDay: string, day: string, consignment: string): ParsedTime | null {
  if (!url) return null;
  let id: string | null;
  try {
    id = new URL(url).searchParams.get('id');
  } catch {
    return null;
  }
  const parts = id?.split('||') ?? [];
  if (parts.length !== 5 || parts[0] !== head || parts[1] !== shownDay || parts[2] !== consignment) return null;
  const [first, last] = [parts[3]!, parts[4]!];
  if (!/^\d{18}$/.test(first) || !/^\d{18}$/.test(last) || BigInt(first) > BigInt(last)) return null;
  // To the second, as the other clocks are.
  const millis = Number((BigInt(first) - EPOCH_TICKS) / 10_000_000n) * 1000;
  // Australia's zones run from UTC+8 to UTC+11 in summer.
  const days = [8, 11].map((hours) => new Date(millis + hours * HOUR_MS).toISOString().slice(0, 10));
  return days.includes(day) ? epochMillisTime(millis) : null;
}

/** The text of the field the page labels `name`, or an empty string. */
function field($: CheerioAPI, name: string): string {
  return clean($(`label[name="${name}"] .label-Text`).first().text(), 200);
}

/** The delivery estimate: a day, or a window of two days. */
function estimate(text: string): { from: string | null; to: string } | null {
  const days = (text.match(/\d{1,2}\/\d{1,2}\/\d{4}/g) ?? []).map(dayOf);
  if (days.some((day) => !day)) return null;
  if (days.length === 1) return { from: null, to: days[0]! };
  if (days.length === 2 && days[0]! <= days[1]!) return { from: days[0]!, to: days[1]! };
  return null;
}

function weightOf(text: string): number | null {
  const match = WEIGHT.exec(text);
  const kilograms = match ? Number(match[1]) : NaN;
  return Number.isFinite(kilograms) && kilograms > 0 ? kilograms : null;
}

function eventOf(clock: Clock, description: string, location: string): CarrierEvent {
  const staged = hunterExpressStage(description);
  return {
    ...(clock.instant ? { time: clock.instant.iso } : { local_time: clock.local! }),
    ...(location ? { location } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/** Whether `later` is after `earlier`: by their instants, else by a later day. */
function isAfter(later: Clock, earlier: Clock): boolean {
  if (later.instant && earlier.instant) return later.instant.timestamp > earlier.instant.timestamp;
  return later.day > earlier.day;
}

/**
 * The page Hunter Express's tracker serves at `/Track/55010/{number}`. A
 * consignment gets a heading with its current status, its details (number,
 * the receiver's suburb and postcode, item count, weight and expected
 * delivery), the driver's last reading and the delivery's receiver, a map,
 * and its history: grouped scan rows, oldest first. A number the tracker has
 * no consignment for gets the empty form with "Missing or incorrect tracking
 * number".
 *
 * The details must name the whole number asked. The suburb, the item counts,
 * the driver's reading and queue, the receiver, the map's points and the
 * authority-to-leave note are not read.
 */
export function parseHunterExpress(html: string, raw: string): CarrierResult {
  const number = normalizeHunterExpressNumber(raw);
  const $ = load(html);
  const consignment = $('input#IdConsignment');
  if (!consignment.length) {
    if ($('input#ConNumberEntry').length === 1 && NO_CONSIGNMENT.test(clean($('.consignmenttrackingpage').text(), 2000))) {
      // Missing or incorrect: the tracker does not say the consignment does not exist.
      throw new IndeterminateError(PROVIDER, 'Hunter Express\'s tracker has no consignment for the number', { reason: 'portal_not_found' });
    }
    if (isBlockPage(html)) throw new ChallengeError(PROVIDER, 'Hunter Express answered with a browser check');
    throw new SchemaError(PROVIDER, 'Hunter Express returned an unexpected page');
  }
  const consignmentId = clean(consignment.attr('value'), 20);
  if (consignment.length !== 1 || !/^\d+$/.test(consignmentId)) throw new SchemaError(PROVIDER, 'Hunter Express returned an unexpected page');
  const echoed = field($, 'ConsignmentNumber').toUpperCase();
  if (!echoed) throw new SchemaError(PROVIDER, 'Hunter Express did not name the consignment');
  if (echoed !== number) throw new IndeterminateError(PROVIDER, 'Hunter Express answered for another consignment');

  const headings = $('h2').filter((_, element) => HEADING.test(clean($(element).text(), 300)));
  if (headings.length !== 1) throw new SchemaError(PROVIDER, 'Hunter Express returned no current status');
  const current = HEADING.exec(clean(headings.text(), 300))![1]!;

  const tables = $('table.GridScansAdv');
  const columns = tables.find('thead th').map((_, element) => clean($(element).text(), 40)).get();
  if (tables.length !== 1 || columns.slice(1, 4).join('|') !== 'Event|Location|Date') {
    throw new SchemaError(PROVIDER, 'Hunter Express history layout changed');
  }
  const rows = tables.find('tbody > tr');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Hunter Express returned an oversized history');

  const scans: { clock: Clock; event: CarrierEvent }[] = [];
  rows.each((_, element) => {
    const row = $(element);
    const cells = ['ScanType', 'Location', 'ScanDate'].map((name) => row.children(`td.${name}`));
    if (cells.some((cell) => cell.length !== 1)) throw new SchemaError(PROVIDER, 'Hunter Express returned an invalid scan');
    const [description, location, shown] = cells.map((cell) => clean(cell.text(), 200)) as [string, string, string];
    if (!description) throw new SchemaError(PROVIDER, 'Hunter Express returned a scan without wording');
    let clock = clockOf(shown);
    const day = clock ? null : dayOf(shown);
    if (day) {
      const instant = rowInstant(row.children('td').first().attr('childsectionurl'), `${description}:${location}`, shown, day, consignmentId);
      clock = instant ? { day, instant } : { day, local: day };
    }
    if (!clock) throw new SchemaError(PROVIDER, 'Hunter Express returned an invalid scan time');
    scans.push({ clock, event: eventOf(clock, description, location) });
  });

  // A dated status above the history that is newer than every scan, such as
  // the van leaving the depot, is the newest step.
  const timed = TIMED_STATUS.exec(current);
  const headingClock = timed ? clockOf(timed[2]!) : null;
  if (timed && headingClock && scans.every(({ clock }) => isAfter(headingClock, clock))) {
    scans.push({ clock: headingClock, event: eventOf(headingClock, timed[1]!, '') });
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER);

  // Oldest first, as the page lists them.
  const events = scans.map(({ event }) => event).reverse();
  const newest = events[0]!;
  const staged = events.find((event) => event.stage);
  const stage = staged?.stage as Stage | undefined;
  const delivered = stage === 'delivered' ? staged!.time ?? null : null;
  const finished = stage === 'delivered' || stage === 'returned';
  const expected = finished ? null : estimate(field($, 'TransitText'));
  const weight = weightOf(field($, 'TotalWeight'));
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.time ? {} : { last_update_local: newest.local_time }),
    expected_delivery: expected?.to ?? null,
    ...(expected?.from ? { expected_delivery_from: expected.from } : {}),
    delivered_at: delivered,
    ...(weight ? { weight_kg: weight } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
