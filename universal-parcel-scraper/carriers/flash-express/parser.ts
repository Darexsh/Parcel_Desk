import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { zonedTime } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { flashExpressStage } from './status.js';

export const PROVIDER = 'Flash Express';
// A long history is a few dozen kilobytes.
export const FLASH_EXPRESS_MAX_BYTES = 512 * 1024;
// `TH`, four digits, six or seven letters and digits and a letter; a return
// waybill adds a digit.
const NUMBER = /^TH\d{4}[0-9A-Z]{6,7}[A-Z]\d?$/;
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
// Thailand keeps one offset all year; the scans are on its clock.
const ZONE = 'Asia/Bangkok';
// How the service words a refusal to answer more requests.
const THROTTLED = /too many|too frequent|frequently|rate limit|บ่อยเกินไป|频繁/i;
// The parcel's state in the summary, when it ends or stops the journey:
// signed for, a problem parcel, returned under a new number, closed, or
// returned at the shipper's request.
const SUMMARY_STAGES: ReadonlyMap<number, Stage> = new Map([
  [5, 'delivered'], [6, 'exception'], [7, 'returned'], [8, 'exception'], [9, 'returned'],
]);
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A number for Flash Express's tracker, in upper case; anything else is not one it issues. */
export function normalizeFlashExpressNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Flash Express numbers are TH, four digits, then letters and digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 500): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Flash Express returned an invalid ${key}`);
  return clean(value, maxLength);
}

// The scan's district and province, each in 【】, end the wording after commas.
const PLACE = /(?:\s*[,，]\s*【[^】]*】){1,2}\s*$/;
// The recipient who signed, with how they relate to the parcel, after the
// English or Thai label: in 【】, else up to the end of the clause.
const SIGNER = /\s*(?:and\s+)?(?:signed by|เซ็นรับโดย)\s*(?:【[^】]*】|[^.,，。【]*)/gi;
// What a change of the parcel's details changed, such as the recipient's
// name from one value to another: only the opening clause stays.
const CHANGE = /\s*(?:[,，:：(（]|\b(?:from|to)\b|จาก|เปลี่ยนเป็น)[\s\S]*$/i;
const CHANGE_CODES = new Set(['CHANGE_PARCEL_INFO', 'CUSTOMER_CHANGE_PARCEL_INFO']);
// A run of nine or more digits, with spaces, brackets, dots or hyphens
// between them, as phone numbers are written; a date stays.
const PHONE = /(?<![A-Z\d])(?!\d{4}-\d{2}-\d{2}(?!\d))\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
// A phone number with its middle masked, as the page lists the courier's calls.
const MASKED_PHONE = /\d{2,4}\*{3,}\d{2,4}/g;

/**
 * A scan's wording and place: the district and province suffix becomes the
 * place. A tracker that names the province first gets it put after the town.
 */
export function flashExpressWording(raw: string, code = '', options: { provinceFirst?: boolean } = {}): { description: string; location: string } {
  const value = clean(raw, 1000);
  const suffix = PLACE.exec(value);
  const places = suffix ? [...suffix[0].matchAll(/【([^】]*)】/g)].map((match) => clean(match[1], 100)).filter(Boolean) : [];
  if (options.provinceFirst) places.reverse();
  let wording = suffix ? value.slice(0, suffix.index) : value;
  if (CHANGE_CODES.has(code)) wording = wording.replace(CHANGE, '');
  const description = clean(wording
    .replace(SIGNER, '')
    .replace(PHONE, '')
    .replace(MASKED_PHONE, '')
    .replace(/【\s*】/g, '')
    .replace(/\[\s+/g, '[').replace(/\s+\]/g, ']')
    .replace(/\s+([,，;；.。])/g, '$1'), 500)
    .replace(/^[\s,，;；]+|[\s,，;；]+$/g, '');
  return { description, location: [...new Set(places)].join(', ') };
}

/** A scan's time: its wall clock in Bangkok. */
function scanTime(row: Record<string, unknown>): string {
  const stamp = text(row, 'routed_at', 64);
  const parsed = WALL_CLOCK.test(stamp) ? zonedTime(stamp, 'yyyy-MM-dd HH:mm:ss', ZONE) : null;
  // Luxon rolls 24:00:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!parsed || parsed.iso.slice(0, 19) !== stamp.replace(' ', 'T')) {
    throw new SchemaError(PROVIDER, 'Flash Express returned an invalid scan time');
  }
  return parsed.iso;
}

function projectRow(row: Record<string, unknown>): FlashExpressScan {
  const code = text(row, 'route_action', 64);
  const { description, location } = flashExpressWording(text(row, 'message', 1000), code);
  if (!description) throw new SchemaError(PROVIDER, 'Flash Express returned a scan without wording');
  const time = scanTime(row);
  const staged = flashExpressStage(code, description);
  const event: FlashExpressScan['event'] = {
    time,
    ...(location ? { location } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { event, at: Date.parse(time) };
}

/** A scan read from a Flash Express tracker, with its instant for ordering. */
export interface FlashExpressScan {
  event: CarrierEvent & { time: string; description: string };
  at: number;
}

/**
 * One parcel's answer from its scans, in the reply's order, and the summary's
 * numeric state, which Flash's trackers in Thailand and the Philippines share.
 * A scan repeated on the same clock with the same code, wording and place
 * counts once.
 */
export function flashExpressResult(provider: string, scans: readonly FlashExpressScan[], state: number | undefined): CarrierResult {
  const seen = new Set<string>();
  const events: { event: CarrierEvent; at: number; index: number }[] = [];
  for (const { event, at } of scans) {
    const key = JSON.stringify([event.time, event.provider_code ?? '', event.description, event.location ?? '']);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push({ event, at, index: events.length });
  }
  if (!events.length) throw new NoHistoryError(provider);
  // Newest first, as the reply orders them; scans on one clock keep their order.
  const newestFirst = events.sort((a, b) => (a.at === b.at ? a.index - b.index : b.at - a.at)).map(({ event }) => event);

  const newest = newestFirst[0]!;
  const scanned = newestFirst.find((event) => event.stage);
  // The summary's state decides a journey that ended or stopped: a closure
  // can come before a delivery, and calls and reminders after it.
  const summary = state === undefined ? undefined : SUMMARY_STAGES.get(state);
  const stage = (summary ?? scanned?.stage) as Stage | undefined;
  const source = summary && summary !== scanned?.stage ? 'carrier_map' : scanned?.stage_source;
  const delivery = stage === 'delivered' ? newestFirst.find((event) => event.stage === 'delivered') : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: null,
    ...(delivery ? { delivered_at: delivery.time! } : {}),
    events: newestFirst.slice(0, MAX_EVENTS),
    ...(newestFirst.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}

/**
 * The reply of `/webApi/tools/tracking` for one number. It answers HTTP 200
 * with `code` 1 and `data`, which lists the numbers it does not know under
 * `error_search` and the others under `list`, each with the number searched
 * and its scans, newest first. Only an entry for the whole number asked is
 * read.
 */
export function parseFlashExpress(payload: unknown, raw: string): CarrierResult {
  const number = normalizeFlashExpressNumber(raw);
  if (!isRecord(payload) || !Object.hasOwn(payload, 'code')) throw new SchemaError(PROVIDER, 'Flash Express returned an invalid envelope');
  if (payload.code !== 1) {
    if (THROTTLED.test(cleanScalar(payload.message, 200))) throw new RateLimitedError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Flash Express did not complete the lookup');
  }
  const data = payload.data;
  if (!isRecord(data) || !Array.isArray(data.list) || !Array.isArray(data.error_search)) {
    throw new SchemaError(PROVIDER, 'Flash Express returned a reply without shipments');
  }
  if (data.list.some((entry) => !isRecord(entry) || typeof entry.search_no !== 'string')) {
    throw new SchemaError(PROVIDER, 'Flash Express returned a shipment without its number');
  }
  const entry = (data.list as Record<string, unknown>[]).find((candidate) => clean(candidate.search_no, 64) === number);
  if (!entry) {
    if (data.error_search.some((searched) => clean(searched, 64) === number)) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Flash Express did not answer for the shipment');
  }
  const rows = entry.routes ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Flash Express returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Flash Express returned an oversized history');
  if (entry.state !== undefined && entry.state !== null && typeof entry.state !== 'number') {
    throw new SchemaError(PROVIDER, 'Flash Express returned an invalid state');
  }
  const scans = rows.map((row) => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Flash Express returned an invalid scan');
    return projectRow(row);
  });
  return flashExpressResult(PROVIDER, scans, typeof entry.state === 'number' ? entry.state : undefined);
}
