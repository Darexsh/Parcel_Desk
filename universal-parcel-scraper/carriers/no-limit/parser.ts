import { load } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { noLimitPrintedNumber, noLimitShipmentNumber } from '../../core/detection/noLimit.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { noLimitStage } from './status.js';

export const PROVIDER = 'No Limit';
export const CARRIER = 'no-limit';
/** The English tracking page, whose form looks a shipment up when it is posted back. */
export const NO_LIMIT_TRACKER = 'https://follow.nolimit.pl/Defaulteng.aspx';
// A page with a long history is under fifty kilobytes.
export const NO_LIMIT_MAX_BYTES = 512 * 1024;

const FORM = {
  kind: 'ctl00$ContentPlaceHolder2$szukaj1RadioButtonList1',
  number: 'ctl00$ContentPlaceHolder2$szukajTextBox1',
  search: 'ctl00$ContentPlaceHolder2$szukajButton1',
} as const;
// The first of the form's four kinds of number: a shipment number.
const SHIPMENT_KIND = '1';
// ASP.NET's state, and the fields the site's firewall adds to the form and checks.
const FIELD = /^(?:__[A-Z]{1,30}|as_[a-z]{1,10})$/;
const MAX_FIELD_LENGTH = 50_000;
// The label that names the shipment searched, or says none was found.
const HEADING = 'span#ctl00_ContentPlaceHolder3_szukaj1Label1';
const UNKNOWN = 'Shipment not found';
const SEARCHED = /^Shipment number: (\S{1,64})$/;
const GRID = 'table#ctl00_ContentPlaceHolder3_stat1GridView';
const HEADINGS = ['Date & time', 'Location', 'Status description'];
// "2026-04-13 | 11:04": the status's wall clock, to the minute.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2}) \| (\d{2}):(\d{2})$/;
// "LOG_SAMPLEVILLE": a branch, named after its town.
const BRANCH = /^LOG_(?=\S)/;
// Firewall and bot-check pages that could stand in for the tracker's own, which can come back with HTTP 200.
const BLOCK = /<title>\s*(?:Request Rejected|Access Denied|Attention Required|Just a moment|Web Page Blocked)|requested URL was rejected|_cf_chl_opt|cf-turnstile|g-recaptcha|hcaptcha/i;
const MAX_ROWS = 500;

/** A NO LIMIT shipment number, with or without its slashes, as normalization keeps it: without them. */
export function normalizeNoLimitNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? noLimitShipmentNumber(normalizeTrackingNumber(raw)) : undefined;
  if (!number) throw new InvalidInputError(PROVIDER, 'No Limit shipment numbers are P and a serial, L and a branch, and a year');
  return number;
}

/** A firewall or bot-check page in place of the tracker's own. */
export function isBlockPage(body: string): boolean {
  return BLOCK.test(body.slice(0, 64_000));
}

/** A page without what the tracker's has: a block page, else a changed page. */
function unexpected(html: string, message: string): never {
  if (isBlockPage(html)) throw new ChallengeError(PROVIDER, 'No Limit answered with a block page');
  throw new SchemaError(PROVIDER, message);
}

/**
 * What the form posts to look a shipment number up, as its search button does
 * with the shipment number chosen: the page's hidden fields and the number
 * with its slashes, without which the form finds nothing.
 */
export function noLimitFormFields(html: string, raw: string): URLSearchParams {
  const number = noLimitPrintedNumber(normalizeNoLimitNumber(raw))!;
  const $ = load(html);
  const form = $('form#aspnetForm');
  if (form.length !== 1 || form.find(`input[name="${FORM.number}"]`).length !== 1 || form.find(`input[name="${FORM.search}"]`).length !== 1
    || form.find(`input[type="radio"][name="${FORM.kind}"][value="${SHIPMENT_KIND}"]`).length !== 1) {
    unexpected(html, 'No Limit returned a tracking page without its form');
  }
  const fields = new URLSearchParams();
  form.find('input[type="hidden"]').each((_, element) => {
    const name = $(element).attr('name') ?? '';
    const value = $(element).attr('value') ?? '';
    if (FIELD.test(name) && value.length <= MAX_FIELD_LENGTH) fields.set(name, value);
  });
  if (!fields.get('__VIEWSTATE') || !fields.get('__EVENTVALIDATION')) {
    throw new SchemaError(PROVIDER, 'No Limit returned a tracking page without its state');
  }
  fields.set('__EVENTTARGET', '');
  fields.set(FORM.kind, SHIPMENT_KIND);
  fields.set(FORM.number, number);
  fields.set(FORM.search, 'SEARCH');
  return fields;
}

