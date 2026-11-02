import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { jetlineStage } from './status.js';

export const PROVIDER = 'Jetline Couriers';
/** The home page, whose tracking form posts the AWB number back to it. */
export const JETLINE_TRACKER = 'https://www.jetlinecouriers.in/';
// The form and the answer are under 30 kB, but the history page carries the proof of delivery's
// photo twice, in the page and in its state.
export const JETLINE_MAX_BYTES = 8 * 1024 * 1024;

// An AWB number: the home page's example and complaints show runs of seven to nine digits.
const NUMBER = /^\d{7,9}$/;
// The answer page the form redirects to, under an opaque id for the number.
const ANSWER_PATH = '/track.aspx';
const ANSWER_QUERY = /^\?trackId=[A-Za-z0-9+/%=]{4,200}$/;
const FORM = { number: 'txtAwbNo', search: 'btnTrack' } as const;
const HIDDEN = /^__[A-Z]{1,30}$/;
const MAX_FIELD_LENGTH = 50_000;
// The summary's columns, by their headings.
const HEADINGS = ['AWB No', 'Booking Date', 'Origin', 'Destination', 'Status', 'Status Date', 'History'];
// The summary row's history link, which posts the page back with its own name as the event target.
const POSTBACK = /^javascript:__doPostBack\('(grd1\$ctl\d{2,3}\$LinkButton1)',\s*''\)$/;
// The tracker's only answer for a number it holds nothing under.
const NO_RECORD = /^\s*alert\(\s*'No Record Available\b/i;
// "14/08/2026", after a calendar emoji.
const DAY = /(?:^|\s)(\d{2})\/(\d{2})\/(\d{4})$/;
// A dispatch row names the branch the parcel leaves for in its badge, and the one it leaves in its wording.
const DISPATCH = /^SHIPMENT DISPATCH\b/i;
const LEAVING = /\bFROM\s+(.+)$/i;
// A branch's city, as its badge or a dispatch's wording names it.
const CITY = /^[A-Za-z][A-Za-z .()&-]{0,59}$/;
// A run of ten or more digits, as a phone number is written, and a signatory after a delivery.
const PHONE = /(?<!\d)\+?\d(?:[\s-]?\d){9,}(?!\d)/g;
const SIGNATORY = /\s+SIGN\b[\s\S]*$/i;
// Firewall and bot check pages, which could stand in for the tracker.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|\/cdn-cgi\/challenge-platform\/|_Incapsula_Resource|errors\.edgesuite\.net|requested URL was rejected|g-recaptcha|h-captcha|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)/i;
const MAX_ROWS = 300;

/** A Jetline AWB number. Anything else is not one the adapter asks for. */
export function normalizeJetlineNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Jetline AWB numbers are seven to nine digits');
  return number;
}

/** A page that is not the tracker's: a block page, else a changed page. */
export function unexpectedPage(html: string, message: string): never {
  if (!html.trim()) throw new IndeterminateError(PROVIDER, 'Jetline returned an empty page');
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Jetline answered with a block page');
  throw new SchemaError(PROVIDER, message);
}

function invalid(message: string): never {
  throw new SchemaError(PROVIDER, message);
}

/** The tracker's form, with its AWB field. */
function formOf($: CheerioAPI, html: string): Cheerio<Element> {
  const form = $('form#form1');
  if (form.length !== 1 || form.find(`input[name="${FORM.number}"]`).length !== 1) {
    unexpectedPage(html, 'Jetline returned a page without its tracking form');
  }
  return form;
}

/** The form's hidden state, which a post back returns. */
function stateOf($: CheerioAPI, form: Cheerio<Element>): URLSearchParams {
  const fields = new URLSearchParams();
  form.find('input[type="hidden"]').each((_, element) => {
    const name = $(element).attr('name') ?? '';
    const value = $(element).attr('value') ?? '';
    if (HIDDEN.test(name) && value.length <= MAX_FIELD_LENGTH) fields.set(name, value);
  });
  if (!fields.get('__VIEWSTATE') || !fields.get('__EVENTVALIDATION')) invalid('Jetline returned its form without its state');
  return fields;
}

/** What the home page's form posts to look an AWB number up, as its track button does. */
export function jetlineSearchFields(html: string, number: string): URLSearchParams {
  const $ = load(html);
  const form = formOf($, html);
  const search = form.find(`input[type="submit"][name="${FORM.search}"]`);
  if (search.length !== 1) unexpectedPage(html, 'Jetline returned its form without its track button');
  const fields = stateOf($, form);
  fields.set(FORM.number, number);
  fields.set(FORM.search, search.attr('value') || 'Track Package');
  return fields;
}

/** The answer page the form redirects to, or a transport failure when it sends the visitor elsewhere. */
export function jetlineAnswerUrl(location: string | null): string {
  let target: URL | null = null;
  try { target = location ? new URL(location, JETLINE_TRACKER) : null; } catch { /* not an address */ }
  if (!target || target.origin !== new URL(JETLINE_TRACKER).origin || target.pathname.toLowerCase() !== ANSWER_PATH
    || !ANSWER_QUERY.test(target.search) || target.hash) {
    throw new TransportError(PROVIDER, 'Jetline redirected its tracking form elsewhere');
  }
  return target.href;
}

interface Summary { target: string }

/**
 * The summary's one row for the number. The rows carry the AWB number, so the
 * answer is bound to it: one row, for the whole number, or the answer is
 * inconclusive. Its status, which can name a signatory, is not read.
 */
