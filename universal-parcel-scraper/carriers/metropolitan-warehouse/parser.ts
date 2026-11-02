import { load } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { metropolitanWarehouseStage } from './status.js';

export const PROVIDER = 'Metropolitan Warehouse & Delivery';
// An order's page is about 16 kB.
export const METROPOLITAN_WAREHOUSE_MAX_BYTES = 512 * 1024;

// The tracker takes twelve digits and nothing else.
const NUMBER = /^\d{12}$/;
// The tracker's answer for a number it holds no order under.
const UNKNOWN_MESSAGE = 'Tracking id does not exist.';
// The order's page, which the tracker opens under a key it issues for the number.
const DETAILS_PATH = /^\/Client\/GetWixOrderTrackingDetails\?eqs=[A-Za-z0-9%._~-]{8,512}$/;
// A firewall or bot check's page, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|_cf_chl_opt|cf-turnstile|requested URL was rejected|Incapsula incident|_Incapsula_Resource|captcha/i;
// "10/14/2026 02:21 AM"
const CLOCK = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}) ([AP]M)$/;
// The hub's name the tracker leaves out of its wording: "Furniture Received by Metro-<Warehouse>-Hub".
const PLACEHOLDER = /-<[A-Za-z ]{1,40}>-/g;
// A row's location that names no place.
const NOT_A_PLACE = /^in transit$/i;
const POUNDS = /^(\d{1,6}(?:\.\d{1,3})?) lbs?$/i;
const POUNDS_TO_KG = 0.453_592_37;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A tracking number as the tracker takes it, twelve digits; anything else is not one Metropolitan issues. */
export function normalizeMetropolitanWarehouseNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Metropolitan Warehouse tracking numbers are twelve digits');
  return number;
}

function blocked(body: string): boolean {
  return BLOCKED.test(body.slice(0, 64_000));
}

/**
 * The reply of `CheckTrackingId`, which the tracker asks before it opens an
 * order: whether it holds an order under the number. Only its own message
 * for a number it does not hold is a missing order.
 */
export function metropolitanWarehouseKnows(body: string): boolean {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch (cause) {
    if (blocked(body)) throw new ChallengeError(PROVIDER, 'Metropolitan Warehouse answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Metropolitan Warehouse returned a reply that is not JSON', { cause });
  }
  if (!isRecord(payload) || typeof payload.Result !== 'boolean') {
    throw new SchemaError(PROVIDER, 'Metropolitan Warehouse returned an invalid number check');
  }
  if (payload.Result) return true;
  if (typeof payload.Message === 'string' && clean(payload.Message, 200) === UNKNOWN_MESSAGE) return false;
  throw new IndeterminateError(PROVIDER, 'Metropolitan Warehouse could not check the tracking number');
}

/** The reply of `TrackOrderWix_encryptUrl`: the path of the order's page, as text or as a JSON string. */
export function metropolitanWarehouseDetailsPath(body: string): string {
  let path: unknown = body.trim();
  if (typeof path === 'string' && path.startsWith('"')) {
    try {
      path = JSON.parse(path);
    } catch (cause) {
      throw new SchemaError(PROVIDER, 'Metropolitan Warehouse returned an invalid order link', { cause });
    }
  }
  if (typeof path === 'string' && DETAILS_PATH.test(path)) return path;
  if (blocked(body)) throw new ChallengeError(PROVIDER, 'Metropolitan Warehouse answered with a browser check');
  throw new SchemaError(PROVIDER, 'Metropolitan Warehouse returned an invalid order link');
}

/** The array literal a page script assigns to `name`, up to its closing bracket, or null. */
function scriptArray(html: string, name: string): string | null {
  const start = new RegExp(`\\bvar\\s+${name}\\s*=\\s*\\[`).exec(html);
  if (!start) return null;
  const from = start.index + start[0].length - 1;
  let depth = 0;
  let quoted = false;
  for (let index = from; index < html.length; index += 1) {
    const character = html[index];
    if (quoted) {
      if (character === '\\') index += 1;
      else if (character === '"') quoted = false;
    } else if (character === '"') {
      quoted = true;
    } else if (character === '[' || character === '{') {
      depth += 1;
    } else if ((character === ']' || character === '}') && --depth === 0) {
      return html.slice(from, index + 1);
    }
  }
  return null;
}

/** "10/14/2026 02:21 AM" as a wall clock without an offset, or null. */
function wallClock(value: string): string | null {
  const match = CLOCK.exec(value);
  if (!match) return null;
  const [, month, day, year, hour, minute, half] = match;
  const date = calendarDay(Number(year), Number(month), Number(day));
  if (!date || Number(hour) < 1 || Number(hour) > 12 || Number(minute) > 59) return null;
  return `${date}T${String((Number(hour) % 12) + (half === 'PM' ? 12 : 0)).padStart(2, '0')}:${minute}:00`;
}

