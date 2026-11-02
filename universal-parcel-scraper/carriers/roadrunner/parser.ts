import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { roadrunnerStage } from './status.js';

export const PROVIDER = 'Roadrunner';
// A shipment's fragment is about 20 kB, most of it styles and forms.
export const ROADRUNNER_MAX_BYTES = 512 * 1024;

// Roadrunner's PROs are nine digits; an eight-digit PRO takes a leading zero.
const NUMBER = /^\d{9}$/;
const SHORT = /^\d{8}$/;
// "04/28/2023" and "09:27 PM": the travel history's date and time columns.
const DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const TIME = /^(\d{1,2}):(\d{2}) ([AP]M)$/;
const HEADINGS = ['Date', 'Time', 'Status'];
// The terminal a row names: the one a trailer left, reached or was unloaded at,
// or the one a delivery run left. Current rows name the terminal ("Commerce
// terminal"); older ones its town and state ("terminal in CLIFTON, NJ").
const PLACES = [
  /^Trailer dispatched from (.+?)(?: terminal)? to \S.*$/i,
  /^Trailer (?:arrived|unloaded) at (?:terminal in )?(.+?)(?: terminal)?\.?$/i,
  /^Shipment out for delivery from (.+?)\.?$/i,
];
// A signer's name a delivery row could end with.
const SIGNATURE = /\s*[-,:;]?\s*\b(?:signed(?: for)? by|signature)\b.*$/i;
// The portal's answer for a PRO it does not have.
const NOT_FOUND = /^Invalid PRO number\b/;
// A firewall or bot check's page, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|_cf_chl_opt|cf-turnstile|requested URL was rejected/i;
// A stage the shipment status settles over the newest row.
const SETTLED = new Set<Stage>(['delivered', 'returned', 'exception']);
const MAX_ROWS = 500;

/**
 * A Roadrunner PRO: nine digits, or eight that take a leading zero. Anything
 * else is not one the tracker is asked for.
 */
export function normalizeRoadrunnerNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (SHORT.test(number)) return `0${number}`;
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Roadrunner PROs are nine digits');
  return number;
}

/** The same PRO, whether written with its leading zeros or without. */
function samePro(shown: string, number: string): boolean {
  return /^\d{1,9}$/.test(shown) && shown.replace(/^0+/, '') === number.replace(/^0+/, '');
}

/** "04/28/2023" as a calendar day, or null when it is not a real one. */
function calendarDay(text: string): string | null {
  const match = DATE.exec(text);
  if (!match) return null;
  // UTC only checks the calendar fields. No offset is assigned.
  const parsed = DateTime.fromObject({ year: Number(match[3]), month: Number(match[1]), day: Number(match[2]) }, { zone: 'UTC' });
  return parsed.isValid ? parsed.toFormat('yyyy-MM-dd') : null;
}

/** A row's date and time as a wall clock; a row without a time keeps its day. The page gives no zone. */
function wallClock(date: string, time: string): string | null {
  const day = calendarDay(date);
  if (!day || !time) return day;
  const match = TIME.exec(time);
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 12 || Number(match[2]) > 59) return null;
  const hour = (Number(match[1]) % 12) + (match[3] === 'PM' ? 12 : 0);
  return `${day}T${String(hour).padStart(2, '0')}:${match[2]}:00`;
}

/**
 * The value next to one label of the shipment overview or the services, or
 * '' without one. Only the labels asked for are read.
 */
function labelled($: CheerioAPI, table: Cheerio<AnyNode>, label: string): string {
  const rows = table.find('tr').filter((_, row) => clean($(row).children('td').first().text(), 80) === label);
  if (rows.length > 1) throw new SchemaError(PROVIDER, 'Roadrunner repeated a detail of the shipment');
  return rows.length ? clean(rows.children('td').eq(1).text(), 120) : '';
}

/** The table under one of the fragment's section headings, or none. */
function section($: CheerioAPI, heading: string): Cheerio<AnyNode> {
  const headings = $('h5').filter((_, node) => clean($(node).text(), 80) === heading);
  if (headings.length > 1) throw new SchemaError(PROVIDER, 'Roadrunner repeated a section of the shipment');
  return headings.nextAll('table').first();
}

/** The terminal a row names, as the page writes it. */
function place(description: string): string {
  for (const pattern of PLACES) {
    const match = pattern.exec(description);
    if (match) return clean(match[1], 60);
  }
  return '';
}

interface Row { key: string; event: CarrierEvent }