/** A status's date and minute as one wall time, calendar-checked. The page gives no zone. */
function wallClock(text: string): string {
  const match = CLOCK.exec(text);
  const day = match ? calendarDay(Number(match[1]), Number(match[2]), Number(match[3])) : null;
  if (!match || !day || Number(match[1]) < 2000 || Number(match[4]) > 23 || Number(match[5]) > 59) {
    throw new SchemaError(PROVIDER, 'No Limit returned an invalid status time');
  }
  return `${day}T${match[4]}:${match[5]}:00`;
}

/** A status's place: a branch by its town, or the town a delivery was made in. A blank cell is none. */
function placeOf(text: string): string {
  return text.replace(BRANCH, '').replaceAll('_', ' ').trim();
}

/**
 * The page NO LIMIT's form returns for a shipment number: the form again with
 * the number in its field, a label that names the shipment searched, or says
 * none was found, then the shipment's references, loading and unloading
 * places and parcel count, and a table of statuses, oldest first, each with
 * its clock and place.
 *
 * The label must name the whole number asked, and a page without a shipment
 * must hold it in its field. Only the statuses are read: the result has no
 * field for the sender's references, the places or the parcel count.
 */
export function parseNoLimit(html: string, raw: string): CarrierResult {
  const number = normalizeNoLimitNumber(raw);
  const $ = load(html);
  const headings = $(HEADING);
  if (headings.length !== 1) unexpected(html, 'No Limit returned a page without the shipment');
  const heading = clean(headings.text(), 120);
  const grids = $(GRID);
  if (heading === UNKNOWN && !grids.length) {
    // The label names no number then; the form's field still holds the one searched.
    const field = $(`form#aspnetForm input[name="${FORM.number}"]`);
    if (field.length !== 1 || normalizeTrackingNumber(field.attr('value') ?? '') !== number) {
      throw new IndeterminateError(PROVIDER, 'No Limit answered for another shipment');
    }
    throw new NotFoundError(PROVIDER);
  }
  const searched = SEARCHED.exec(heading);
  if (!searched || grids.length > 1) throw new SchemaError(PROVIDER, 'No Limit returned an unexpected page');
  if (normalizeTrackingNumber(searched[1]!) !== number) throw new IndeterminateError(PROVIDER, 'No Limit answered for another shipment');
  if (!grids.length) throw new NoHistoryError(PROVIDER);

  const rows = grids.find('tr');
  const headers = rows.first().children('th').map((_, cell) => clean($(cell).text(), 40)).get();
  if (JSON.stringify(headers) !== JSON.stringify(HEADINGS)) throw new SchemaError(PROVIDER, 'No Limit history columns changed');
  if (rows.length - 1 > MAX_ROWS) throw new SchemaError(PROVIDER, 'No Limit returned an oversized history');
  if (rows.length < 2) throw new NoHistoryError(PROVIDER);
  const seen = new Set<string>();
  const statuses: { local: string; index: number; event: CarrierEvent }[] = [];
  rows.slice(1).each((index, element) => {
    const cells = $(element).children('td');
    if (cells.length !== HEADINGS.length) throw new SchemaError(PROVIDER, 'No Limit returned an invalid status');
    const description = clean(cells.eq(2).text(), 200);
    if (!description) throw new SchemaError(PROVIDER, 'No Limit returned a status without wording');
    const local = wallClock(clean(cells.eq(0).text(), 40));
    const location = placeOf(clean(cells.eq(1).text(), 120));
    // A row the page lists twice is kept once; one status at two branches at once is two.
    const identity = JSON.stringify([local, location, description]);
    if (seen.has(identity)) return;
    seen.add(identity);
    const staged = noLimitStage(description);
    statuses.push({ local, index, event: {
      local_time: local,
      description,
      ...(location ? { location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  });
  // Newest first; of equal clocks, the row further down the page is the newer.
  statuses.sort((left, right) => right.local.localeCompare(left.local) || right.index - left.index);
  const events = statuses.map(({ event }) => event);

  const newest = events[0]!;
  const latest = events.find((event) => event.stage);
  const stage = latest?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: latest!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    events,
  };
}
