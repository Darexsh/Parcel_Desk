import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { DELIVERY_SHEET, madhurCode, madhurStage } from './status.js';

export const PROVIDER = 'Madhur Courier';
/** The C-Note tracking page, which posts its form back to itself under a session of its own. */
export const MADHUR_TRACKER = 'https://madhurcouriers.in/CNoteTracking';
// The form is under 30 kB and a found consignment adds about a kilobyte a row.
export const MADHUR_MAX_BYTES = 1024 * 1024;

// A C-Note number: a parcel's P and nine digits, or a document's run of ten or eleven digits.
const NUMBER = /^(?:P\d{9}|\d{10,11})$/;
// The address the tracker sends a visitor to: the page under an ASP.NET session id.
const SESSION_PATH = /^\/\(S\([a-z0-5]{24}\)\)\/CNoteTracking$/;
const FORM = {
  option: 'ctl00$ContentPlaceHolder1$a',
  number: 'ctl00$ContentPlaceHolder1$txtCNote',
  search: 'ctl00$ContentPlaceHolder1$btnSearch',
} as const;
const CNOTE_OPTION = 'rdoCNote';
const HIDDEN = /^(?:__[A-Z]{1,30}|ctl00\$ContentPlaceHolder1\$hd[A-Za-z]{1,30})$/;
const MAX_FIELD_LENGTH = 50_000;
// The history's columns, by their headings. The remark is not read.
const HEADINGS = ['Sr.No', 'Date', 'Transaction Type', 'Status', 'Remark', 'Branch Detail'];
// "28-Apr-2026".
const DAY = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// A booking row's wording names the consignor and consignee, with an address, then the pieces; a
// delivery row the delivery staff and their phone. The wording ends before the first of them.
const LABELS = /\s*\b(?:Consignor|Consignee|Mobile|Phone|Contact|Pcs)\b[\s\S]*$/i;
// "DELIVERED TO <receiver> AREA:<area> IN <city> BY <staff>": a delivery sheet's row keeps the words before the names.
const NAMES = /\s*\b(?:TO|BY|AREA)\b[\s\S]*$/i;
const NAMED = /^(?:DELIVERED|SENT)\s+TO\b/i;
const OUT_FOR_DELIVERY = 'OUT FOR DELIVERY';
// A run of ten or more digits, as a phone number is written.
const PHONE = /(?<!\d)\+?\d(?:[\s-]?\d){9,}(?!\d)/g;
// Firewall and bot check pages, which could stand in for the tracker.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|\/cdn-cgi\/challenge-platform\/|_Incapsula_Resource|errors\.edgesuite\.net|requested URL was rejected|g-recaptcha|h-captcha|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)/i;
const MAX_ROWS = 300;

/** A Madhur C-Note number. Anything else, a shipper's reference included, is not one the adapter asks for. */
export function normalizeMadhurNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Madhur C-Note numbers are a P and nine digits, or ten or eleven digits');
  return number;
}

/** The session page the tracker redirects a visitor to, or a transport failure when it sends them elsewhere. */
export function madhurSessionUrl(location: string | null): string {
  let target: URL | null = null;
  try { target = location ? new URL(location, MADHUR_TRACKER) : null; } catch { /* not an address */ }
  if (!target || target.origin !== new URL(MADHUR_TRACKER).origin || !SESSION_PATH.test(target.pathname) || target.search) {
    throw new TransportError(PROVIDER, 'Madhur redirected its tracker');
  }
  return target.href;
}

/** A page without the tracker's form: a block page, else a changed page. */
function unexpected(html: string, message: string): never {
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Madhur answered with a block page');
  throw new SchemaError(PROVIDER, message);
}

/** The tracker's form, with its number field and C-Note option. */
function formOf($: CheerioAPI, html: string): Cheerio<Element> {
  const form = $('form#form1');
  if (form.length !== 1 || form.find(`input[name="${FORM.number}"]`).length !== 1
    || form.find(`input[name="${FORM.option}"][value="${CNOTE_OPTION}"]`).length !== 1) {
    unexpected(html, 'Madhur returned its tracker without the C-Note form');
  }
  return form;
}

/** What the form posts to look a C-Note up, as its search button does with the C-Note option chosen. */
export function madhurSearchFields(html: string, number: string): URLSearchParams {
  const $ = load(html);
  const form = formOf($, html);
  const search = form.find(`input[type="submit"][name="${FORM.search}"]`);
  if (search.length !== 1) unexpected(html, 'Madhur returned its tracker without its search button');
  const fields = new URLSearchParams();
  form.find('input[type="hidden"]').each((_, element) => {
    const name = $(element).attr('name') ?? '';
    const value = $(element).attr('value') ?? '';
    if (HIDDEN.test(name) && value.length <= MAX_FIELD_LENGTH) fields.set(name, value);
  });
  if (!fields.get('__VIEWSTATE') || !fields.get('__EVENTVALIDATION')) {
    throw new SchemaError(PROVIDER, 'Madhur returned its tracker without its state');
  }
  fields.set(FORM.option, CNOTE_OPTION);
  fields.set(FORM.number, number);
  fields.set(FORM.search, search.attr('value') || 'Track CNote');
  return fields;
}

function invalid(message: string): never {
  throw new SchemaError(PROVIDER, message);
}