/** One row of the travel history: its date, its time and the status. */
function row(cells: Cheerio<AnyNode>): Row {
  if (cells.length !== 3) throw new SchemaError(PROVIDER, 'Roadrunner changed its travel history');
  const local_time = wallClock(clean(cells.eq(0).text(), 32), clean(cells.eq(1).text(), 32));
  const description = clean(cells.eq(2).text(), 300).replace(SIGNATURE, '');
  if (!local_time || !description) throw new SchemaError(PROVIDER, 'Roadrunner returned a row without its clock and status');
  const location = place(description);
  const staged = roadrunnerStage(description);
  const event: CarrierEvent = {
    local_time,
    ...(location ? { location } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([local_time, description]), event };
}

/** The rows of the travel history, newest first and once each. */
function history($: CheerioAPI): CarrierEvent[] {
  const table = section($, 'Travel History');
  if (table.length !== 1) throw new SchemaError(PROVIDER, 'Roadrunner returned a shipment without its travel history');
  const headings = table.find('thead th').map((_, cell) => clean($(cell).text(), 40)).get();
  if (headings.join('|') !== HEADINGS.join('|')) throw new SchemaError(PROVIDER, 'Roadrunner changed its travel history');
  const rows = table.find('tbody tr');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Roadrunner returned an oversized history');
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  rows.each((_, node) => {
    const parsed = row($(node).children('td'));
    if (seen.has(parsed.key)) return;
    seen.add(parsed.key);
    events.push(parsed.event);
  });
  // The page lists the oldest first; a list already the other way round is kept.
  return events.length > 1 && events[0]!.local_time! <= events.at(-1)!.local_time! ? events.reverse() : events;
}

/** The status under the "Shipment Status" heading. */
function shipmentStatus($: CheerioAPI): string {
  const headings = $('h5').filter((_, node) => clean($(node).text(), 80) === 'Shipment Status');
  if (headings.length !== 1) throw new SchemaError(PROVIDER, 'Roadrunner returned a shipment without its status');
  return clean(headings.next('h5').text(), 120);
}

/**
 * The fragment `LTLTrack/TrackingShipment/ShipmentDataTab/{PRO}` returns for
 * one lookup: an alert for a number it does not have, or the shipment's
 * status, the parties, the shipment overview (its PRO, pickup number, bill of
 * lading and due date), the travel history oldest first, the services and the
 * documents.
 */
export function parseRoadrunner(html: string, rawNumber: string): CarrierResult {
  const number = normalizeRoadrunnerNumber(rawNumber);
  const $ = load(html);
  if ($('#ShipmentTabContainer').length !== 1) {
    const alert = clean($('.alert-danger').first().text(), 200);
    if (NOT_FOUND.test(alert)) throw new NotFoundError(PROVIDER);
    if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Roadrunner answered with a block page');
    throw new SchemaError(PROVIDER, 'Roadrunner did not return a shipment');
  }
  const overview = section($, 'Shipment Overview');
  if (overview.length !== 1) throw new SchemaError(PROVIDER, 'Roadrunner returned a shipment without its overview');
  const pro = labelled($, overview, 'Pro:');
  if (!pro) throw new SchemaError(PROVIDER, 'Roadrunner returned a shipment without its PRO');
  // The portal also finds a shipment by its pickup number; only the PRO asked counts.
  if (!samePro(pro, number)) throw new IndeterminateError(PROVIDER, 'Roadrunner answered for another shipment');

  const status = shipmentStatus($);
  const headline: ClassifiedWording | null = status ? roadrunnerStage(status) : null;
  const events = history($);
  if (!events.length) throw new NoHistoryError(PROVIDER);

  // The shipment status settles a delivery, a return or a problem, and a
  // shipment without a staged row; otherwise the newest staged row is ahead of it.
  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  const settled = headline !== null && (SETTLED.has(headline.stage) || !scanned);
  const decided = settled ? headline : scanned ? { stage: scanned.stage as Stage, source: scanned.stage_source! } : null;
  const done = decided !== null && SETTLED.has(decided.stage);
  const services = section($, 'Services');
  const service = services.length ? labelled($, services, 'Service') : '';
  return {
    status: decided ? languageStageStatus(decided.stage) : 'unknown',
    ...(decided ? { current_stage: decided.stage, current_stage_source: decided.source } : {}),
    last_status_text: (settled ? status : newest.description) || status || null,
    last_update: null,
    last_update_local: newest.local_time!,
    expected_delivery: done ? null : calendarDay(labelled($, overview, 'Due Date:')),
    ...(service ? { service_name: service } : {}),
    events,
  };
}
