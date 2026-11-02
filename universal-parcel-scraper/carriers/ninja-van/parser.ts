import { DateTime } from 'luxon';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { ninjaVanCountry } from '../../core/detection/ninjaVan.js';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { explicitOffsetTime, isoTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { HIDDEN_NINJA_EVENTS, ninjaVanStatus } from './status.js';

const PROVIDER = 'Ninja Van';
const MAX_SCANS = 500;
const MAX_EVENTS = 100;
// Each route's country clock, in which the page's delivery days are read.
const ZONES = { sg: 'Asia/Singapore', my: 'Asia/Kuala_Lumpur', id: 'Asia/Jakarta', ph: 'Asia/Manila', th: 'Asia/Bangkok', vn: 'Asia/Ho_Chi_Minh' } as const;
// Routes whose country keeps one clock. Indonesia spans three zones and the
// reply names no destination region, so its timeslot clocks are not read.
const SINGLE_CLOCK_ROUTES: ReadonlySet<keyof typeof ZONES> = new Set(['sg', 'my', 'ph', 'th', 'vn']);
// Order states for which the public page shows no delivery window.
const NO_WINDOW = new Set(['cancelled', 'completed', 'on hold', 'pending', 'pickup fail', 'staging']);

export function normalizeNinjaVanNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!ninjaVanCountry(number)) throw new InvalidInputError(PROVIDER, 'Ninja Van direct tracking requires a supported country-bearing parcel ID');
  return number;
}

export function parseNinjaVanNotFound(payload: unknown, number: string): never {
  const requested = normalizeNinjaVanNumber(number);
  if (isRecord(payload) && isRecord(payload.error) && payload.error.code === 150002
    && payload.error.title === 'Not Found'
    && payload.error.message === `order by tracking id ${requested} not found.`) {
    throw new NotFoundError(PROVIDER);
  }
  throw new IndeterminateError(PROVIDER, 'Ninja Van returned an inconclusive tracking error');
}

function scanClock(raw: unknown): { time?: string; provider_time_text?: string } {
  if (raw == null) return {};
  if (typeof raw !== 'string') throw new SchemaError(PROVIDER, 'Ninja Van returned an invalid scan clock');
  const label = clean(raw, 80);
  if (!label) return {};
  // All observed scan clocks carry Z. Reject impossible offsets and retain
  // malformed labels; an older valid clock must not date the current state.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-](?:(?:0\d|1[0-3]):?[0-5]\d|14:?00))$/i.test(label)) {
    const parsed = explicitOffsetTime(label);
    if (parsed) return { time: parsed.iso };
  }
  return { provider_time_text: label };
}

function day(raw: unknown): string | null {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  return DateTime.fromISO(raw, { zone: 'UTC' }).isValid ? raw : null;
}

// The page's timeslots are whole hours: "09 AM to 12 PM".
const TIMESLOT = /^(0?[1-9]|1[0-2]) ?([AP]M) to (0?[1-9]|1[0-2]) ?([AP]M)$/i;

/** A one-day window's timeslot, in the route's country, unless it ended before the newest scan. */
function timeslot(raw: unknown, day: string, zone: string, latest: CarrierEvent): { expected_delivery: string; expected_delivery_from: string } | null {
  const slot = TIMESLOT.exec(clean(raw, 80));
  if (!slot) return null;
  const clock = (hour: string, half: string) => `${String((Number(hour) % 12) + (half.toUpperCase() === 'PM' ? 12 : 0)).padStart(2, '0')}:00`;
  const from = isoTime(`${day}T${clock(slot[1]!, slot[2]!)}`, zone);
  const to = isoTime(`${day}T${clock(slot[3]!, slot[4]!)}`, zone);
  if (!from || !to || from.timestamp >= to.timestamp || (latest.time && to.timestamp < Date.parse(latest.time))) return null;
  return { expected_delivery: to.iso, expected_delivery_from: from.iso };
}

/**
 * The delivery window, as the public page shows it: days in the route's
 * country, only while the order moves towards the recipient and only with a
 * timeslot. The server moves an overdue window's start up to the day of the
 * lookup, so a start after the end is no estimate. A window that ended before
 * the newest scan's day is stale. A one-day window takes its timeslot's clocks
 * on a route whose country keeps one clock.
 */
