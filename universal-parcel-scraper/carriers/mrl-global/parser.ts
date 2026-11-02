import { load, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type ClassifiedWording } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { mrlStage } from './status.js';

export const PROVIDER = 'MRL Global';
/** The tracking page, which looks one consignment up on the server and renders it. */
export const MRL_TRACKING = 'https://www.mrlglobal.com/tracking/';
// Every page carries about 200 kilobytes of site template; a consignment's history adds little.
export const MRL_MAX_BYTES = 2_000_000;

// A consignment note: C, three letters and six digits.
const NUMBER = /^C[A-Z]{3}\d{6}$/;
const DAY = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const HOUR = /^(\d{2}):(\d{2})$/;
// The latest update's clock: "25/11/2024 - 13:29".
const STAMP = /^(\d{2}\/\d{2}\/\d{4})\s*-\s*(\d{2}:\d{2})$/;
// A depot scan carries the depot in brackets, which can be empty.
const DEPOT = /^(Scanned in Depot)\s*\(([^()]{0,80})\)$/i;
const NO_DETAILS = /^No details Found$/i;
const NOT_FOUND = /^Error\s*:\s*Invalid Connote number$/i;
// The form the page shows when it was given no number.
const EMPTY_FORM = /Please enter ConnoteNo/i;
// Bot checks Cloudflare, in front of the site, could put in place of the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|<title>\s*Attention Required|cf-error-details|g-recaptcha|h-captcha|captcha/i;
const MAX_ROWS = 2_000;
const MAX_EVENTS = 100;

/** An MRL Global consignment note, as typed; anything else is not one MRL Global issues. */
export function normalizeMrlNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) {
    throw new InvalidInputError(PROVIDER, 'MRL Global consignment notes are C, three letters and six digits');
  }
  return number;
}

function invalid(message: string): never {
  throw new SchemaError(PROVIDER, message);
}

/** A row's wall clock, checked against the calendar. */
function clockOf(day: string, hour: string): string {
  const date = DAY.exec(day);
  const time = HOUR.exec(hour);
  const calendar = date ? calendarDay(Number(date[3]), Number(date[2]), Number(date[1])) : null;
  if (!calendar || !time || Number(time[1]) > 23 || Number(time[2]) > 59) invalid('MRL Global returned an invalid scan time');
  return `${calendar}T${time[1]}:${time[2]}:00`;
}

/** A label without the depot a depot scan names in brackets, and that depot. */
function labelOf(text: string): { description: string; location: string } {
  const label = clean(text, 160);
  const depot = DEPOT.exec(label);
  return depot ? { description: depot[1]!, location: clean(depot[2], 80) } : { description: label, location: '' };
}

/** The consignment number the page heads its answer with. */
function consignmentOf($: CheerioAPI): string {
  const values = $('.consignment_box strong').toArray()
    .filter((label) => /^Consignment Number:?$/i.test(clean($(label).text(), 40)))
    // The number is the text after the label, up to the line break.
    .map((label) => (label.nextSibling?.nodeType === 3 ? clean($(label.nextSibling).text(), 64) : ''));
  if (values.length !== 1 || !values[0]) invalid('MRL Global returned a consignment without its number');
  return normalizeTrackingNumber(values[0]);
}

