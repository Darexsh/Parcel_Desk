import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { mislabeledLocalTime } from '../../core/time/index.js';
import { isRecord } from '../../core/types.js';
import { quickRabbitStage, quickRabbitWording } from './status.js';

export const PROVIDER = 'Quick Rabbit';
export const CARRIER = 'quick-rabbit';
// A long history is under four kilobytes.
export const QUICK_RABBIT_MAX_BYTES = 256 * 1024;
// The tracker finds a parcel by its tracking code, letters and digits.
const CODE = /^[A-Z0-9]{6,40}$/;
// A status or category name, as the tracker's enumerations write them.
const NAME = /^[A-Z][A-Z0-9_]{1,80}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
// The tracking page shows a status's digits as they come, read in UTC, so their "Z" is a label on
// the wall clock it shows: they are read on Madrid's clock, the one the carrier works on.
const ZONE = 'Europe/Madrid';
const MAX_EVENTS = 300;

/** A tracking code as the tracker matches it; anything else is not one Quick Rabbit gives. */
export function normalizeQuickRabbitCode(raw: string): string {
  const code = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!CODE.test(code)) throw new InvalidInputError(PROVIDER, 'Quick Rabbit looks parcels up by 6 to 40 letters and digits');
  return code;
}

/** A code as identities are compared, as the user's input is: without spaces or dashes. */
const identity = (value: string) => normalizeTrackingNumber(value).toUpperCase();

/** Whether a 404 reply is the tracker's answer for a code it does not know. */
export function isUnknownCode(payload: unknown): boolean {
  return isRecord(payload) && payload.message === 'Package not found' && payload.statusCode === 404;
}

function name(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !NAME.test(value)) throw new SchemaError(PROVIDER, `Quick Rabbit returned an invalid ${field}`);
  return value;
}

interface Scan { at: number; index: number; event: CarrierEvent }

function scan(row: unknown, index: number): Scan {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Quick Rabbit returned an invalid status');
  const code = name(row.status, 'status');
  if (!code) throw new SchemaError(PROVIDER, 'Quick Rabbit returned a status without its name');
  const category = name(row.status_category, 'status category');
  const at = typeof row.date === 'string' && INSTANT.test(row.date) ? Date.parse(row.date) : Number.NaN;
  const time = Number.isFinite(at) ? mislabeledLocalTime(row.date, ZONE)?.iso : undefined;
  if (!time) throw new SchemaError(PROVIDER, 'Quick Rabbit returned an invalid status time');
  const staged = quickRabbitStage(code, category);
  // The courier's position beside a status can be the recipient's door, so it is not kept.
  const event: CarrierEvent = {
    time,
    description: quickRabbitWording(code),
    provider_code: code,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { at, index, event };
}

/**
 * The tracker's reply for one tracking code: the parcel's code, the shipper's
 * reference, its current status, and its timeline of statuses, each an
 * enumeration name with its category and a wall clock. A code it does not know
 * gets HTTP 404 with "Package not found", which the adapter reads before this.
 */
export function parseQuickRabbit(payload: unknown, raw: string): CarrierResult {
  const code = normalizeQuickRabbitCode(raw);
  if (isUnknownCode(payload)) throw new NotFoundError(PROVIDER);
  if (!isRecord(payload) || typeof payload.tracking_code !== 'string') throw new SchemaError(PROVIDER, 'Quick Rabbit returned an invalid tracking reply');
  const reference = typeof payload.reference_number === 'string' ? payload.reference_number : '';
  if (![payload.tracking_code, reference].some((value) => value && identity(value) === identity(code))) {
    throw new IndeterminateError(PROVIDER, 'Quick Rabbit answered for another parcel');
  }
  const rows = payload.timeline;
  if (!Array.isArray(rows) || rows.length > MAX_EVENTS) throw new SchemaError(PROVIDER, 'Quick Rabbit returned an invalid timeline');
  if (!rows.length) throw new NoHistoryError(PROVIDER);

  // Newest first; statuses on one instant keep the reply's order reversed, since it lists the oldest first.
  const seen = new Set<string>();
  const events = rows.map((row, index) => scan(row, index))
    .sort((a, b) => b.at - a.at || b.index - a.index)
    .map(({ event }) => event)
    .filter((event) => {
      const key = `${event.time} ${event.provider_code}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: null,
    ...(stage === 'delivered' ? { delivered_at: current!.time! } : {}),
    ...(identity(payload.tracking_code) !== identity(code) && CODE.test(payload.tracking_code)
      ? { canonical_tracking_number: payload.tracking_code } : {}),
    events,
  };
}
