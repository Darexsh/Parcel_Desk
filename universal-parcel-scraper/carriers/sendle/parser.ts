import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, RateLimitedError,
  SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { sendleCategoryStage, sendleStage } from './status.js';

export const PROVIDER = 'Sendle';
// One parcel's reply is a few hundred bytes.
export const SENDLE_MAX_BYTES = 256 * 1024;

// The tracking number under the label's barcode, and the booking e-mail's order number.
const TRACKING = /^QSS\d{9}$/;
const ORDER = /^QS\d{6}$/;
// A Convex document id and the challenge's salt, as `createChallenge` gives them.
const CHALLENGE_ID = /^[a-z0-9]{16,64}$/;
const SALT = /^[\x21-\x7e]{1,256}$/;
const CATEGORY = /^[a-z_]{1,32}$/;
// The reply's clock: to the minute at least, fractions of a second, and an offset only sometimes.
const CLOCK = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?$/;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
// The stages a parcel the tracker calls in transit can be at, by its newest scan.
const MOVING: ReadonlySet<string> = new Set(['accepted', 'in_transit', 'customs', 'out_for_delivery', 'failed_attempt',
  'ready_for_pickup', 'exception']);

/** A number for Sendle's tracker: `QSS` and nine digits, or an order number, `QS` and six digits. */
export function normalizeSendleNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!TRACKING.test(number) && !ORDER.test(number)) {
    throw new InvalidInputError(PROVIDER, 'Sendle numbers are QSS and nine digits, or an order number of QS and six digits');
  }
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Sendle returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * The value of a Convex function call's reply: `{"status":"success","value":…}`.
 * A failed call is `{"status":"error"}` with a request id and nothing more, which
 * says nothing about the parcel.
 */
export function convexValue(payload: unknown): unknown {
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Sendle returned an invalid reply');
  if (payload.status === 'success' && Object.hasOwn(payload, 'value')) return payload.value;
  if (payload.status === 'error') throw new IndeterminateError(PROVIDER, 'Sendle’s tracking service failed the request');
  throw new SchemaError(PROVIDER, 'Sendle returned an invalid reply');
}

export interface SendleChallenge {
  challengeId: string;
  salt: string;
  /** The leading zero bits the hash of `salt:nonce` must have. */
  difficulty: number;
}

/** The proof-of-work challenge `tracking:createChallenge` returns. */
export function parseSendleChallenge(value: unknown): SendleChallenge {
  if (!isRecord(value)) throw new SchemaError(PROVIDER, 'Sendle returned an invalid security check');
  const { challengeId, salt, difficulty } = value;
  if (typeof challengeId !== 'string' || !CHALLENGE_ID.test(challengeId) || typeof salt !== 'string' || !SALT.test(salt)
    || typeof difficulty !== 'number' || !Number.isInteger(difficulty) || difficulty < 0 || difficulty > 256) {
    throw new SchemaError(PROVIDER, 'Sendle returned an invalid security check');
  }
  return { challengeId, salt, difficulty };
}

/** The reply's number field, in capitals, or ''. */
function identity(result: Record<string, unknown>, key: string): string {
  const value = text(result, key, 64);
  return value ? normalizeTrackingNumber(value) : '';
}

/** A scan's wall clock to the second, and its instant when the reply states an offset. */
function scanClock(raw: string): { local: string; instant?: string } {
  const match = CLOCK.exec(raw);
  const local = match ? `${match[1]}T${match[2]}:${match[3] ?? '00'}` : '';
  // Parsing in UTC checks the calendar digits only; Luxon rolls 24:00 over, so only a clock that reads back unchanged is kept.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!match || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'Sendle returned an invalid scan time');
  }
  const instant = match[4] ? explicitOffsetTime(`${local}${match[4]}`)?.iso : undefined;
  return instant ? { local, instant } : { local };
}