function estimate(payload: Record<string, unknown>, latest: CarrierEvent, route: keyof typeof ZONES): Pick<CarrierResult, 'expected_delivery_from'> & { expected_delivery: string | null } {
  const zone = ZONES[route];
  const none = { expected_delivery: null };
  if (NO_WINDOW.has(clean(payload.status, 40).toLowerCase()) || !clean(payload.delivery_timeslot, 80)) return none;
  if (latest.stage === 'delivered' || latest.stage === 'returned' || latest.provider_leg === 'return') return none;
  const start = day(payload.delivery_start_date);
  const end = day(payload.delivery_end_date);
  if (!start || !end || start > end) return none;
  const after = latest.time ? DateTime.fromISO(latest.time, { setZone: true }).setZone(zone).toISODate() : null;
  if (after && end < after) return none;
  if (start === end) {
    return (SINGLE_CLOCK_ROUTES.has(route) ? timeslot(payload.delivery_timeslot, end, zone, latest) : null) ?? { expected_delivery: end };
  }
  return { expected_delivery: end, expected_delivery_from: start };
}

export function parseNinjaVan(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeNinjaVanNumber(rawNumber);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER);
  if (payload.error != null) throw new IndeterminateError(PROVIDER, 'Ninja Van returned a tracking error');
  if (payload.tracking_id !== number || typeof payload.id !== 'number' || !Number.isSafeInteger(payload.id)
    || payload.id <= 0 || !Array.isArray(payload.events) || payload.events.length > MAX_SCANS
    || typeof payload.status !== 'string' || typeof payload.granular_status !== 'string') {
    throw new SchemaError(PROVIDER, 'Ninja Van returned a different or incomplete shipment');
  }
  if (!payload.events.length) throw new IndeterminateError(PROVIDER, 'Ninja Van returned no parcel history');
  // The official client reverses this oldest-first feed and hides three
  // internal event types. That matters here: a routing row can follow a
  // completed return, but is not a new delivery transition.
  const events: CarrierEvent[] = [];
  let returning = false;
  for (const row of payload.events) {
    if (!isRecord(row) || row.order_id !== payload.id || !isRecord(row.data)
      || typeof row.type !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(row.type)) {
      throw new SchemaError(PROVIDER, 'Ninja Van returned an invalid parcel scan');
    }
    if (row.data.is_rts != null && typeof row.data.is_rts !== 'boolean') {
      throw new SchemaError(PROVIDER, 'Ninja Van returned an invalid return marker');
    }
    const clock = scanClock(row.time);
    if (row.type === 'RTS' || row.data.is_rts === true) returning = true;
    if (HIDDEN_NINJA_EVENTS.has(row.type)) continue;
    const mapped = ninjaVanStatus(row.type);
    const completedReturn = row.type === 'DELIVERY_SUCCESS' && row.data.is_rts === true;
    const ambiguousReturnDelivery = returning && row.type === 'DELIVERY_SUCCESS' && row.data.is_rts !== true;
    const stage = completedReturn ? 'returned' : ambiguousReturnDelivery ? 'exception' : mapped?.stage;
    const location = clean(row.data.hub_name, 160);
    events.push({ provider_code: row.type, description: row.type.replaceAll('_', ' ').toLowerCase(), ...clock,
      ...(location ? { location } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}), ...(returning ? { provider_leg: 'return' } : {}),
    });
  }
  events.reverse();
  if (!events.length) throw new IndeterminateError(PROVIDER, 'Ninja Van returned no visible parcel history');
  const latest = events[0]!;
  const returned = latest.stage === 'returned';
  const mapped = ninjaVanStatus(latest.provider_code ?? '');
  const currentStage = latest.stage;
  const status = returned ? 'exception' : currentStage === 'exception' ? 'exception' : mapped?.status ?? 'unknown';
  return { status, ...(currentStage ? { current_stage: currentStage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: returned ? 'Returned to sender' : latest.description,
    last_update: latest.time ?? null, ...estimate(payload, latest, ninjaVanCountry(number)!),
    ...(currentStage === 'delivered' && latest.time ? { delivered_at: latest.time } : {}),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}), events: events.slice(0, MAX_EVENTS) };
}
