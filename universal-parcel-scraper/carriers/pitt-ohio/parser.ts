import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { pittOhioStage } from './status.js';

export const PROVIDER = 'Pitt Ohio';
// A shipment's page is about 85 kB, most of it the site around the tracking.
export const PITT_OHIO_MAX_BYTES = 1024 * 1024;

// Pitt Ohio's PRO numbers: ten digits, the length of the PRO field of its bill of lading API.
const NUMBER = /^\d{10}$/;
// "7/1/2026" and "3:13 PM": the history's date and time columns.
const DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const TIME = /^(\d{1,2}):(\d{2}) ([AP]M)$/;
// A row ending with the place it happened: "… in Parkersburg, WV", or a
// terminal's name, "… in Washington,PA". The last " in " opens the place.
const PLACE = /^(.*\S)\s+in\s+([A-Za-z][A-Za-z .'-]{0,59}?)\s*,\s*([A-Z]{2})$/;
// The search form's notice when the lookup finds nothing.
const NO_RESULTS = 'Search returned no results.';
// A firewall or bot check's page, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|_cf_chl_opt|cf-turnstile|requested URL was rejected/i;
// A stage the page's status settles over the newest row.
const SETTLED = new Set<Stage>(['delivered', 'returned', 'exception']);
const MAX_ROWS = 500;

/** A Pitt Ohio PRO number: ten digits. Anything else is not one the tracker is asked for. */
export function normalizePittOhioNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Pitt Ohio PRO numbers are ten digits');
  return number;
}

/** "7/1/2026" as a calendar day, or null when it is not a real one. */
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
 * The value next to one label of the current status table, or '' without
 * one. Only the labels asked for are read.
 */
function labelled($: CheerioAPI, content: Cheerio<AnyNode>, label: string): string {
  const rows = content.find('tr').filter((_, row) => clean($(row).children('th').text(), 80) === label);
  if (rows.length > 1) throw new SchemaError(PROVIDER, 'Pitt Ohio repeated a detail of the shipment');
  return rows.length ? clean(rows.children('td').text(), 120) : '';
}

interface Row { key: string; event: CarrierEvent }

/**
 * One row of the shipment history: its date, its time and the status, which
 * can end with the place. A terminal's place opens a pop-up with the
 * terminal's address and phone numbers, which is not read.
 */
function row(cells: Cheerio<AnyNode>): Row {
  if (cells.length !== 2 && cells.length !== 3) throw new SchemaError(PROVIDER, 'Pitt Ohio changed its shipment history');
  const status = cells.last().clone();
  status.find('.hide').remove();
  const text = clean(status.text(), 300);
  const local_time = wallClock(clean(cells.first().text(), 32), cells.length === 3 ? clean(cells.eq(1).text(), 32) : '');
  if (!local_time || !text) throw new SchemaError(PROVIDER, 'Pitt Ohio returned a row without its clock and status');
  const place = PLACE.exec(text);
  const description = place ? place[1]! : text;
  const location = place ? `${clean(place[2], 60)}, ${place[3]}` : '';
  const staged = pittOhioStage(description);
  const event: CarrierEvent = {
    local_time,
    ...(location ? { location } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([local_time, description, location]), event };
}

/** The rows of the shipment history, newest first and once each. */
function history($: CheerioAPI, content: Cheerio<AnyNode>): CarrierEvent[] {
  const headings = content.find('td.sectionHeading').filter((_, cell) => clean($(cell).text(), 80) === 'Shipment History');
  if (headings.length !== 1) throw new SchemaError(PROVIDER, 'Pitt Ohio returned a page without its shipment history');
  const rows = headings.closest('table').find('tr')
    .filter((_, node) => $(node).children('td').length > 0 && !$(node).children('td.sectionHeading').length);
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Pitt Ohio returned an oversized history');
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  rows.each((_, node) => {
    const parsed = row($(node).children('td'));
    if (seen.has(parsed.key)) return;
    seen.add(parsed.key);
    events.push(parsed.event);
  });
  // The page lists the newest first; a list the other way round is turned round.
  return events.length > 1 && events[0]!.local_time! < events.at(-1)!.local_time! ? events.reverse() : events;
}

/**
 * The search form the tracker answers with when it shows no shipment. Its
 * notice is the only missing shipment, and the form keeps the number it
 * looked up in its first field.
 */
function searchForm($: CheerioAPI, number: string): never {
  const notices = $('.zone-messages .alert-warning').filter((_, notice) => clean($(notice).text(), 200).includes(NO_RESULTS));
  if (!notices.length) throw new SchemaError(PROVIDER, 'Pitt Ohio returned its search form without an answer');
  const asked = $('#traceForm input[name="TrackingNumbers[0]"]');
  if (asked.length !== 1 || clean(asked.attr('value'), 64) !== number) {
    throw new IndeterminateError(PROVIDER, 'Pitt Ohio answered for another number');
  }
  throw new NotFoundError(PROVIDER);
}

/**
 * The page `myPittOhio/Shipping/LTL/TraceRequest?pro=` renders for one PRO
 * number: the current status (the PRO number, the status and its day), then
 * the shipment history, a row per scan with its date, its time and the status,
 * newest first. A number without a shipment comes back on the search form
 * with a notice.
 */
export function parsePittOhio(html: string, rawNumber: string): CarrierResult {
  const number = normalizePittOhioNumber(rawNumber);
  const $ = load(html);
  const content = $('.zone-content');
  const heading = clean(content.find('h1').first().text(), 80);
  if (heading === 'LTL Shipment Tracing') searchForm($, number);
  if (heading === 'LTL Shipment Status Results') throw new IndeterminateError(PROVIDER, 'Pitt Ohio listed several shipments for the number');
  if (heading !== 'LTL Shipment Status Details') {
    if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Pitt Ohio answered with a block page');
    throw new SchemaError(PROVIDER, 'Pitt Ohio did not return a shipment status page');
  }
  const pro = labelled($, content, 'Pro #:');
  if (!pro) throw new SchemaError(PROVIDER, 'Pitt Ohio returned a shipment without its PRO number');
  if (pro !== number) throw new IndeterminateError(PROVIDER, 'Pitt Ohio answered for another shipment');

  const status = labelled($, content, 'Status:');
  const headline: ClassifiedWording | null = status ? pittOhioStage(status) : null;
  const rows = history($, content);
  // Without rows, the current status and its day are the history.
  const day = calendarDay(labelled($, content, 'Current Status Date:'));
  const events: CarrierEvent[] = rows.length ? rows : status && day
    ? [{ local_time: day, description: status, ...(headline ? { stage: headline.stage, stage_source: headline.source } : {}) }]
    : [];
  if (!events.length) throw new NoHistoryError(PROVIDER);

  // The page's status settles a delivery, a return or a problem, and a
  // shipment without a staged row; otherwise the newest staged row is ahead of it.
  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  const settled = headline !== null && (SETTLED.has(headline.stage) || !scanned);
  const decided = settled ? headline : scanned ? { stage: scanned.stage as Stage, source: scanned.stage_source! } : null;
  return {
    status: decided ? languageStageStatus(decided.stage) : 'unknown',
    ...(decided ? { current_stage: decided.stage, current_stage_source: decided.source } : {}),
    last_status_text: (settled ? status : newest.description) || status || null,
    last_update: null,
    last_update_local: newest.local_time!,
    expected_delivery: null,
    ...(rows.length ? {} : { summary_only: true }),
    events,
  };
}
