import { load, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type ClassifiedWording } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { pbtStage } from './status.js';

export const PROVIDER = 'PBT';
// A consignment's page is under a hundred kilobytes; one with many items is longer.
export const PBT_MAX_BYTES = 1_000_000;
/** The tracking page, which renders one consignment's items on the server. */
export const PBT_RESULT = 'https://www.pbt.nz/tracking-result/';

// Tickets and consignment notes: three letters and seven or eight digits, or two letters and
// eight or nine; each item adds three digits.
const NUMBER = /^(?:[A-Z]{3}\d{7,11}|[A-Z]{2}\d{8,12})$/;
const CONSIGNMENT = /^(?:[A-Z]{3}\d{7,8}|[A-Z]{2}\d{8,9})$/;
const ITEM_SUFFIX = /^\d{3}$/;
const HEADING_ID = /^heading-([A-Za-z0-9]{4,40})$/;
// "13 Dec 23", then "at 12:07": a wall clock with a two-digit year, without a zone.
const DAY = /^(\d{1,2}) ([A-Za-z]{3}) (\d{2})$/;
const HOUR = /^at (\d{1,2}):(\d{2})$/;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// A row's second line names the PBT site that scanned it; anything else, such as a pickup
// request's reference, is not a place.
const SITE = /^PBT\s/;
// Who took the item, after the verb that names them.
const TAKER = /\b(signed|received|collected)(\s+for)?\s+by\b.*$/i;
const WEIGHT = /^Weight:\s*(\d{1,6}(?:\.\d{1,3})?)\s*(?:kg)?$/i;
const ITEMS = /^Items:\s*(\d{1,4})$/i;
// Bot checks a CDN or firewall could put in place of the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|<title>\s*Attention Required|cf-error-details|g-recaptcha|h-captcha|captcha/i;
const MAX_ITEMS = 200;
const MAX_ROWS = 2_000;
const MAX_EVENTS = 100;

/** A PBT ticket, consignment note or item number, as typed; anything else is not one the tracker issues. */
export function normalizePbtNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) {
    throw new InvalidInputError(PROVIDER, 'PBT tickets and consignment notes are two or three letters and seven to twelve digits');
  }
  return number;
}

/** A status without the name of who took the item. */
function withoutTaker(text: string): string {
  return clean(text.replace(TAKER, '$1$2').replace(/[\s,;:-]+$/, ''), 120);
}

function invalid(message: string): never {
  throw new SchemaError(PROVIDER, message);
}

/**
 * The tracking page's redirect. A number it does not know, or no longer
 * keeps, goes back to the home page's tracking form with `hasError=true` and
 * the number asked; any other redirect is a moved route.
 */
export function readPbtRedirect(location: string | null, raw: string): never {
  const number = normalizePbtNumber(raw);
  let target: URL | null;
  try {
    target = location ? new URL(location, PBT_RESULT) : null;
  } catch {
    target = null;
  }
  if (!target || !/^(?:www\.)?pbt\.nz$/i.test(target.hostname) || target.pathname !== '/'
    || target.searchParams.get('hasError') !== 'true') {
    throw new TransportError(PROVIDER, 'PBT redirected its tracking page');
  }
  if (normalizeTrackingNumber(target.searchParams.get('consignmentNumber') ?? '') !== number) {
    throw new IndeterminateError(PROVIDER, 'PBT answered for another number');
  }
  throw new NotFoundError(PROVIDER);
}

/** A row's wall clock, checked against the calendar. */
function clockOf(day: string, hour: string): string {
  const date = DAY.exec(day);
  const time = HOUR.exec(hour);
  const month = date ? MONTHS.indexOf(date[2]!.toLowerCase()) + 1 : 0;
  const calendar = date && month ? calendarDay(2000 + Number(date[3]), month, Number(date[1])) : null;
  if (!calendar || !time || Number(time[1]) > 23 || Number(time[2]) > 59) invalid('PBT returned an invalid scan time');
  return `${calendar}T${time[1]!.padStart(2, '0')}:${time[2]}:00`;
}

