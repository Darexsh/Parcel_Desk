import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { teamHiddenRow, teamStage } from './status.js';

export const PROVIDER = 'Team Worldwide';
/** The Team Trac page, which its form posts to and which renders the answer on the server. */
export const TEAM_TRAC = 'https://www.teamww.com/tracking/team-trac';
// The page is under sixty kilobytes, most of it the site around the answer.
export const TEAM_MAX_BYTES = 1_000_000;

// Team bills: a station code and six digits, sometimes with a closing letter; a
// two-digit year, a station code, a letter and six digits; or a station code
// before a shipper's reference of a letter and eight digits, sometimes with a
// closing letter.
const NUMBER = /^(?:[A-Z]{3}\d{6}[A-Z]?|\d{2}[A-Z]{4}\d{6}|[A-Z]{4}\d{8}[A-Z]?)$/;
// The page's answer for a bill it has no status for, naming the bill.
const NOT_AVAILABLE = /^Status is not available for Team Bill #\s*(\S{1,64})\s+Please check again later/i;
const CODE = /^[A-Z0-9]{2,5}$/;
const DAY = /^(\d{4})(\d{2})(\d{2})$/;
const TIME = /^(\d{2})(\d{2})$/;
// "2016-12-13", the header's day.
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
// Whoever signed for the freight, after the words that introduce them.
const SIGNER = /^(SIGNED FOR)\b.*$/i;
// A delivery or pickup appointment, stamped when it was booked, and the day it is
// booked for; a window and the booking agent's name can follow.
const APPOINTMENT = /^(APPT FOR (DEL|PKU) SCHED)\b(?:\s+(\d{8})\b)?/i;
// A town and its state after a row's wording: "OUT FOR DELIVERY - EXAMPLETOWN, TX".
const PLACE = /^(.*\S)\s+-\s+(\p{L}[\p{L} .'-]{0,59}, [A-Z]{2})$/u;
// Free text after a row's wording, which can name someone.
const SUFFIX = /^(.*?\S)\s+-\s+.*$/;
// Firewall and bot check pages, which can stand in for the page with HTTP 200.
const CHALLENGE = /Web Page Blocked|Attack ID:|FortiGuard|FortiWeb|_cf_chl_opt|cf-turnstile|_Incapsula_Resource|g-recaptcha|h-captcha|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|requested URL was rejected/i;
// The stages a shipment moves forward through, in order.
const FORWARD: readonly Stage[] = ['registered', 'accepted', 'in_transit', 'out_for_delivery', 'delivered'];
const FINAL: ReadonlySet<Stage> = new Set(['delivered', 'returned']);
const MAX_ANSWERS = 50;
const MAX_ROWS = 300;

/** A Team bill number in capitals, as the page prints it; anything else is not one Team Trac looks up. */
export function normalizeTeamNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Team bill numbers are a station code with six digits, or a station code with a year or a shipper\'s reference');
  return number;
}

function invalid(message: string): never {
  throw new SchemaError(PROVIDER, message);
}

/** "20161214" and "0820" as a wall clock. No clock names its zone. */
function clockOf(date: string, time: string): string {
  const day = DAY.exec(date);
  const calendar = day ? calendarDay(Number(day[1]), Number(day[2]), Number(day[3])) : null;
  if (!calendar) invalid('Team Trac returned an invalid history date');
  const clock = TIME.exec(time);
  if (!clock || Number(clock[1]) > 23 || Number(clock[2]) > 59) invalid('Team Trac returned an invalid history time');
  return `${calendar}T${clock[1]}:${clock[2]}:00`;
}

interface Row {
  event: CarrierEvent;
  /** The day a delivery appointment is booked for, which is an estimate and not a scan. */
  appointment: string | null;
}