function summaryOf($: CheerioAPI, grid: Cheerio<Element>, number: string): Summary {
  const rows = grid.find('tr').toArray();
  const heading = rows[0] ? $(rows[0]).children('th').toArray().map((cell) => clean($(cell).text(), 60)) : [];
  if (heading.join('|') !== HEADINGS.join('|')) invalid('Jetline changed its summary');
  const body = rows.slice(1);
  if (!body.length) invalid('Jetline returned a summary without rows');
  const numbers = body.map((row) => {
    const cells = $(row).children('td');
    if (cells.length !== HEADINGS.length) invalid('Jetline changed its summary');
    // A value too long to be one number is compared whole, so a second number cannot hide behind the first.
    const value = clean(cells.first().text(), 100);
    return value.length > 64 ? value : normalizeTrackingNumber(value);
  });
  if (numbers.some((value) => value !== number)) throw new IndeterminateError(PROVIDER, 'Jetline answered for another number');
  if (body.length > 1) throw new IndeterminateError(PROVIDER, 'Jetline listed several bookings under the number');
  const link = $(body[0]).children('td').last().find('a');
  const target = link.length === 1 ? POSTBACK.exec(link.attr('href') ?? '')?.[1] : undefined;
  return { target: target ?? invalid('Jetline returned a summary without its history link') };
}

/** The answer page's summary grid, after the tracker's form. */
function gridOf(form: Cheerio<Element>): Cheerio<Element> | null {
  const grids = form.find('table#grd1');
  if (grids.length > 1) invalid('Jetline returned several summaries');
  return grids.length ? grids.first() : null;
}

/**
 * What the answer page posts back to open the parcel's history, as its history
 * link does. A number the tracker holds nothing under gets the answer page with
 * an empty summary and an alert, "No Record Available"; that is the only
 * missing parcel.
 */
export function jetlineHistoryFields(html: string, number: string): URLSearchParams {
  const $ = load(html);
  const form = formOf($, html);
  const grid = gridOf(form);
  const alerted = $('script').toArray().some((script) => NO_RECORD.test($(script).text()));
  if (!grid) {
    if (!alerted || form.find('div.table-responsive').length !== 1 || clean(form.find('div.table-responsive').text(), 100)) {
      invalid('Jetline answered without a summary');
    }
    throw new NotFoundError(PROVIDER);
  }
  if (alerted) invalid('Jetline answered with a summary and its missing-parcel alert');
  const { target } = summaryOf($, grid, number);
  const fields = stateOf($, form);
  fields.set('__EVENTTARGET', target);
  fields.set('__EVENTARGUMENT', '');
  return fields;
}

/** A row's day, `14/08/2026`, as `YYYY-MM-DD`. */
function dayOf(text: string): string {
  const match = DAY.exec(text);
  const day = match ? calendarDay(Number(match[3]), Number(match[2]), Number(match[1])) : null;
  return day ?? invalid('Jetline returned an invalid day');
}

/**
 * The city of a branch badge: `JETLINE COURIERS <address>,<city>,<phones>`.
 * The phones go, and the city is the last part left after the address.
 */
function badgeCity(badge: string): string | undefined {
  const parts = badge.split(',').map((part) => clean(part, 200));
  while (parts.length && !/[A-Za-z]/.test(parts.at(-1)!)) parts.pop();
  const city = parts.length > 1 ? parts.at(-1)! : '';
  return CITY.test(city) ? city : undefined;
}

/** A row's wording without phones or a signatory. */
function wordingOf(remark: string): string {
  return clean(remark.replace(PHONE, ' ').replace(SIGNATORY, ''), 300);
}

interface Row { day: string; event: CarrierEvent }

/** The history's rows, in the tracker's order, newest first. */
function rowsOf($: CheerioAPI, panel: Cheerio<Element>): Row[] {
  const items = panel.find('table#GridView1 div.timeline-item').toArray();
  if (items.length > MAX_ROWS) invalid('Jetline returned an oversized history');
  return items.map((item) => {
    const day = dayOf(clean($(item).find('.timeline-date').text(), 60));
    const description = wordingOf(clean($(item).find('.timeline-remarks').text(), 1000));
    if (!description) invalid('Jetline returned a history row without its wording');
    // A dispatch row's badge is the next branch's, so the branch it leaves comes from the wording.
    const leaving = DISPATCH.test(description) ? LEAVING.exec(description)?.[1] ?? '' : null;
    const city = leaving === null ? badgeCity(clean($(item).find('.timeline-location-badge').text(), 400))
      : CITY.test(leaving) ? leaving : undefined;
    const staged = jetlineStage(description);
    const event: CarrierEvent = {
      local_time: day,
      ...(city ? { location: city } : {}),
      description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    };
    return { day, event };
  });
}

/**
 * The page the tracker returns when the answer page posts its history link
 * back: the summary again, the parcel's history and, once delivered, the proof
 * of delivery. The summary binds it to the number like the answer page. The
 * branches' addresses and phones, the summary's status and the proof of
 * delivery are not read.
 */
export function parseJetlineCouriers(html: string, rawNumber: string): CarrierResult {
  const number = normalizeJetlineNumber(rawNumber);
  const $ = load(html);
  const form = formOf($, html);
  const grid = gridOf(form);
  if (!grid) invalid('Jetline returned its history without the summary');
  summaryOf($, grid, number);
  const panels = form.find('div#Panel1');
  if (panels.length !== 1) invalid('Jetline returned its summary without the history');
  const rows = rowsOf($, panels.first());
  if (!rows.length) invalid('Jetline returned a history without rows');

  // Newest first: the tracker lists the rows newest first, which the days keep.
  const seen = new Set<string>();
  const events = rows.sort((a, b) => b.day.localeCompare(a.day)).map(({ event }) => event).filter((event) => {
    const key = JSON.stringify([event.local_time, event.location, event.description]);
    return seen.has(key) ? false : (seen.add(key), true);
  });
  // A delivery settles the parcel; otherwise the newest row with a known stage decides.
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