interface Item {
  id: string;
  /** The item's latest status, as its heading shows it. */
  status: string;
  /** Oldest first, in the page's order. */
  events: CarrierEvent[];
}

function itemOf($: CheerioAPI, node: Element): Item {
  const heading = $(node).children('.tracking-result-item-heading');
  const id = HEADING_ID.exec(heading.attr('id') ?? '')?.[1]?.toUpperCase();
  const labels = heading.find('.tracking-result-item-heading-label');
  if (heading.length !== 1 || !id || clean(labels.first().text(), 64).toUpperCase() !== id) invalid('PBT returned an item without its number');
  // Links in the heading, such as one to a proof of delivery, are not part of the status.
  const status = clean(heading.find('.tracking-result-item-heading-status').clone()
    .find('a, img, .js-tracking-result-item-heading-link').remove().end().text(), 120);
  const rows = $(node).find('.tracking-result-item-collapse-entry').toArray();
  if (rows.length > MAX_ROWS) invalid('PBT returned an oversized history');
  const events = rows.map((row): CarrierEvent => {
    const clock = $(row).find('.tracking-result-item-collapse-time').children('div').toArray().map((cell) => clean($(cell).text(), 40));
    const lines = $(row).find('.tracking-result-item-collapse-status').children('div').toArray()
      .map((cell) => clean($(cell).clone().find('a, img').remove().end().text(), 160));
    const description = withoutTaker(lines[0] ?? '');
    if (clock.length < 2 || !description) invalid('PBT returned an incomplete scan');
    const location = SITE.test(lines[1] ?? '') ? clean(lines[1], 80) : '';
    const staged = pbtStage(description);
    return {
      local_time: clockOf(clock[0]!, clock[1]!),
      ...(location ? { location } : {}),
      description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    };
  });
  return { id, status: withoutTaker(status), events };
}

/**
 * The items of the reply that are the shipment asked. An item number is its
 * own item; a consignment number is all of its items, each the number and
 * three digits. Any other item on the page belongs to another consignment,
 * and makes the reply no answer.
 */
function itemsAsked(items: readonly Item[], number: string): Item[] {
  const own = items.filter((item) => item.id === number);
  const consignment = CONSIGNMENT.test(number.slice(0, -3)) && ITEM_SUFFIX.test(number.slice(-3)) ? number.slice(0, -3) : null;
  const inside = (id: string, parent: string) => id.length === parent.length + 3 && id.startsWith(parent) && ITEM_SUFFIX.test(id.slice(-3));
  // The item's siblings can come with it; they are not the item asked.
  const belongs = (item: Item) => item.id === number || inside(item.id, number) || (own.length > 0 && consignment !== null && inside(item.id, consignment));
  if (items.some((item) => !belongs(item))) throw new IndeterminateError(PROVIDER, 'PBT answered for another consignment');
  return own.length ? own : items.filter((item) => inside(item.id, number));
}

/** A row's wall clock, which sorts as text. */
const clockText = (event: CarrierEvent | undefined) => (typeof event?.local_time === 'string' ? event.local_time : '');
const later = (a: string, b: string) => (a > b ? 1 : a < b ? -1 : 0);

/**
 * Rows newest first by their clocks, a row several items share kept once. The
 * page lists rows oldest first, but not always in their clocks' order: a
 * status's rows can come out of order, and a pickup request can be stamped
 * after the pickup. Rows of one minute keep the page's order, reversed.
 */