/** A row's wording without the signer, the booking agent or other free text, and its place when it names one. */
function wordingOf(raw: string): { description: string; location?: string; appointment: string | null } {
  const signed = SIGNER.exec(raw);
  if (signed) return { description: signed[1]!.toUpperCase(), appointment: null };
  const booked = APPOINTMENT.exec(raw);
  if (booked) {
    const date = booked[3] ? DAY.exec(booked[3]) : null;
    const day = date && booked[2]!.toUpperCase() === 'DEL' ? calendarDay(Number(date[1]), Number(date[2]), Number(date[3])) : null;
    return { description: booked[1]!.toUpperCase(), appointment: day };
  }
  const placed = PLACE.exec(raw);
  if (placed) return { description: SUFFIX.exec(placed[1]!)?.[1] ?? placed[1]!, location: placed[2]!, appointment: null };
  return { description: SUFFIX.exec(raw)?.[1] ?? raw, appointment: null };
}

/** One row of the status details: its code, date, time and wording. A remark is left out. */
function rowOf($: CheerioAPI, row: Element): Row | null {
  const cells = $(row).children('td').toArray().map((cell) => clean($(cell).text(), 300));
  if (cells.length !== 4) invalid('Team Trac returned an unexpected history row');
  const [code, date, time, wording] = cells as [string, string, string, string];
  if (!CODE.test(code)) invalid('Team Trac returned a history row without its code');
  const local_time = clockOf(date, time);
  if (!wording) invalid('Team Trac returned a history row without its wording');
  if (teamHiddenRow(code)) return null;
  const { description, location, appointment } = wordingOf(wording);
  const staged = teamStage(code, description);
  return {
    event: {
      local_time,
      ...(location ? { location } : {}),
      description,
      provider_code: code,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    },
    appointment,
  };
}

interface Shipment {
  number: string;
  /** The header's status, such as "IN TRANSIT". */
  status: string;
  /** The header's estimated delivery day. */
  requested: string | null;
  rows: Row[];
}

/** The header's rows by their label, without the marker of an estimate. */
function headerOf($: CheerioAPI, table: Cheerio<Element>): Map<string, string> {
  const header = new Map<string, string>();
  for (const row of table.children('tbody').children('tr').toArray()) {
    const cells = $(row).children('td').toArray().map((cell) => clean($(cell).text(), 120));
    if (cells.length !== 2) invalid('Team Trac returned an unexpected shipment header');
    header.set(cells[0]!.replace(/^\*\s*/, '').toLowerCase(), cells[1]!);
  }
  return header;
}

/** "2016-12-13" as a calendar day, or null. */
function isoDay(value: string | undefined): string | null {
  const match = ISO_DAY.exec(value ?? '');
  return match ? calendarDay(Number(match[1]), Number(match[2]), Number(match[3])) : null;
}

/** A shipment the page answers with: its bill, and the rest only for the bill asked. */
function shipmentOf($: CheerioAPI, block: Cheerio<Element>, asked: string): Shipment | { number: string } {
  const tables = block.children('div.trac').children('table');
  if (tables.length !== 1) invalid('Team Trac returned a shipment without its header');
  const heading = tables.children('thead').find('th').toArray().map((cell) => clean($(cell).text(), 64));
  if (heading.length !== 2 || heading[0] !== 'Team Bill #' || !heading[1]) invalid('Team Trac returned a shipment without its bill');
  const number = normalizeTrackingNumber(heading[1]);
  if (number !== asked) return { number };
  const header = headerOf($, tables);
  const status = header.get('status');
  if (status === undefined) invalid('Team Trac returned a shipment without its status');
  const details = block.children('div.statusDetail').children('table');
  if (details.length > 1) invalid('Team Trac returned several histories for one shipment');
  const rows = details.children('tbody').children('tr').toArray();
  if (rows.length > MAX_ROWS) invalid('Team Trac returned an oversized history');
  return {
    number,
    status,
    requested: isoDay(header.get('requested delivery')),
    rows: rows.map((row) => rowOf($, row)).filter((row): row is Row => row !== null),
  };
}

