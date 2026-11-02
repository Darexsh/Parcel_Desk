import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { closerLabel, closerStage } from './status.js';

export const PROVIDER = 'Closer Logistics';
// A shipment with a long history is a few kilobytes.
export const CLOSER_MAX_BYTES = 256 * 1024;
// Customers' reports give twelve digits.
const NUMBER = /^\d{12}$/;
const CODE = /^[a-z][a-z_]{0,39}$/;
const CLOCK = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/;
const FAILED = new Set(['failed_delivery_attempt', 'failed_pickup_attempt']);
const MAX_PACKAGES = 50;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A Closer Logistics shipment number; anything else is not one Closer issues. */
export function normalizeCloserNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Closer Logistics shipment numbers are twelve digits');
  return number;
}

/** The lookup's answer for a number it does not know, which the page reports as a missing parcel. */
export function isCloserNotFound(payload: unknown): boolean {
  return isRecord(payload) && Object.keys(payload).length === 2 && payload.code === 404 && payload.message === 'Not Found';
}

/** The shipment's number as a whole: a string, or an exact nonnegative integer. */
function identifier(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value !== 'string' || !value.trim()) throw new SchemaError(PROVIDER, 'Closer Logistics returned a shipment without its number');
  return normalizeTrackingNumber(value);
}

/** An optional record; anything but an object is a changed reply. */
function part(row: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (!isRecord(value)) throw new SchemaError(PROVIDER, `Closer Logistics returned an invalid ${key}`);
  return value;
}

/** A status code; anything but a short lower-case word is a changed reply. */
function code(row: Record<string, unknown>): string {
  const value = row.status;
  if (typeof value !== 'string' || !CODE.test(value)) throw new SchemaError(PROVIDER, 'Closer Logistics returned an invalid status');
  return value;
}

/**
 * A clock as the reply writes it, `DD/MM/YYYY HH:mm:ss`. The page shows it as
 * it comes and names no zone, so it stays a wall clock.
 */
function wallClock(value: unknown): string {
  const match = typeof value === 'string' ? CLOCK.exec(value) : null;
  const local = match ? `${match[3]}-${match[2]}-${match[1]}T${match[4]}:${match[5]}:${match[6]}` : '';
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!match || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'Closer Logistics returned an invalid status time');
  }
  return local;
}

function event(status: string, local: string, pickup: boolean, reason = ''): CarrierEvent {
  const label = closerLabel(status) ?? status;
  const stage = closerStage(status, pickup);
  return {
    local_time: local,
    description: reason ? `${label}: ${reason}` : label,
    provider_code: status,
    ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
  };
}

/** The reason the page gives under a failed attempt: the shipment's latest incidence, dated like the attempt it explains. */
function incidence(shipment: Record<string, unknown>): { local: string; reason: string } | undefined {
  const latest = part(shipment, 'lastIncidence');
  const reason = latest ? part(latest, 'reason') : undefined;
  const name = reason ? clean(reason.name, 120) : '';
  return latest && name ? { local: wallClock(latest.createdAt), reason: name } : undefined;
}

/**
 * Every package's statuses, newest first. The page dates its steps from the
 * first package alone; a shipment of several keeps each package's statuses,
 * and the same status at the same clock once.
 */
function history(shipment: Record<string, unknown>, pickup: boolean): CarrierEvent[] {
  const packages = shipment.packages ?? [];
  if (!Array.isArray(packages)) throw new SchemaError(PROVIDER, 'Closer Logistics returned invalid packages');
  if (packages.length > MAX_PACKAGES) throw new SchemaError(PROVIDER, 'Closer Logistics returned too many packages');
  const failure = incidence(shipment);
  const seen = new Set<string>();
  const rows: { event: CarrierEvent; id: number }[] = [];
  let count = 0;
  for (const item of packages) {
    if (!isRecord(item)) throw new SchemaError(PROVIDER, 'Closer Logistics returned an invalid package');
    const trackings = item.trackings ?? [];
    if (!Array.isArray(trackings)) throw new SchemaError(PROVIDER, 'Closer Logistics returned a package with invalid statuses');
    count += trackings.length;
    if (count > MAX_ROWS) throw new SchemaError(PROVIDER, 'Closer Logistics returned an oversized history');
    for (const row of trackings) {
      if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Closer Logistics returned an invalid status row');
      const status = code(row);
      const local = wallClock(row.createdAt);
      const key = JSON.stringify([local, status]);
      if (seen.has(key)) continue;
      seen.add(key);
      const reason = failure && FAILED.has(status) && failure.local === local ? failure.reason : '';
      rows.push({ event: event(status, local, pickup, reason), id: Number.isSafeInteger(row.id) ? row.id as number : -1 });
    }
  }
  // The page's first step, the order received or the return to collect, is
  // dated with the shipment's creation until a status of its own dates it.
  const first = pickup ? 'ready_for_pickup' : 'documented';
  if (!rows.some(({ event: { provider_code } }) => provider_code === first)) {
    rows.push({ event: event(first, wallClock(shipment.createdAt), pickup), id: -1 });
  }
  // Newest first; statuses at the same clock follow the order they were added in.
  return rows.sort((a, b) => (b.event.local_time as string).localeCompare(a.event.local_time as string) || b.id - a.id)
    .map(({ event: item }) => item);
}

/**
 * The reply of the tracking page's lookup, `GET /tracking/shipments/{number}`
 * on admin.closerlogistics.com: the shipment, its shop, its recipient and
 * each package's statuses. Only the statuses, the shipment's own status and
 * the shop are kept, and a shipment must name the number asked.
 */
export function parseCloser(payload: unknown, raw: string): CarrierResult {
  const number = normalizeCloserNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Closer Logistics returned a reply that is not a shipment');
  if (identifier(payload.trackingNumber) !== number) throw new IndeterminateError(PROVIDER, 'Closer Logistics answered for another shipment');
  if (payload.type !== undefined && payload.type !== null && typeof payload.type !== 'string') {
    throw new SchemaError(PROVIDER, 'Closer Logistics returned an invalid shipment type');
  }
  // A pickup collects a return from the customer for the shop.
  const pickup = payload.type === 'pickup';
  const events = history(payload, pickup);
  const summary = payload.status === undefined || payload.status === null ? undefined : code(payload);
  const summaryStage = summary ? closerStage(summary, pickup) : undefined;
  const scanned = events.find((item) => item.stage);
  const stage = (summaryStage ?? scanned?.stage) as Stage | undefined;
  const source = summaryStage ? 'carrier_map' : scanned?.stage_source;
  const newest = events[0]!;
  const shop = part(payload, 'distributor');
  // The page names the shop as the sender of a delivery and the recipient of a pickup.
  const sender = shop && !pickup ? clean(shop.name, 80) : '';
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    ...(sender ? { sender_name: sender } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
