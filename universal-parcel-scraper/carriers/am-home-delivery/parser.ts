import { load, type CheerioAPI } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { amHomeDeliveryStage } from './status.js';

export const PROVIDER = 'AM Home Delivery';
// A shipment's page is about ten kilobytes.
export const AM_HOME_DELIVERY_MAX_BYTES = 256 * 1024;

// A track number: eight digits, or AM and nine digits on newer orders.
const NUMBER = /^(?:\d{8}|AM\d{9})$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// A day as the page writes it: "7-Jun-2021".
const DAY = /^(\d{1,2})-([A-Z][a-z]{2})-(\d{4})$/;
// A row's time, to the minute on a twelve-hour clock: "07:18 pm".
const TIME = /^(\d{1,2}):(\d{2}) ([ap]m)$/i;
// The estimate: an appointment, "7-Jun-2021 at 17:30:00 - 7-Jun-2021 at 21:30:00", or before one a range of days, "3-Dec-2025 to 11-Dec-2025".
const APPOINTMENT = /^(\S+) at \d{2}:\d{2}:\d{2} - (\S+) at \d{2}:\d{2}:\d{2}$/;
const RANGE = /^(\S+) to (\S+)$/;
// A row's place: a town and its state, with a ZIP code the result leaves out: "Davenport, Iowa 52806".
// Other values ("In Transit") name no place.
const PLACE = /^(\p{L}[\p{L} .'-]{0,59}), (\p{L}[\p{L} ]{1,29}?)(?: \d{5}(?:-\d{4})?)?$/u;
// The page's notice for a number it holds no shipment under, which names no number.
const NOT_FOUND = 'Please Enter a Valid BOL Number.';
// Firewall and bot check pages, which could stand in for the tracking page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|\/cdn-cgi\/challenge-platform\/|_Incapsula_Resource|errors\.edgesuite\.net|requested URL was rejected|captcha|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)/i;
// The stages a shipment moves forward through, in order.
const FORWARD: readonly Stage[] = ['registered', 'accepted', 'in_transit', 'out_for_delivery', 'delivered'];
const FINAL: ReadonlySet<Stage> = new Set(['delivered', 'returned']);
const MAX_ROWS = 300;

/** An AM Home Delivery track number. Anything else is not one the tracker is asked for. */
export function normalizeAmHomeDeliveryNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) {
    throw new InvalidInputError(PROVIDER, 'AM Home Delivery track numbers are eight digits, or AM and nine digits');
  }
  return number;
}

/** Whether a page is a firewall's or a bot check's rather than the carrier's. */
export function isAmHomeDeliveryBlockPage(html: string): boolean {
  return CHALLENGE.test(html.slice(0, 64_000));
}

function invalid(message: string): never {
  throw new SchemaError(PROVIDER, message);
}

/** "7-Jun-2021" as a calendar day, or null when it is not one. */
function dayOf(text: string): string | null {
  const match = DAY.exec(text);
  const month = match ? MONTHS.indexOf(match[2]!) + 1 : 0;
  return match && month ? calendarDay(Number(match[3]), month, Number(match[1])) : null;
}

/** A row's day and time as a wall clock; the page names no zone. A row without a time keeps its day. */
function wallClock(date: string, time: string): string {
  const day = dayOf(date);
  if (!day) invalid('AM Home Delivery returned an invalid history date');
  if (!time) return day;
  const match = TIME.exec(time);
  const hour = Number(match?.[1]);
  if (!match || hour < 1 || hour > 12 || Number(match[2]) > 59) invalid('AM Home Delivery returned an invalid history time');
  const hours = (hour % 12) + (match[3]!.toLowerCase() === 'pm' ? 12 : 0);
  return `${day}T${String(hours).padStart(2, '0')}:${match[2]}:00`;
}

/** A row's town and state, without the ZIP code; a value that is not a place is left out. */
function placeOf(text: string): string {
  const match = PLACE.exec(text);
  return match ? `${match[1]!.trim()}, ${match[2]!.trim()}` : '';
}

/**
 * The values of the shipment's summary by their labels. It also gives the
 * shipper's bill of lading number, the day the order came in and the delivery
 * address's town and ZIP code; they are read only to bind the reply.
 */
function summary($: CheerioAPI): Map<string, string> {
  const values = new Map<string, string>();
  $('#info-table .info-label').each((_, node) => {
    const label = clean($(node).text(), 60).replace(/:$/, '');
    const value = $(node).next('.info-data');
    if (values.has(label) || value.length !== 1) invalid('AM Home Delivery changed its shipment summary');
    values.set(label, clean(value.text(), 200));
  });
  return values;
}

/** The rows of the tracking details, newest first and once each. */
function history($: CheerioAPI): CarrierEvent[] {
  const table = $('table#TrackingDetails');
  if (table.length !== 1) invalid('AM Home Delivery returned a page without its tracking details');
  const rows = table.find('tbody > tr');
  if (rows.length > MAX_ROWS) invalid('AM Home Delivery returned an oversized history');
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  rows.each((_, node) => {
    const cells = $(node).children('td').map((_index, cell) => clean($(cell).text(), 200)).get();
    if (cells.length !== 4) invalid('AM Home Delivery changed its tracking details');
    const [date, time, place, description] = cells as [string, string, string, string];
    if (!description) invalid('AM Home Delivery returned a history row without its status');
    const local_time = wallClock(date, time);
    const location = placeOf(place);
    const key = JSON.stringify([local_time, description, location]);
    if (seen.has(key)) return;
    seen.add(key);
    const staged = amHomeDeliveryStage(description);
    events.push({
      local_time,
      ...(location ? { location } : {}),
      description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    });
  });
  // The page lists the newest first; a list the other way round is turned round.
  return events.length > 1 && events[0]!.local_time! < events.at(-1)!.local_time! ? events.reverse() : events;
}