/** The newest-first history without repeated rows. */
function distinct(events: readonly CarrierEvent[]): CarrierEvent[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    const key = JSON.stringify([event.local_time, event.provider_code, event.description, event.location ?? '']);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The Team Trac page `www.teamww.com/tracking/team-trac` as it answers its
 * form. Each bill asked has a block: the shipment's header, with its bill, its
 * status, the shipper's reference, the town and ZIP code it goes to, the
 * signer and an estimate, and its status details newest first; or a notice
 * that no status is available for the bill. Only the block of the bill asked
 * is read. The reference, the town and ZIP code, the signer, the remarks, the
 * booking agents and the office's phone number are not.
 */
export function parseTeam(html: string, raw: string): CarrierResult {
  const asked = normalizeTeamNumber(raw);
  const $ = load(html);
  const blocks = $('div.tracInfo').toArray();
  if (blocks.length > MAX_ANSWERS) invalid('Team Trac returned too many answers');
  if (!blocks.length) {
    if (CHALLENGE.test(html.slice(0, 200_000))) throw new ChallengeError(PROVIDER, 'Team Trac answered with a block page');
    invalid('Team Trac returned a page without an answer');
  }
  const missing: string[] = [];
  const shipments: (Shipment | { number: string })[] = [];
  for (const node of blocks) {
    const block = $(node);
    if (block.children('div.trac').length) {
      shipments.push(shipmentOf($, block, asked));
      continue;
    }
    const notice = NOT_AVAILABLE.exec(clean(block.text(), 500));
    if (!notice) invalid('Team Trac returned an unexpected notice');
    missing.push(normalizeTrackingNumber(notice[1]!));
  }
  const own = shipments.filter((shipment): shipment is Shipment => 'status' in shipment);
  if (own.length > 1) throw new IndeterminateError(PROVIDER, 'Team Trac answered with several shipments for the bill');
  const shipment = own[0];
  if (!shipment) {
    if (missing.includes(asked)) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Team Trac answered for another bill');
  }

  const events = distinct(shipment.rows.map((row) => row.event));
  const headline = shipment.status ? teamStage(null, shipment.status) : null;
  if (!events.length && !shipment.status) throw new NoHistoryError(PROVIDER);

  // A delivery ends the shipment, whether a row or the header says so; otherwise
  // the further of the newest staged row and the header's status is the state.
  const delivery = events.find((event) => event.stage === 'delivered');
  const staged = events.find((event) => event.stage);
  const row: ClassifiedWording | null = staged ? { stage: staged.stage as Stage, source: staged.stage_source! } : null;
  const ahead = headline !== null && (headline.stage === 'delivered' || !row
    || (FORWARD.includes(row.stage) && FORWARD.includes(headline.stage) && FORWARD.indexOf(headline.stage) > FORWARD.indexOf(row.stage)));
  const fromHeader = !delivery && ahead;
  const decided = delivery ? { stage: 'delivered' as Stage, source: delivery.stage_source! } : fromHeader ? headline : row;
  const current = fromHeader ? undefined : delivery ?? events[0];
  const clocks = events.map((event) => String(event.local_time)).sort();
  const newest = clocks.length ? clocks.at(-1)!.slice(0, 10) : null;
  // Until the delivery, the newest delivery appointment's day, else the header's
  // estimate; a day before the newest row's is stale.
  const estimate = shipment.rows.find((entry) => entry.appointment)?.appointment ?? shipment.requested;
  const settled = decided !== null && FINAL.has(decided.stage);
  return {
    status: decided ? languageStageStatus(decided.stage) : 'unknown',
    ...(decided ? { current_stage: decided.stage, current_stage_source: decided.source } : {}),
    last_status_text: fromHeader ? shipment.status : current?.description ?? (shipment.status || null),
    last_update: null,
    ...(current?.local_time ? { last_update_local: current.local_time } : {}),
    expected_delivery: !settled && estimate && !(newest && estimate < newest) ? estimate : null,
    ...(events.length ? {} : { summary_only: true }),
    events,
  };
}