function eventOf($: CheerioAPI, row: Element, number: string): CarrierEvent {
  const cells = new Map($(row).children('td').toArray().map((cell) => [clean($(cell).attr('data-title'), 40), clean($(cell).text(), 160)]));
  const connote = cells.get('Connote');
  const event = cells.get('Event');
  const day = cells.get('Date');
  const hour = cells.get('Time');
  if (!connote || !event || !day || !hour) invalid('MRL Global returned an incomplete scan');
  if (normalizeTrackingNumber(connote) !== number) throw new IndeterminateError(PROVIDER, 'MRL Global answered for another consignment');
  const { description, location } = labelOf(event);
  if (!description) invalid('MRL Global returned a scan without its event');
  const staged = mrlStage(description);
  return {
    local_time: clockOf(day, hour),
    ...(location ? { location } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/** A row's wall clock, which sorts as text. */
const clockText = (event: CarrierEvent) => (typeof event.local_time === 'string' ? event.local_time : '');

/**
 * Rows newest first by their clocks, a row repeated for several items kept
 * once. The page groups its rows by event label, newest first within each
 * group, but orders the groups by neither clock nor progress. Rows of one
 * minute keep the page's order.
 */
function newestFirst(events: readonly CarrierEvent[]): CarrierEvent[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    const key = JSON.stringify([event.local_time, event.description, event.location ?? '']);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((event, index) => ({ event, index }))
    .sort((a, b) => clockText(b.event).localeCompare(clockText(a.event)) || a.index - b.index).map(({ event }) => event);
}

/** The page's "Last Recent Update": the consignment's latest label and its clock, if the page has one. */
function latestOf($: CheerioAPI): { description: string; location: string; clock: string } | null {
  const latest = $('.your_delivery_infomation .last_recent_update .update-resul-section');
  if (!latest.length) return null;
  if (latest.length > 1) invalid('MRL Global returned several latest updates');
  const label = labelOf(latest.find('.data-state').text());
  const stamp = STAMP.exec(clean(latest.find('.data-date').text(), 40));
  if (!label.description || !stamp) invalid('MRL Global returned an incomplete latest update');
  const [day, hour] = [stamp[1]!, stamp[2]!];
  return { ...label, clock: clockOf(day, hour) };
}

/** The page without a consignment: an unknown number, a failed lookup or something else in its place. */
function withoutConsignment($: CheerioAPI, html: string): never {
  const notice = $('.no-data');
  if (notice.length === 1) {
    const lines = notice.children('div').toArray().map((line) => clean($(line).text(), 200));
    if (lines.some((line) => NO_DETAILS.test(line))) {
      // The page repeats no number in this answer; it is bound to the request alone.
      if (lines.some((line) => NOT_FOUND.test(line))) throw new NotFoundError(PROVIDER);
      throw new IndeterminateError(PROVIDER, 'MRL Global could not look the consignment up');
    }
    if (lines.some((line) => EMPTY_FORM.test(line))) invalid('MRL Global showed its empty tracking form');
  }
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'MRL Global answered with a browser check');
  invalid('MRL Global returned a page without a tracking result');
}

/**
 * The page `www.mrlglobal.com/tracking/?connoteno={number}` renders for one
 * consignment: a box with its number, the sender's reference and, once
 * delivered, the delivery's clock and who signed; the latest update; and its
 * history, grouped by event label and then by day, each row with the number,
 * the label, a quantity, a date, a time, who signed and two columns headed
 * From and To. Only the number, the labels, the depots named in them and the
 * clocks are read.
 */
export function parseMrl(html: string, raw: string): CarrierResult {
  const number = normalizeMrlNumber(raw);
  const $ = load(html);
  const box = $('.consignment_box');
  if (!box.length) withoutConsignment($, html);
  if (box.length > 1) invalid('MRL Global returned several consignments');
  // The page repeats the number asked in its box and in every row.
  if (consignmentOf($) !== number) throw new IndeterminateError(PROVIDER, 'MRL Global answered for another consignment');

  const rows = $('.tracking_history table.tracking_table tr').toArray().filter((row) => $(row).children('td').length > 0);
  if (rows.length > MAX_ROWS) invalid('MRL Global returned an oversized history');
  const events = newestFirst(rows.map((row) => eventOf($, row, number)));
  const latest = latestOf($);
  const newest = events[0];
  if (!latest && !newest) throw new NoHistoryError(PROVIDER);
  const text = latest?.description ?? newest!.description!;
  const staged: ClassifiedWording | null = latest ? mrlStage(latest.description)
    : newest!.stage ? { stage: newest!.stage as ClassifiedWording['stage'], source: newest!.stage_source! } : null;
  return {
    status: staged ? languageStageStatus(staged.stage) : 'unknown',
    ...(staged ? { current_stage: staged.stage, current_stage_source: staged.source } : {}),
    last_status_text: text,
    last_update: null,
    last_update_local: latest?.clock ?? clockText(newest!),
    expected_delivery: null,
    ...(events.length ? {} : { summary_only: true }),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
