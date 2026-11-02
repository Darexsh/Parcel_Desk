import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { oakHarborStage } from './status.js';

export const PROVIDER = 'Oak Harbor';
// A shipment's details are a few kilobytes, most of them the fragment's styles.
export const OAK_HARBOR_MAX_BYTES = 512 * 1024;

// Oak Harbor's PROs: eight digits, the length its forms take. The tracker reads
// a PRO as a number, so one starting with 0 would not be the same eight digits.
const NUMBER = /^[1-9]\d{7}$/;
// "07/31/19" and "16:00": the history's date and 24-hour time columns.
const DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/;
const TIME = /^(\d{1,2}):(\d{2})$/;
// A terminal's phone number after its town: "Sampleton, WA , (555) 010-0100".
const PHONE = /\s*,\s*\(?\d{3}\)?[\s.-]*\d{3}-\d{4}\s*$/;
// The signer's name a delivery row ends with: "Delivered Signature-J SMITH".
const SIGNATURE = /\s+Signature\b.*$/i;
// The answer for a PRO the tracker does not have.
const NOT_FOUND = 'Pro Not Found';
// The support notice the tracker gives for an unknown PRO and for one it cannot show.
const SUPPORT_NOTICE = /^There was an issue tracking your shipment\b/;
// A firewall or bot check's page, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|_cf_chl_opt|cf-turnstile|requested URL was rejected/i;
const HEADINGS = ['Date', 'Time', 'Action', 'Location'];
// A stage the delivery status settles over the newest row.
const SETTLED = new Set<Stage>(['delivered', 'returned', 'exception']);
const MAX_ROWS = 500;

/** An Oak Harbor PRO: eight digits. Anything else is not one the tracker is asked for. */
export function normalizeOakHarborNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Oak Harbor PROs are eight digits');
  return number;
}

/** "07/31/19" as a calendar day, or null when it is not a real one. */
function calendarDay(text: string): string | null {
  const match = DATE.exec(text);
  if (!match) return null;
  const year = match[3]!.length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
  // UTC only checks the calendar fields. No offset is assigned.
  const parsed = DateTime.fromObject({ year, month: Number(match[1]), day: Number(match[2]) }, { zone: 'UTC' });
  return parsed.isValid ? parsed.toFormat('yyyy-MM-dd') : null;
}

/** A row's date and time as a wall clock; a row without a time keeps its day. The page gives no zone. */
function wallClock(date: string, time: string): string | null {
  const day = calendarDay(date);
  if (!day || !time) return day;
  const match = TIME.exec(time);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return null;
  return `${day}T${match[1]!.padStart(2, '0')}:${match[2]}:00`;
}

/**
 * The value after one label of the shipment's information, or '' without
 * one. Only the labels asked for are read.
 */
function labelled($: CheerioAPI, block: Cheerio<AnyNode>, label: string): string {
  const labels = block.find('span.notAuthThin').filter((_, span) => clean($(span).text(), 80) === label);
  if (labels.length > 1) throw new SchemaError(PROVIDER, 'Oak Harbor repeated a detail of the shipment');
  if (!labels.length) return '';
  const line = labels.parent().clone();
  line.children('span.notAuthThin').first().remove();
  return clean(line.text(), 120);
}

/** A history row's place: its town, without a terminal's phone number. */
function place(cell: Cheerio<AnyNode>): string {
  return clean(clean(cell.text(), 200).replace(PHONE, ''), 80);
}

interface Row { key: string; event: CarrierEvent }

/**
 * One row of the trace history: its date, its time, the action and the
 * place. A terminal's place carries its address in a tooltip and its phone
 * number after the town, and neither is read.
 */
