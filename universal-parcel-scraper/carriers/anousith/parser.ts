import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { itemState, MILESTONES, scanState } from './status.js';

export const PROVIDER = 'Anousith';
// A delivered bill's two replies come to about two kilobytes.
export const ANOUSITH_MAX_BYTES = 512 * 1024;
// Thirteen digits on every bill; the tracking page searches nothing shorter.
const NUMBER = /^\d{13}$/;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
// GraphQL's own refusals of a query: the schema changed under the adapter's fields.
const QUERY_REFUSED = new Set(['GRAPHQL_PARSE_FAILED', 'GRAPHQL_VALIDATION_FAILED', 'BAD_USER_INPUT']);

/** An Anousith bill number; anything else is not one Anousith issues. */
export function normalizeAnousithNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Anousith bills are thirteen digits');
  return number;
}

/** The list a query answered, after GraphQL's errors. */
function answered(payload: unknown, field: 'itemsV2' | 'scanItems'): Record<string, unknown> {
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Anousith returned an invalid envelope');
  if (payload.errors !== undefined && payload.errors !== null) {
    const errors = Array.isArray(payload.errors) ? payload.errors : [];
    const codes = errors.map((error) => (isRecord(error) && isRecord(error.extensions) ? clean(error.extensions.code, 64) : ''));
    if (codes.some((code) => QUERY_REFUSED.has(code))) throw new SchemaError(PROVIDER, 'Anousith refused the tracking query');
    throw new IndeterminateError(PROVIDER, 'Anousith did not complete the lookup');
  }
  const list = isRecord(payload.data) ? payload.data[field] : undefined;
  if (!isRecord(list)) throw new SchemaError(PROVIDER, 'Anousith returned a reply without its list');
  return list;
}

function rows(list: Record<string, unknown>): unknown[] {
  if (!Array.isArray(list.data)) throw new SchemaError(PROVIDER, 'Anousith returned a list without rows');
  if (list.data.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Anousith returned an oversized list');
  return list.data;
}

/** A row's bill, which must be the one asked. */
function bind(row: Record<string, unknown>, number: string): void {
  const id = cleanScalar(row.trackingId, 64);
  if (!id) throw new SchemaError(PROVIDER, 'Anousith returned a row without its bill');
  if (id !== number) throw new IndeterminateError(PROVIDER, 'Anousith answered for another shipment');
}

/**
 * The bill in the reply of the `ItemsV2` query for one `trackingId`. An empty
 * list is Anousith's answer for a bill it does not know.
 */
export function anousithItem(payload: unknown, raw: string): Record<string, unknown> {
  const number = normalizeAnousithNumber(raw);
  const list = answered(payload, 'itemsV2');
  const items = rows(list);
  if (typeof list.total !== 'number' || !Number.isSafeInteger(list.total) || list.total < 0) {
    throw new SchemaError(PROVIDER, 'Anousith returned a list without its count');
  }
  if (list.total === 0 && items.length === 0) throw new NotFoundError(PROVIDER);
  if (items.length === 0) throw new SchemaError(PROVIDER, 'Anousith counted a bill it did not return');
  for (const item of items) {
    if (!isRecord(item)) throw new SchemaError(PROVIDER, 'Anousith returned an invalid bill');
    bind(item, number);
  }
  if (items.length > 1 || list.total > 1) throw new IndeterminateError(PROVIDER, 'Anousith holds more than one parcel under this bill');
  return items[0] as Record<string, unknown>;
}

/** The scans in the reply of the `ScanItems` query for one `trackingId`. */
export function anousithScans(payload: unknown, raw: string): Record<string, unknown>[] {
  const number = normalizeAnousithNumber(raw);
  return rows(answered(payload, 'scanItems')).map((row) => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Anousith returned an invalid scan');
    bind(row, number);
    return row;
  });
}

/** An instant the reply gives in UTC, or null where it has none. */
function instant(row: Record<string, unknown>, key: string): { iso: string; timestamp: number } | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'string' ? explicitOffsetTime(value) : null;
  if (!parsed) throw new SchemaError(PROVIDER, `Anousith returned an invalid ${key}`);
  return parsed;
}

/** A name inside a nested record such as `{ branch_name }`, which may be null. */
function named(row: Record<string, unknown>, key: string, field: string): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (!isRecord(value)) throw new SchemaError(PROVIDER, `Anousith returned an invalid ${key}`);
  const name = value[field];
  if (name !== null && name !== undefined && typeof name !== 'string') throw new SchemaError(PROVIDER, `Anousith returned an invalid ${key}`);
  return clean(name, 120);
}

function backward(row: Record<string, unknown>, key: string): boolean {
  const value = row[key];
  if (value === null || value === undefined || value === 0 || value === false) return false;
  if (value === 1 || value === true) return true;
  throw new SchemaError(PROVIDER, `Anousith returned an invalid ${key}`);
}