/** A row's day, `28-Apr-2026`, as `YYYY-MM-DD`. */
function dayOf(text: string): string {
  const match = DAY.exec(text);
  const month = match ? MONTHS.indexOf(match[2]!.toLowerCase()) + 1 : 0;
  const day = match && month ? calendarDay(Number(match[3]), month, Number(match[1])) : null;
  return day ?? invalid('Madhur returned an invalid day');
}

/** The number the tracker's field holds, which it fills with the number it looked up. */
function fieldNumber(form: Cheerio<Element>): string {
  const value = form.find(`input[name="${FORM.number}"]`).attr('value') ?? '';
  // A value too long to be one number is compared whole, so a second number cannot hide behind the first.
  return value.length > 64 ? value : normalizeTrackingNumber(value);
}

/**
 * A row's wording without the people it names. A delivery sheet's row keeps
 * the words before the receiver or the staff, and an out-for-delivery row its
 * transaction type, since its wording opens with the staff's name.
 */
function wordingOf(code: string, status: string): string {
  if (code === OUT_FOR_DELIVERY) return code;
  const named = code === DELIVERY_SHEET || NAMED.test(status);
  const wording = (named ? status.replace(NAMES, '') : status).replace(LABELS, '').replace(PHONE, '');
  return clean(wording, 300) || code;
}

/** The text of a cell, with its parts spaced apart. */
function textOf(cell: Cheerio<AnyNode>, limit: number): string {
  const spaced = cell.clone();
  spaced.find('*').append(' ');
  return clean(spaced.text(), limit);
}

interface Row { day: string; event: CarrierEvent }

/** The history's rows, in the tracker's order, oldest first. */
function rowsOf($: CheerioAPI, grid: Cheerio<Element>): Row[] {
  const rows = grid.find('tr').toArray();
  const heading = rows[0] ? $(rows[0]).children('th').toArray().map((cell) => clean($(cell).text(), 60)) : [];
  if (heading.join('|') !== HEADINGS.join('|')) invalid('Madhur changed its history');
  const body = rows.slice(1);
  if (body.length > MAX_ROWS) invalid('Madhur returned an oversized history');
  return body.map((node) => {
    const cells = $(node).children('td').toArray().map((cell) => $(cell));
    if (cells.length !== HEADINGS.length) invalid('Madhur changed its history');
    const [, date, type, status, , branch] = cells as [Cheerio<Element>, Cheerio<Element>, Cheerio<Element>, Cheerio<Element>, Cheerio<Element>, Cheerio<Element>];
    const code = madhurCode(clean(type.text(), 60));
    if (!code) invalid('Madhur returned a row without its transaction type');
    const description = wordingOf(code, clean(status.text(), 1000));
    // The branch that made the entry comes first, then the one it came from or goes to.
    const location = clean(branch.find('a').first().text() || textOf(branch, 200).split('|')[0], 120);
    const staged = madhurStage(code, description);
    const day = dayOf(clean(date.text(), 40));
    const event: CarrierEvent = {
      local_time: day,
      ...(location ? { location } : {}),
      description,
      provider_code: code,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    };
    return { day, event };
  });
}

/**
 * The page the tracker returns when its form posts a C-Note back with the
 * C-Note option chosen. The rows name no number, so the answer is bound to the
 * request: the form comes back with the number asked in its field and the
 * C-Note option chosen, and lists one booking at most. A C-Note the tracker
 * holds nothing under gets the same page without a history and without any
 * notice. Who sent, received and delivered the consignment, their phones and
 * the remarks are not read.
 */
export function parseMadhurCourier(html: string, rawNumber: string): CarrierResult {
  const number = normalizeMadhurNumber(rawNumber);
  const $ = load(html);
  const form = formOf($, html);
  if (fieldNumber(form) !== number || form.find(`input[name="${FORM.option}"][value="${CNOTE_OPTION}"]`).attr('checked') === undefined) {
    throw new IndeterminateError(PROVIDER, 'Madhur answered for another number');
  }
  const panel = form.find('#ContentPlaceHolder1_Panel1');
  if (panel.length !== 1) invalid('Madhur returned its tracker without its answer');
  const grids = panel.find('table#ContentPlaceHolder1_gvBookings');
  if (grids.length > 1) invalid('Madhur returned several histories');
  if (!grids.length) {
    if (textOf(panel, 200)) invalid('Madhur answered with an unexpected notice');
    throw new NotFoundError(PROVIDER);
  }
  const rows = rowsOf($, grids.first());
  if (!rows.length) invalid('Madhur returned a history without rows');
  if (rows.filter(({ event }) => event.provider_code === 'BOOKING').length > 1) {
    throw new IndeterminateError(PROVIDER, 'Madhur listed several bookings under the number');
  }

  // Newest first: the tracker lists the rows in the order they were made, which the days keep.
  const seen = new Set<string>();
  const events = rows.reverse().sort((a, b) => b.day.localeCompare(a.day)).map(({ event }) => event).filter((event) => {
    const key = JSON.stringify([event.local_time, event.location, event.provider_code, event.description]);
    return seen.has(key) ? false : (seen.add(key), true);
  });
  // A delivery settles the consignment; otherwise the newest row with a known stage decides.
  const decisive = events.find((event) => event.stage === 'delivered') ?? events.find((event) => event.stage);
  const newest = events[0]!;
  return {
    status: decisive ? languageStageStatus(decisive.stage as Stage) : 'unknown',
    ...(decisive ? { current_stage: decisive.stage, current_stage_source: decisive.stage_source } : {}),
    last_status_text: (decisive ?? newest).description ?? null,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    events,
  };
}