/** The scans, newest first as the tracker lists them, without rows that have no wording or repeat one. */
function scans(rows: unknown): CarrierEvent[] {
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Sendle returned a parcel with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Sendle returned an oversized history');
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Sendle returned an invalid scan');
    const description = text(row, 'description');
    // The page's line under the scan is free text; it is read for a stage only, never kept.
    const detail = text(row, 'message', 1_000);
    const date = text(row, 'date', 64);
    // A row without wording or a clock places nothing.
    if (!description || !date) continue;
    const { local, instant } = scanClock(date);
    const key = JSON.stringify([instant ?? local, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = sendleStage(description, detail);
    events.push({
      // A clock without an offset stays the tracker's wall clock.
      ...(instant ? { time: instant } : { local_time: local }),
      description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    });
  }
  return events;
}

/**
 * The value of `tracking:lookupTracking` for one number. `status` is `found`
 * with the parcel's `result`, `not_found` for a number the tracker does not
 * know, `rate_limited` with `retryAfterSeconds`, `check_failed` for a
 * security check it did not take, or `invalid_reference` for a number of
 * another form. The result names the label's tracking number and the order
 * number; the one asked must be the whole number. Its `statusCategory` is the
 * parcel's status, and `events` the scans, newest first. Only those are read.
 */
export function parseSendle(value: unknown, raw: string): CarrierResult {
  const number = normalizeSendleNumber(raw);
  if (!isRecord(value)) throw new SchemaError(PROVIDER, 'Sendle returned an invalid lookup');
  switch (value.status) {
    case 'found':
      break;
    case 'not_found':
      throw new NotFoundError(PROVIDER, 'Sendle has no parcel or order under this number');
    case 'rate_limited': {
      const seconds = value.retryAfterSeconds;
      const wait = typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 3_600) * 1_000 : undefined;
      throw new RateLimitedError(PROVIDER, wait);
    }
    case 'check_failed':
      throw new ChallengeError(PROVIDER, 'Sendle did not accept the security check');
    case 'invalid_reference':
      // The tracker's own example numbers have the forms the adapter sends.
      throw new IndeterminateError(PROVIDER, 'Sendle’s tracker refused the number’s form');
    default:
      throw new SchemaError(PROVIDER, 'Sendle returned an unknown lookup status');
  }
  const result = value.result;
  if (!isRecord(result)) throw new SchemaError(PROVIDER, 'Sendle returned a lookup without its parcel');
  const tracking = identity(result, 'trackingNumber');
  const order = identity(result, 'orderNumber');
  if ((TRACKING.test(number) ? tracking : order) !== number) throw new IndeterminateError(PROVIDER, 'Sendle answered for another parcel');
  const category = text(result, 'statusCategory', 40);
  if (!CATEGORY.test(category)) throw new SchemaError(PROVIDER, 'Sendle returned an invalid status');
  const label = text(result, 'statusLabel', 120);
  const events = scans(result.events);
  // An order number's parcel goes by the label's number.
  const canonical = number !== tracking && TRACKING.test(tracking) ? { canonical_tracking_number: tracking } : {};

  const summary = sendleCategoryStage(category);
  const scanned = events.find((event) => event.stage);
  // The tracker's status decides. Within "transit" the page shows its newest scan's
  // pickup or delivery round, so a scan staged there refines it; a status that
  // names no milestone leaves the newest staged scan.
  const refined = category === 'transit' && scanned && MOVING.has(scanned.stage!) ? scanned : undefined;
  const stage = (refined?.stage ?? summary ?? scanned?.stage) as Stage | undefined;
  const source = refined?.stage_source ?? (summary ? 'carrier_map' : scanned?.stage_source);
  if (!events.length) {
    if (!summary) throw new NoHistoryError(PROVIDER);
    // A booked label has no scans until the parcel is picked up.
    return {
      status: languageStageStatus(summary),
      current_stage: summary,
      current_stage_source: 'carrier_map',
      provider_code: category,
      last_status_text: label || null,
      last_update: null,
      expected_delivery: null,
      ...canonical,
      summary_only: true,
      events: [],
    };
  }
  const newest = events[0]!;
  const delivered = stage === 'delivered' ? events.find((event) => event.stage === 'delivered')?.time : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    ...(delivered ? { delivered_at: delivered } : {}),
    ...canonical,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