/** The label of the progress rail's current step, if it marks one. A step for the appointment adds its window after a line break. */
function railStep($: CheerioAPI): string {
  const current = $('#timeline > li.actual');
  if (current.length > 1) invalid('AM Home Delivery marked several current steps');
  if (!current.length) return '';
  const label = clean(current.find('.event').first().contents().first().text(), 80);
  if (!label) invalid('AM Home Delivery returned a current step without its label');
  return label;
}

/** The estimate the page shows until the delivery, as days: the appointment's day, or the range of days before one. */
function estimate(text: string): Pick<CarrierResult, 'expected_delivery' | 'expected_delivery_from'> {
  const match = APPOINTMENT.exec(text) ?? RANGE.exec(text);
  const from = match ? dayOf(match[1]!) : null;
  const to = match ? dayOf(match[2]!) : null;
  if (!from || !to || to < from) return { expected_delivery: null };
  return { expected_delivery: to, ...(to > from ? { expected_delivery_from: from } : {}) };
}

interface Stated { text: string; staged: ClassifiedWording }

/**
 * The page `track-number.php?cnumber={number}` redirects to, a NetSuite page
 * that renders one shipment: its summary (track number, bill of lading number,
 * current and last mile statuses, delivery town), the delivery estimate, the
 * products, a progress rail and the tracking details, a row per scan with its
 * day, a wall clock, the place and the status, newest first. A number it holds
 * no shipment under gets a notice that names no number. The page finds a
 * shipment by its track number or by the shipper's bill of lading number; only
 * one whose track number is the number asked is read. The products, the
 * delivery town and the bill of lading number are not kept.
 */
export function parseAmHomeDelivery(html: string, raw: string): CarrierResult {
  const number = normalizeAmHomeDeliveryNumber(raw);
  const $ = load(html);
  const notice = $('.error-message');
  if (notice.length && !$('#info-table').length) {
    if (clean(notice.text(), 200) === NOT_FOUND) throw new NotFoundError(PROVIDER);
    invalid('AM Home Delivery answered with a notice it does not usually give');
  }
  if (clean($('h1.title').text(), 80) !== 'Delivery Status' || $('#info-table').length !== 1) {
    if (isAmHomeDeliveryBlockPage(html)) throw new ChallengeError(PROVIDER, 'AM Home Delivery answered with a block page');
    invalid('AM Home Delivery did not return its tracking page');
  }
  const values = summary($);
  const track = normalizeTrackingNumber(values.get('Track Number') ?? '');
  if (!track) invalid('AM Home Delivery returned a shipment without its track number');
  if (track !== number) {
    // A bill of lading number is the shipper's, and several shippers can use the same one.
    if (normalizeTrackingNumber(values.get('BOL Number') ?? '') === number) {
      throw new IndeterminateError(PROVIDER, 'AM Home Delivery found the number only as a shipper’s bill of lading number');
    }
    throw new IndeterminateError(PROVIDER, 'AM Home Delivery answered for another shipment');
  }

  const events = history($);
  // The last mile status, the shipment's status and the rail's current step, in the order their wording is preferred.
  const stated: Stated[] = [values.get('Last Mile Status') ?? '', values.get('Current Status') ?? '', railStep($)]
    .flatMap((text) => {
      const staged = text ? amHomeDeliveryStage(text) : null;
      return staged ? [{ text, staged }] : [];
    });
  const fallbackText = values.get('Last Mile Status') || values.get('Current Status') || '';
  if (!events.length && !stated.length && !fallbackText) throw new NoHistoryError(PROVIDER);

  // A delivery ends the shipment, whether a row or the summary records it. A
  // problem in the newest staged row, then in the summary, is the current
  // state; otherwise the further of that row and the summary is.
  const rank = (stage: Stage) => FORWARD.indexOf(stage);
  const delivery = events.find((event) => event.stage === 'delivered');
  const staged = events.find((event) => event.stage);
  const row: ClassifiedWording | null = staged ? { stage: staged.stage as Stage, source: staged.stage_source! } : null;
  const problem = stated.find((item) => rank(item.staged.stage) < 0);
  const ahead = stated.filter((item) => rank(item.staged.stage) >= 0)
    .reduce<Stated | undefined>((best, item) => (!best || rank(item.staged.stage) > rank(best.staged.stage) ? item : best), undefined);
  const fromSummary: Stated | undefined = delivery ? undefined
    : ahead?.staged.stage === 'delivered' ? ahead
      : row && rank(row.stage) < 0 ? undefined
        : problem ?? (ahead && (!row || rank(ahead.staged.stage) > rank(row.stage)) ? ahead : undefined);
  const decided: ClassifiedWording | null = delivery ? { stage: 'delivered', source: delivery.stage_source! }
    : fromSummary?.staged ?? row;
  // A summary ahead of every row is the current state, without a clock.
  const current = fromSummary ? undefined : events[0];
  const stage = decided?.stage;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(decided ? { current_stage: decided.stage, current_stage_source: decided.source } : {}),
    last_status_text: fromSummary?.text ?? current?.description ?? (fallbackText || null),
    last_update: null,
    ...(current ? { last_update_local: current.local_time } : {}),
    ...(stage && FINAL.has(stage) ? { expected_delivery: null }
      : estimate(clean($('#info-delivery .info-data').first().text(), 120))),
    ...(events.length ? {} : { summary_only: true }),
    events,
  };
}
