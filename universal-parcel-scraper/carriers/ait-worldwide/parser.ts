import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { aitStage } from './status.js';

export const PROVIDER = 'AIT Worldwide Logistics';
/** FasTrak, which renders the shipments it finds for the number in its address on the server. */
export const FASTRAK = 'https://fastrak.aitworldwide.com/';
// A shipment's page is under fifty kilobytes; each further shipment found adds about ten.
export const AIT_MAX_BYTES = 1_000_000;

// AIT bills: seven to nine digits on current shipments; the former tracker took up to ten
// letters and digits.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{7,10}$/;
// A row's clock as the page's data writes it: a wall time to the second, without an offset.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,7})?$/;
// A delivery appointment with its window, stamped with the window's start.
const APPOINTMENT_CODE = 'APPTDE';
const APPOINTMENT = /^APPOINTMENT DELIVERY SCHEDULED ON (\d{2})\/(\d{2})\/(\d{4})\b/i;
const NOT_FOUND = /^Tracking Number\(s\) Not Found:\s*(.{1,400})$/i;
// The history grid's rows, inside the grid's settings, and the number the grid belongs to.
const GRID_DATA = '"data":{"Data":';
const GRID_ID = /jQuery\("#EventHistoryGrid_(\d{1,3})"\)\.kendoGrid\(/;
const GRID_NUMBER = /function GetShipmentInfo_(\d{1,3})\(\)\s*\{\s*return\s*\{\s*TrackingNumber:\s*'([^']{0,64})'\s*\};?\s*\}/;
// Who took the freight, after the verb that names them.
const TAKER = /\b(signed|received)(\s+for)?\s+by\b.*$/i;
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
// Bot checks a CDN or firewall could put in place of the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|<title>\s*Attention Required|cf-error-details|_Incapsula_Resource|Incapsula incident|g-recaptcha|h-captcha|captcha/i;
// The stages a shipment moves forward through, in order.
const FORWARD: readonly Stage[] = ['registered', 'accepted', 'in_transit', 'out_for_delivery', 'delivered'];
const MAX_SHIPMENTS = 50;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** An AIT bill number, as typed; anything else is not one FasTrak looks up. */
export function normalizeAitNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'AIT bill numbers are seven to ten letters and digits');
  return number;
}

function invalid(message: string): never {
  throw new SchemaError(PROVIDER, message);
}

/** The JSON object that starts at `start`, read up to its closing brace. */
function jsonObjectAt(source: string, start: number): unknown {
  let depth = 0;
  let quoted = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '\\') index += 1;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(source.slice(start, index + 1));
        } catch {
          break;
        }
      }
    }
  }
  return invalid('FasTrak returned an unreadable history');
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') invalid(`FasTrak returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A row's wall clock, checked against the calendar. No clock names its zone. */
function clockOf(row: Record<string, unknown>): string {
  const match = CLOCK.exec(text(row, 'DateAndTime', 40));
  if (!match) invalid('FasTrak returned a history row without its time');
  const [, year, month, date, hour, minute, second] = match;
  const day = calendarDay(Number(year), Number(month), Number(date));
  // The clock's fields are checked here, since date libraries accept hour 24.
  if (!day || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) invalid('FasTrak returned an invalid history time');
  return `${day}T${hour}:${minute}:${second}`;
}

interface Row {
  event: CarrierEvent;
  /** The day of a delivery appointment, which is an estimate and not a scan. */
  appointment: string | null;
}