interface Entry { event: CarrierEvent; timestamp: number; order: number }

const joined = (...parts: string[]) => parts.filter(Boolean).join(', ');

/**
 * A bill from `anousithItem` and its scans from `anousithScans`, newest
 * first. Times are instants in UTC. The names and phone numbers of the
 * sender and the recipient, charges and cash on delivery are never asked for.
 */
export function parseAnousith(item: Record<string, unknown>, scans: readonly Record<string, unknown>[], raw: string): CarrierResult {
  const number = normalizeAnousithNumber(raw);
  bind(item, number);
  const code = clean(item.itemStatus, 64);
  if (!code) throw new SchemaError(PROVIDER, 'Anousith returned a bill without its status');
  const returned = backward(item, 'isBackward');
  const origin = named(item, 'originBranchId', 'branch_name');
  const destination = named(item, 'destBranchId', 'branch_name');
  const originProvince = named(item, 'originProvinceId', 'provinceName');
  const destinationProvince = named(item, 'destProvinceId', 'provinceName');
  const originPlace = joined(origin, originProvince);
  const destinationPlace = joined(destination, destinationProvince);

  const entries: Entry[] = [];
  const milestone = (key: keyof typeof MILESTONES, location: string, label: string = MILESTONES[key].label,
    stage: Stage = MILESTONES[key].stage) => {
    const time = instant(item, key);
    if (!time) return;
    entries.push({ timestamp: time.timestamp, order: entries.length, event: {
      time: time.iso, ...(location ? { location } : {}), description: label, stage, stage_source: 'carrier_map',
      ...(stage === 'returned' ? { provider_leg: 'return' } : {}),
    } });
  };
  milestone('createdDate', '');
  milestone('originReceiveDate', originPlace);
  milestone('originSendDate', originPlace);
  milestone('destReceiveDate', destinationPlace);
  milestone('destSendDate', destinationPlace);
  milestone('receiveBackwardDate', originPlace);
  if (code === 'COMPLETED') {
    const done = itemState(code, returned)!;
    milestone('sendCompleteDate', '', returned ? done.label : undefined, done.stage);
  }
  const milestones = entries.length;

  // The reply lists scans newest first; the oldest gets the lowest order.
  scans.forEach((row, index) => {
    const time = instant(row, 'createdAt');
    const scanCode = clean(row.scanStatus, 64);
    if (!time || !scanCode) throw new SchemaError(PROVIDER, 'Anousith returned a scan without its time or status');
    const leg = clean(row.transportStatus, 32);
    if (leg !== 'FORWARD' && leg !== 'BACKWARD') throw new SchemaError(PROVIDER, 'Anousith returned a scan without its direction');
    const branch = named(row, 'branch', 'branch_name');
    const location = branch === origin && branch ? originPlace : branch === destination && branch ? destinationPlace
      : branch || named(row, 'center', 'centerName');
    // The bill's own date for the same moment keeps the page's wording; it takes the scan's place when it has none.
    const same = entries.slice(0, milestones).find((entry) => entry.timestamp === time.timestamp
      && (!entry.event.location || entry.event.location === location));
    if (same) {
      if (!same.event.location && location) same.event.location = location;
      return;
    }
    const scan = scanState(scanCode, leg === 'BACKWARD');
    entries.push({ timestamp: time.timestamp, order: MAX_ROWS + scans.length - index, event: {
      time: time.iso, ...(location ? { location } : {}), description: scan?.label ?? scanCode, provider_code: scanCode,
      ...(scan ? { stage: scan.stage, stage_source: 'carrier_map' } : {}),
      ...(leg === 'BACKWARD' ? { provider_leg: 'return' } : {}),
    } });
  });
  if (!entries.length) throw new NoHistoryError(PROVIDER);

  const events = entries.sort((a, b) => b.timestamp - a.timestamp || b.order - a.order).map((entry) => entry.event);
  const newest = events[0]!;
  const state = itemState(code, returned);
  const staged = events.find((event) => event.stage);
  const stage = (state?.stage ?? staged?.stage) as Stage | undefined;
  const delivered = stage === 'delivered' ? instant(item, 'sendCompleteDate') : null;
  const weight = typeof item.weight === 'number' && Number.isFinite(item.weight) && item.weight > 0 ? item.weight : null;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: state?.label ?? newest.description!,
    provider_code: code,
    last_update: newest.time!,
    expected_delivery: null,
    ...(delivered ? { delivered_at: delivered.iso } : {}),
    ...(weight !== null ? { weight_kg: weight } : {}),
    ...(stage === 'ready_for_pickup' && destination ? { pickup_point: [destination, destinationProvince].filter(Boolean).join('\n') } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