/** An optional text field; anything but a string is a changed page. */
function text(row: Record<string, unknown>, key: string, maxLength: number): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Metropolitan Warehouse returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** One row of `historyTrans`: its code, wording, clock and the town and state it names. Its row id is not read. */
function eventOf(row: unknown): CarrierEvent {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Metropolitan Warehouse returned an invalid history row');
  const code = row.EventID;
  if (typeof code !== 'number' || !Number.isSafeInteger(code) || code < 0) {
    throw new SchemaError(PROVIDER, 'Metropolitan Warehouse returned a row without its event code');
  }
  const description = clean(text(row, 'Event', 500).replace(PLACEHOLDER, '-'), 300);
  if (!description) throw new SchemaError(PROVIDER, 'Metropolitan Warehouse returned a row without its event');
  // The page shows a row without a date with an empty date.
  const date = text(row, 'Date', 40);
  const local = date ? wallClock(date) : null;
  if (date && !local) throw new SchemaError(PROVIDER, 'Metropolitan Warehouse returned an invalid event clock');
  const location = text(row, 'Location', 120);
  const staged = metropolitanWarehouseStage(String(code), description);
  return {
    ...(local ? { local_time: local } : {}),
    description,
    ...(location && !NOT_A_PLACE.test(location) ? { location } : {}),
    provider_code: String(code),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/** The service level the page names, such as Room of Choice, and the order's weight in kilograms. */
function details(html: string): { service_name?: string; weight_kg?: number } {
  const $ = load(html);
  const heading = $('.print_heading').filter((_, node) => clean($(node).text(), 40) === 'Service Type');
  const service = heading.length === 1 ? clean(heading.next('div').children('span').first().text(), 80) : '';
  const labels = $('label').filter((_, node) => clean($(node).text(), 40) === 'Weight:');
  const pounds = labels.length === 1 ? POUNDS.exec(clean(labels.next('span').text(), 40))?.[1] : undefined;
  const kilograms = pounds === undefined ? 0 : Math.round(Number(pounds) * POUNDS_TO_KG * 1000) / 1000;
  return { ...(service ? { service_name: service } : {}), ...(kilograms > 0 ? { weight_kg: kilograms } : {}) };
}

/**
 * The order's page, `GetWixOrderTrackingDetails`. Its script holds the
 * history, `historyTrans`, newest first, and the number the page shows,
 * which must be the whole number asked. Every clock is a wall clock without
 * an offset. The page also names the destination town and postcode, the
 * order's references, the delivering carrier's PRO number, the number of
 * items and their volume; none of them is read.
 */
export function parseMetropolitanWarehouse(html: string, raw: string): CarrierResult {
  const number = normalizeMetropolitanWarehouseNumber(raw);
  const history = scriptArray(html, 'historyTrans');
  if (history === null) {
    if (blocked(html)) throw new ChallengeError(PROVIDER, 'Metropolitan Warehouse answered with a browser check');
    throw new SchemaError(PROVIDER, 'Metropolitan Warehouse returned an order page without its history');
  }
  const shown = /\bvar\s+TrackingId\s*=\s*'([^'\\]{0,64})'/.exec(html)?.[1];
  if (shown === undefined) throw new SchemaError(PROVIDER, 'Metropolitan Warehouse returned an order page without its number');
  if (normalizeTrackingNumber(shown) !== number) throw new IndeterminateError(PROVIDER, 'Metropolitan Warehouse answered for another order');
  let rows: unknown;
  try {
    rows = JSON.parse(history);
  } catch (cause) {
    throw new SchemaError(PROVIDER, 'Metropolitan Warehouse returned an unreadable history', { cause });
  }
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Metropolitan Warehouse returned an invalid history');
  const seen = new Set<string>();
  const events = rows.map(eventOf).filter((event) => {
    const key = JSON.stringify(event);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the page lists them; a history listed oldest first is turned round.
  const clocks = events.map((event) => event.local_time).filter((clock): clock is string => typeof clock === 'string');
  if (clocks.length > 1 && clocks[0]! < clocks.at(-1)!) events.reverse();
  const decider = events.find((event) => event.stage);
  const stage = decider?.stage as Stage | undefined;
  const newest = events.find((event) => event.local_time);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: decider!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: events[0]!.description!,
    last_update: null,
    ...(newest ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    ...details(html),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