/** One row of the history grid: its `DateAndTime`, `Code` and `Description`. */
function rowOf(row: unknown): Row {
  if (!isRecord(row)) invalid('FasTrak returned an invalid history row');
  const local_time = clockOf(row);
  const code = text(row, 'Code', 16).toUpperCase();
  // Whoever signed for the freight is left out of the wording.
  const description = clean(text(row, 'Description', 200).replace(TAKER, '$1$2').replace(/[\s,;:-]+$/, ''), 160);
  if (!description) invalid('FasTrak returned a history row without its status');
  const booked = APPOINTMENT.exec(description);
  if (code === APPOINTMENT_CODE || booked) {
    const day = booked ? calendarDay(Number(booked[3]), Number(booked[1]), Number(booked[2])) : null;
    return { event: { local_time, description }, appointment: day ?? local_time.slice(0, 10) };
  }
  const staged = aitStage(code || null, description);
  return {
    event: {
      local_time,
      description,
      ...(code ? { provider_code: code } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    },
    appointment: null,
  };
}

interface Shipment {
  number: string;
  /** The progress label over the meter, such as "In Transit". */
  progress: string;
  /** The day, month and weekday under "Deliver By", without a year. */
  deliverBy: { month: number; day: number; weekday: number } | null;
  /** The history's rows newest first, or null when the page lists none. */
  rows: Row[] | null;
  truncated: boolean;
}

/** The panel of a shipment headed by `title`. */
function panel($: CheerioAPI, block: Cheerio<Element>, title: string): Cheerio<Element> {
  return block.find('.panel').filter((_, node) => clean($(node).children('.panel-heading').text(), 60).toLowerCase() === title.toLowerCase())
    .children('.panel-body');
}

/** The "Deliver By" day of the delivery panel: a weekday, a month and a day, without a year. */
function deliverByOf($: CheerioAPI, body: Cheerio<Element>): Shipment['deliverBy'] {
  const lines = body.children('h2, h3, h4').toArray().map((node) => ({ tag: node.tagName, text: clean($(node).text(), 40).toLowerCase() }));
  if (lines[0]?.tag !== 'h4' || lines[0].text !== 'deliver by') return null;
  const weekday = WEEKDAYS.indexOf(lines.find((line) => line.tag === 'h3')?.text ?? '') + 1;
  const month = MONTHS.indexOf(lines.filter((line) => line.tag === 'h4')[1]?.text ?? '') + 1;
  const day = Number(/^\d{1,2}$/.exec(lines.find((line) => line.tag === 'h2')?.text ?? '')?.[0] ?? Number.NaN);
  return weekday && month && day >= 1 && day <= 31 ? { month, day, weekday } : null;
}

/** The history grid of a shipment, bound to the number its page script names. */
function historyOf($: CheerioAPI, block: Cheerio<Element>, number: string): Pick<Shipment, 'rows' | 'truncated'> {
  const scripts = block.find('script').toArray().map((node) => $(node).html() ?? '');
  const grids = scripts.filter((script) => GRID_ID.test(script) && script.includes(GRID_DATA));
  if (!grids.length) return { rows: null, truncated: false };
  if (grids.length > 1) invalid('FasTrak returned several histories for one shipment');
  const grid = grids[0]!;
  const owner = scripts.map((script) => GRID_NUMBER.exec(script)).find((match) => match !== null);
  if (!owner || owner[1] !== GRID_ID.exec(grid)![1]) invalid('FasTrak returned a history without its shipment');
  if (normalizeTrackingNumber(owner[2]!) !== number) throw new IndeterminateError(PROVIDER, 'FasTrak listed the history of another shipment');
  const data = jsonObjectAt(grid, grid.indexOf(GRID_DATA) + '"data":'.length);
  if (!isRecord(data) || !Array.isArray(data.Data)) invalid('FasTrak returned an invalid history');
  const list: unknown[] = data.Data;
  if (list.length > MAX_ROWS) invalid('FasTrak returned an oversized history');
  const total = data.Total;
  if (total !== undefined && (typeof total !== 'number' || !Number.isInteger(total) || total < 0)) invalid('FasTrak returned an invalid history');
  return { rows: list.map(rowOf), truncated: typeof total === 'number' && total > list.length };
}

/** A shipment the page lists: its number, and the rest only for the number asked. */
function shipmentOf($: CheerioAPI, node: Element, asked: string): Shipment | { number: string } {
  const block = $(node);
  const label = block.find('[id="lblTrackNum"]');
  if (label.length !== 1) invalid('FasTrak returned a shipment without its number');
  const number = normalizeTrackingNumber(clean(label.text(), 64));
  if (!number) invalid('FasTrak returned a shipment without its number');
  if (number !== asked) return { number };
  const progress = panel($, block, 'Shipment Progress');
  const delivery = panel($, block, 'Shipment Delivery');
  if (progress.length !== 1 || delivery.length !== 1) invalid('FasTrak returned a shipment without its progress');
  return {
    number,
    progress: clean(progress.find('h3').first().text(), 80),
    deliverBy: deliverByOf($, delivery),
    ...historyOf($, block, number),
  };
}

/** The number a not-found warning names, split into the numbers it lists. */
function notFoundNumbers($: CheerioAPI): string[] | null {
  const warning = $('[id="NotFoundWarning"]');
  if (!warning.length) return null;
  const listed = NOT_FOUND.exec(clean(warning.text(), 500))?.[1];
  if (!listed) invalid('FasTrak returned an unexpected warning');
  return listed.split(/[\s,;]+/).map(normalizeTrackingNumber).filter(Boolean);
}

/** A calendar day as a date without a zone, to compare days. */
const dayOf = (day: string) => DateTime.fromISO(day, { zone: 'utc' });

/** The "Deliver By" day, in the year nearest the newest row's with that weekday. */
function deliverByDay(deliverBy: Shipment['deliverBy'], anchor: string | null): string | null {
  if (!deliverBy || !anchor) return null;
  const from = dayOf(anchor);
  const days = [from.year - 1, from.year, from.year + 1].map((year) => calendarDay(year, deliverBy.month, deliverBy.day))
    .filter((day): day is string => day !== null && dayOf(day).weekday === deliverBy.weekday);
  const distance = (day: string) => Math.abs(dayOf(day).diff(from, 'days').days);
  return days.sort((left, right) => distance(left) - distance(right))[0] ?? null;
}

/** The newest-first history without repeated rows. */
function distinct(events: readonly CarrierEvent[]): CarrierEvent[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    const key = JSON.stringify([event.local_time, event.provider_code ?? '', event.description]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * FasTrak's page `fastrak.aitworldwide.com/?trackingnumber={number}`. It
 * lists each shipment whose bill number or shipper's reference matches, each
 * with its bill number, the town it is delivered to, its progress, its
 * delivery panel and its history newest first, as data in the history grid's
 * settings. A number it does not know is a warning naming it. Only a shipment
 * whose bill number is the number asked is read; the town, the signer, the
 * office's phone number, the rows' explanations and the delivery scheduling
 * are not.
 */
export function parseAit(html: string, raw: string): CarrierResult {
  const asked = normalizeAitNumber(raw);
  const $ = load(html);
  const nodes = $('div[id="TrackingDetails"]').toArray();
  if (nodes.length > MAX_SHIPMENTS) invalid('FasTrak returned too many shipments');
  const shipments = nodes.map((node) => shipmentOf($, node, asked));
  const own = shipments.filter((shipment): shipment is Shipment => 'progress' in shipment);
  if (own.length > 1) throw new IndeterminateError(PROVIDER, 'FasTrak answered with several shipments for the number');
  const shipment = own[0];
  if (!shipment) {
    const missing = notFoundNumbers($);
    if (missing?.includes(asked)) throw new NotFoundError(PROVIDER);
    if (missing || shipments.length) throw new IndeterminateError(PROVIDER, 'FasTrak answered for another shipment');
    if (CHALLENGE.test(html.slice(0, 200_000))) throw new ChallengeError(PROVIDER, 'FasTrak answered with a browser check');
    invalid('FasTrak returned a page without a shipment');
  }

  const rows = shipment.rows ?? [];
  const events = distinct(rows.filter((row) => !row.appointment).map((row) => row.event));
  const appointment = rows.find((row) => row.appointment)?.appointment ?? null;
  const progress = shipment.progress ? aitStage(null, shipment.progress) : null;
  if (!events.length && !shipment.progress) throw new NoHistoryError(PROVIDER);

  // A delivery ends the shipment, whether a row or the progress meter records it. A problem in
  // the newest staged row is the current state; otherwise the further of that row and the
  // meter is.
  const delivery = events.find((event) => event.stage === 'delivered');
  const staged = events.find((event) => event.stage);
  const row: ClassifiedWording | null = staged ? { stage: staged.stage as Stage, source: staged.stage_source! } : null;
  const ahead = progress !== null && (progress.stage === 'delivered' || !row
    || (FORWARD.includes(row.stage) && FORWARD.includes(progress.stage) && FORWARD.indexOf(progress.stage) > FORWARD.indexOf(row.stage)));
  const fromMeter = !delivery && ahead;
  const decided = delivery ? { stage: 'delivered' as Stage, source: delivery.stage_source! } : fromMeter ? progress : row;
  // The meter ahead of every row is the current state, without a clock.
  const current = fromMeter ? undefined : events[0];
  const settled = decided?.stage === 'delivered' || decided?.stage === 'returned';
  const newest = typeof events[0]?.local_time === 'string' ? events[0].local_time.slice(0, 10) : null;
  return {
    status: decided ? languageStageStatus(decided.stage) : 'unknown',
    ...(decided ? { current_stage: decided.stage, current_stage_source: decided.source } : {}),
    last_status_text: fromMeter ? shipment.progress : current?.description ?? (shipment.progress || null),
    last_update: null,
    ...(current?.local_time ? { last_update_local: current.local_time } : {}),
    // Until the delivery, the newest appointment's day, else the day the page says to deliver by.
    expected_delivery: settled ? null : appointment ?? deliverByDay(shipment.deliverBy, newest),
    ...(events.length ? {} : { summary_only: true }),
    events: events.slice(0, MAX_EVENTS),
    ...(shipment.truncated || events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