function row(cells: Cheerio<AnyNode>): Row {
  if (cells.length !== 4) throw new SchemaError(PROVIDER, 'Oak Harbor changed its trace history');
  const local_time = wallClock(clean(cells.eq(0).text(), 32), clean(cells.eq(1).text(), 32));
  const description = clean(cells.eq(2).text(), 300).replace(SIGNATURE, '');
  if (!local_time || !description) throw new SchemaError(PROVIDER, 'Oak Harbor returned a row without its clock and action');
  const location = place(cells.eq(3));
  const staged = oakHarborStage(description);
  const event: CarrierEvent = {
    local_time,
    ...(location ? { location } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([local_time, description, location]), event };
}

/** The rows of the trace history, newest first and once each. */
function history($: CheerioAPI): CarrierEvent[] {
  const table = $('#traceDetailsTable');
  if (table.length !== 1) throw new SchemaError(PROVIDER, 'Oak Harbor returned details without their trace history');
  const rows = table.find('tr');
  const headings = rows.first().children('th').map((_, cell) => clean($(cell).text(), 40)).get();
  if (headings.join('|') !== HEADINGS.join('|')) throw new SchemaError(PROVIDER, 'Oak Harbor changed its trace history');
  if (rows.length - 1 > MAX_ROWS) throw new SchemaError(PROVIDER, 'Oak Harbor returned an oversized history');
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  rows.slice(1).each((_, node) => {
    const parsed = row($(node).children('td'));
    if (seen.has(parsed.key)) return;
    seen.add(parsed.key);
    events.push(parsed.event);
  });
  // The page lists the newest first; a list the other way round is turned round.
  return events.length > 1 && events[0]!.local_time! < events.at(-1)!.local_time! ? events.reverse() : events;
}

/**
 * The notice the tracker gives in place of a shipment. Only "Pro Not Found"
 * says the PRO has none; the support notice also answers a PRO the tracker
 * cannot show, so it is inconclusive.
 */
function notice(text: string): never {
  if (text === NOT_FOUND) throw new NotFoundError(PROVIDER);
  if (SUPPORT_NOTICE.test(text)) {
    throw new IndeterminateError(PROVIDER, 'Oak Harbor answered with its support notice', { reason: 'portal_not_found' });
  }
  throw new SchemaError(PROVIDER, 'Oak Harbor answered with a notice it does not usually give');
}

/**
 * The fragment `tracingactions.php` returns for `loadTraceDetails`: the
 * number it looked up in hidden fields, then either a notice or the
 * shipment's information (its PRO, references, parties, destination
 * terminal, delivery status and estimate) and its trace history, newest
 * first, with a form to request documents by email.
 */
export function parseOakHarbor(html: string, rawNumber: string): CarrierResult {
  const number = normalizeOakHarborNumber(rawNumber);
  const $ = load(html);
  const asked = ['#currentNum', '#currentPro'].map((id) => $(`input${id}`));
  if (asked.some((field) => field.length !== 1)) {
    if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Oak Harbor answered with a block page');
    throw new SchemaError(PROVIDER, 'Oak Harbor did not return its trace details');
  }
  // The fields name the lookup, not the shipment: they echo what was asked.
  if (asked.some((field) => clean(field.attr('value'), 64) !== number) || clean($('input#currentNumType').attr('value'), 16) !== 'OHPRO') {
    throw new IndeterminateError(PROVIDER, 'Oak Harbor answered for another lookup');
  }
  const notices = $('.errorMsg');
  if (notices.length) notice(clean(notices.first().text(), 200));

  const block = $('.dtlBlock').filter((_, node) => clean($(node).children('.dtlHeader').text(), 80) === 'Pro Information');
  if (block.length !== 1) throw new SchemaError(PROVIDER, 'Oak Harbor returned details without the shipment’s information');
  const pro = labelled($, block, 'OAKH Pro:');
  if (!pro) throw new SchemaError(PROVIDER, 'Oak Harbor returned a shipment without its PRO');
  // The tracker also finds shipments by other references; only the PRO asked counts.
  if (pro !== number) throw new IndeterminateError(PROVIDER, 'Oak Harbor answered for another shipment');

  const status = labelled($, block, 'Delivery Status:');
  const headline: ClassifiedWording | null = status ? oakHarborStage(status) : null;
  const events = history($);
  if (!events.length) throw new NoHistoryError(PROVIDER);

  // The delivery status settles a delivery, a return or a problem, and a
  // shipment without a staged row; otherwise the newest staged row is ahead of it.
  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  const settled = headline !== null && (SETTLED.has(headline.stage) || !scanned);
  const decided = settled ? headline : scanned ? { stage: scanned.stage as Stage, source: scanned.stage_source! } : null;
  const done = decided !== null && SETTLED.has(decided.stage);
  return {
    status: decided ? languageStageStatus(decided.stage) : 'unknown',
    ...(decided ? { current_stage: decided.stage, current_stage_source: decided.source } : {}),
    last_status_text: (settled ? status : newest.description) || status || null,
    last_update: null,
    last_update_local: newest.local_time!,
    expected_delivery: done ? null : calendarDay(labelled($, block, 'Estimated Delivery:')),
    events,
  };
}