function newestFirst(events: readonly CarrierEvent[]): CarrierEvent[] {
  const seen = new Set<string>();
  const kept = events.filter((event) => {
    const key = JSON.stringify([event.local_time, event.description, event.location ?? '']);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return kept.map((event, index) => ({ event, index }))
    .sort((a, b) => later(clockText(b.event), clockText(a.event)) || b.index - a.index).map(({ event }) => event);
}

/** An item's current state: its heading's status, else its newest staged row. */
function stateOf(item: Item): { item: Item; staged: ClassifiedWording | null; text: string } | null {
  const staged = item.status ? pbtStage(item.status) : null;
  if (item.status) return { item, staged, text: item.status };
  const rows = newestFirst(item.events);
  const row = rows.find((event) => event.stage);
  if (row) return { item, staged: { stage: row.stage as ClassifiedWording['stage'], source: row.stage_source! }, text: row.description! };
  const newest = rows[0];
  return newest ? { item, staged: null, text: newest.description! } : null;
}

/** The value of one of the consignment's detail lines, if the page has it. */
function detail($: CheerioAPI, pattern: RegExp): string | null {
  const values = $('.tracking-result-details p').toArray().map((line) => pattern.exec(clean($(line).text(), 80))?.[1])
    .filter((value): value is string => value !== undefined);
  if (values.length > 1) invalid('PBT returned repeated consignment details');
  return values[0] ?? null;
}

/**
 * The page `www.pbt.nz/tracking-result/?consignmentNumber={number}` renders
 * for a number it knows. It lists the consignment's items, each headed by its
 * number, the towns it was sent from and to and its latest status, with its
 * history oldest first. The consignment's details follow: the network moving
 * it, the item count, the weight, the cubic volume and the sender's
 * references. Only the items, their statuses and histories, the scanning
 * sites and the weight are read.
 */
export function parsePbt(html: string, raw: string): CarrierResult {
  const number = normalizePbtNumber(raw);
  const $ = load(html);
  if ($('.tracking-result').length !== 1) {
    // A client that follows the not-found redirect lands on the home page's form, with the number in it.
    const form = $('form.js-track-form.has-error input[name="consignmentNumber"]');
    if (form.length === 1) {
      if (normalizeTrackingNumber(clean(form.attr('value'), 64)) !== number) throw new IndeterminateError(PROVIDER, 'PBT answered for another number');
      throw new NotFoundError(PROVIDER);
    }
    if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'PBT answered with a browser check');
    invalid('PBT returned a page without a tracking result');
  }
  const nodes = $('.tracking-result-item').toArray();
  if (nodes.length > MAX_ITEMS) invalid('PBT returned an oversized consignment');
  const listed = nodes.map((node) => itemOf($, node));
  if (!listed.length) throw new NoHistoryError(PROVIDER);
  const items = itemsAsked(listed, number);

  const events = newestFirst(items.flatMap((item) => item.events));
  // A consignment is delivered once every item is. Until then, of the items still on their
  // way, the one scanned last says where the consignment is.
  const states = items.map(stateOf).filter((state) => state !== null);
  if (!states.length) throw new NoHistoryError(PROVIDER);
  const open = states.filter((state) => state.staged?.stage !== 'delivered');
  const newestOf = (state: (typeof states)[number]) => clockText(newestFirst(state.item.events)[0]);
  const current = (open.length ? open : states).reduce((best, state) => (newestOf(state) > newestOf(best) ? state : best));
  const scan = newestFirst(current.item.events).find((event) => event.description === current.text);
  const stage = current.staged?.stage;

  // The weight is the consignment's: it is kept only when the answer is the whole consignment.
  const count = detail($, ITEMS);
  const weight = Number(detail($, WEIGHT) ?? Number.NaN);
  const whole = items.length === listed.length && count !== null && Number(count) === items.length;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(current.staged ? { current_stage: current.staged.stage, current_stage_source: current.staged.source } : {}),
    last_status_text: current.text,
    last_update: null,
    ...(scan ? { last_update_local: scan.local_time } : {}),
    expected_delivery: null,
    ...(whole && weight > 0 ? { weight_kg: weight } : {}),
    ...(events.length ? {} : { summary_only: true }),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
