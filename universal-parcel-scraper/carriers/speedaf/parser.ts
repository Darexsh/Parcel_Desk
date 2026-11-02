import { DateTime, FixedOffsetZone } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { speedafStage } from './status.js';

export const PROVIDER = 'Speedaf';
// A long history is a few dozen kilobytes.
export const SPEEDAF_MAX_BYTES = 512 * 1024;
// Letters and digits with at least one digit. The tracker reads a lower-case number as unknown.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,30}$/;
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const COUNTRY = /^[A-Z]{2}$/;
// The scans the page hides unless the waybill carries its exception flag.
const HIDDEN_ACTION = '-2';
// How the service words a refusal to answer more requests.
const THROTTLED = /too many|too frequent|frequently|rate limit|请求(?:过于)?频繁|访问(?:过于)?频繁/i;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A number for Speedaf's tracker, in upper case; anything else is not one it issues. */
export function normalizeSpeedafNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Speedaf numbers are letters and digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 500): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Speedaf returned an invalid ${key}`);
  return clean(value, maxLength);
}

// The courier's label ends the wording: the courier's name, and in some
// countries their phone, follow it. Some sites call the collecting courier
// "the pick-up".
const COURIER = /\s*[,，;；.]?\s*(?:the\s+)?(?:(?:pick-?up|delivery)\s+courier|courier|pick-?up)\s+is\b[\s\S]*$|\s*[,，;；]?\s*(?:收件员|派件员|快递员)[\s\S]*$/i;
// The English delivery scan opens with the clerk's name: "【name】in 【site】scanned for delivery".
const LEADING_CLERK = /^\s*【[^】]*】\s*in\s*(?=【)/i;
// The recipient who signed and the scanning clerk, in 【】 after their label
// inside the wording: the label and its brackets go.
const PERSON = /\s*[,，;；]?\s*(?:and\s+)?(?:received by|signed by|签收人是|签收人|扫描员是)\s*(?:【[^】]*】\s*)+/gi;
// Such a label left without its brackets: the rest of the wording goes with it.
const PERSON_LABEL = /\s*[,，;；]?\s*(?:received by|signed by|签收人|扫描员)[\s\S]*$/i;
// A run of nine or more digits, with spaces, brackets, dots or hyphens
// between them, as phone numbers are written; a date stays.
const PHONE = /(?<![A-Z\d])(?!\d{4}-\d{2}-\d{2}(?!\d))\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;

/**
 * A scan's wording without the people it names. Pickup, delivery and
 * signature scans name the courier, the scanning clerk and the recipient, and
 * in some countries the courier's phone, in 【】 after fixed English and
 * Chinese labels.
 */
export function speedafWording(raw: string): string {
  return clean(raw
    .replace(LEADING_CLERK, '')
    .replace(COURIER, '')
    .replace(PERSON, '')
    .replace(PERSON_LABEL, '')
    .replace(PHONE, '')
    .replace(/【\s*】/g, '')
    .replace(/\s+([,，;；.。])/g, '$1'))
    .replace(/^[\s,，;；]+|[\s,，;；]+$/g, '');
}

/** The offset `timezone` gives in hours, in minutes; null when it gives none a clock can have. */
function offsetMinutes(value: unknown): number | null {
  const hours = typeof value === 'number' ? value
    : typeof value === 'string' && /^[+-]?\d{1,2}(?:\.\d{1,2})?$/.test(value.trim()) ? Number(value) : Number.NaN;
  const minutes = hours * 60;
  return Number.isInteger(minutes) && minutes % 15 === 0 && minutes >= -12 * 60 && minutes <= 14 * 60 ? minutes : null;
}

/**
 * A scan's time. `time` is the scanning site's wall clock and `timezone` its
 * offset in hours: 8 for the Chinese warehouses, 2 in South Africa. Without a
 * usable offset the wall clock is kept as it is.
 */
function scanTime(row: Record<string, unknown>): { time: string } | { local_time: string } {
  const stamp = text(row, 'time', 64);
  const local = stamp.replace(' ', 'T');
  const minutes = offsetMinutes(row.timezone);
  const parsed = firstOccurrence(DateTime.fromISO(local, { zone: minutes === null ? 'UTC' : FixedOffsetZone.instance(minutes) }));
  // Luxon rolls 24:00:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!WALL_CLOCK.test(stamp) || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'Speedaf returned an invalid scan time');
  }
  const iso = minutes === null ? null : parsed.toISO({ suppressMilliseconds: true });
  return iso ? { time: iso } : { local_time: local };
}

function sortKey(event: CarrierEvent): number {
  return typeof event.time === 'string'
    ? DateTime.fromISO(event.time, { setZone: true }).toMillis()
    : DateTime.fromISO(event.local_time as string, { zone: 'UTC' }).toMillis();
}

/**
 * A scan's code: its `action`, then its `subAction` after a colon when the two
 * differ. An issue scan (-1) gives its reason only in the sub-action.
 */
export function speedafCode(row: Record<string, unknown>): string {
  const action = cleanScalar(row.action, 16);
  const detail = cleanScalar(row.subAction, 16);
  return action && detail && detail !== action ? `${action}:${detail}` : action;
}

function projectRow(row: Record<string, unknown>): { key: string; event: CarrierEvent } {
  const code = speedafCode(row);
  // English, else Chinese: the two wordings whose person clauses are known. `msgLoc`,
  // the destination country's language, can be one whose labels are not.
  const description = speedafWording(text(row, 'msgEng') || text(row, 'message') || text(row, 'actionName', 200));
  if (!description) throw new SchemaError(PROVIDER, 'Speedaf returned a scan without wording');
  const when = scanTime(row);
  const staged = speedafStage(code, description);
  const event: CarrierEvent = {
    ...when,
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([when, code, description]), event };
}

/**
 * The reply of `listExpressTrack` for one number. It always answers HTTP 200
 * with `success`, `error` and `data`, one entry per number asked. The entry
 * must name the number asked. An entry without a destination country or a
 * scan is a number Speedaf does not know; a record with its country but no
 * scan has no history to show.
 */
export function parseSpeedaf(payload: unknown, raw: string): CarrierResult {
  const number = normalizeSpeedafNumber(raw);
  if (!isRecord(payload) || typeof payload.success !== 'boolean') throw new SchemaError(PROVIDER, 'Speedaf returned an invalid envelope');
  if (!payload.success) {
    const message = isRecord(payload.error) ? clean(payload.error.message, 200) : '';
    if (THROTTLED.test(message)) throw new RateLimitedError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Speedaf did not complete the lookup');
  }
  if (!Array.isArray(payload.data)) throw new SchemaError(PROVIDER, 'Speedaf returned a reply without shipments');
  if (payload.data.some((entry) => !isRecord(entry) || typeof entry.mailNo !== 'string')) {
    throw new SchemaError(PROVIDER, 'Speedaf returned a shipment without its number');
  }
  const entry = (payload.data as Record<string, unknown>[]).find((candidate) => candidate.mailNo === number);
  if (!entry) throw new IndeterminateError(PROVIDER, 'Speedaf did not answer for the shipment');
  const rows = entry.tracks ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Speedaf returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Speedaf returned an oversized history');
  const country = text(entry, 'countryCode', 8).toUpperCase();
  if (!rows.length && !country) throw new NotFoundError(PROVIDER);

  const flagged = entry.blExceptionSign === true;
  const seen = new Set<string>();
  const events: { event: CarrierEvent; index: number }[] = [];
  let foreign = 0;
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Speedaf returned an invalid scan');
    const owner = text(row, 'mailNo', 64);
    // Only the waybill's own scans; a multi-piece waybill's pieces are not followed.
    if (owner && owner.toUpperCase() !== number) {
      foreign += 1;
      continue;
    }
    if (!flagged && cleanScalar(row.action, 16) === HIDDEN_ACTION) continue;
    const scan = projectRow(row);
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    events.push({ event: scan.event, index: events.length });
  }
  if (!events.length) {
    if (foreign) throw new IndeterminateError(PROVIDER, 'Speedaf answered with scans of another shipment');
    throw new NoHistoryError(PROVIDER);
  }
  // Newest first, as the reply orders them; scans on one clock keep their order.
  const newestFirst = events
    .map(({ event, index }) => ({ event, index, key: sortKey(event) }))
    .sort((a, b) => (a.key === b.key ? a.index - b.index : b.key - a.key))
    .map(({ event }) => event);

  const newest = newestFirst[0]!;
  const current = newestFirst.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const delivered = stage === 'delivered' && typeof current!.time === 'string' ? current!.time : null;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: typeof newest.time === 'string' ? newest.time : null,
    ...(typeof newest.local_time === 'string' ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    ...(delivered ? { delivered_at: delivered } : {}),
    ...(COUNTRY.test(country) ? { destination_country: country } : {}),
    events: newestFirst.slice(0, MAX_EVENTS),
    ...(newestFirst.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
