import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { chazkiCurrent, chazkiRow } from './status.js';

export const PROVIDER = 'Chazki';
// The search lists a few short entries; an order's history is a few rows.
export const SEARCH_MAX_BYTES = 64_000;
export const ORDER_MAX_BYTES = 256_000;
// Senders choose their own trackcodes: digit runs, or letters then digits.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,40}$/;
// `09/03/2026 2:58 pm`: day, month, year and a twelve-hour clock to the minute.
const CLOCK = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{1,2}):(\d{2}) ([ap]m)$/i;
const MAX_ENTRIES = 50;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
// GraphQL's answer for a query the service no longer accepts as written.
const CHANGED_QUERY = new Set(['GRAPHQL_VALIDATION_FAILED', 'GRAPHQL_PARSE_FAILED', 'BAD_USER_INPUT']);

/** A trackcode for Chazki's tracker, in capitals as the package normalizes it; anything else is not one it issues. */
export function normalizeChazkiNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Chazki trackcodes are six to forty letters and digits');
  return number;
}

/** The field a GraphQL reply answers with, after its errors. */
function answer(payload: unknown, field: string): unknown {
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Chazki returned an invalid reply');
  const errors = payload.errors;
  if (errors !== undefined && errors !== null) {
    if (!Array.isArray(errors)) throw new SchemaError(PROVIDER, 'Chazki returned invalid errors');
    const codes = errors.map((error) => isRecord(error) && isRecord(error.extensions) ? error.extensions.code : undefined);
    if (codes.some((code) => typeof code === 'string' && CHANGED_QUERY.has(code))) {
      throw new SchemaError(PROVIDER, 'Chazki no longer accepts the tracking page’s query');
    }
    // The service's own failure, such as a resolver error, says nothing about the order.
    if (errors.length) throw new IndeterminateError(PROVIDER, 'Chazki did not complete the lookup');
  }
  if (!isRecord(payload.data) || !Object.hasOwn(payload.data, field)) throw new SchemaError(PROVIDER, 'Chazki returned a reply without its answer');
  return payload.data[field];
}

/** The order's id: a positive integer, as the service sends it. */
function orderId(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** The trackcode an entry or order names, in capitals. */
function trackCode(value: unknown): string {
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, 'Chazki returned an order without its trackcode');
  return clean(value, 64).toUpperCase();
}

/**
 * The tracking page's search, `getOrderPublicTrackCode`: the orders whose
 * trackcode is the one typed, one per sender that used it. An empty list is
 * the page's "No se encontró información sobre la orden". When several
 * senders used the code, the page asks the visitor to choose theirs, which
 * a lookup cannot do. Only an entry naming the whole code counts.
 */
export function readChazkiSearch(payload: unknown, raw: string): number {
  const number = normalizeChazkiNumber(raw);
  const entries = answer(payload, 'OrderPublicTrackCode');
  if (!Array.isArray(entries) || entries.length > MAX_ENTRIES) throw new SchemaError(PROVIDER, 'Chazki returned an invalid search');
  if (!entries.length) throw new NotFoundError(PROVIDER);
  const ids = new Set<number>();
  for (const entry of entries as unknown[]) {
    if (!isRecord(entry)) throw new SchemaError(PROVIDER, 'Chazki returned an invalid search entry');
    const id = orderId(entry.id);
    if (id === null) throw new SchemaError(PROVIDER, 'Chazki returned a search entry without its order');
    if (trackCode(entry.trackCode) === number) ids.add(id);
  }
  if (!ids.size) throw new IndeterminateError(PROVIDER, 'Chazki matched the trackcode to other orders');
  if (ids.size > 1) throw new IndeterminateError(PROVIDER, 'Chazki lists orders from several senders under the trackcode', { reason: 'several_parcels' });
  return [...ids][0]!;
}

/** A clock as the reply writes it, as a wall clock with no offset: the reply names no zone. */
export function chazkiClock(value: unknown): string {
  const match = typeof value === 'string' ? CLOCK.exec(value.trim()) : null;
  if (!match) throw new SchemaError(PROVIDER, 'Chazki returned an invalid history clock');
  const [, day, month, year, hour, minute, half] = match;
  const twelve = Number(hour);
  if (twelve < 1 || twelve > 12) throw new SchemaError(PROVIDER, 'Chazki returned an invalid history clock');
  const hours = (twelve % 12) + (half!.toLowerCase() === 'pm' ? 12 : 0);
  const local = `${year}-${month}-${day}T${String(hours).padStart(2, '0')}:${minute}:00`;
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) throw new SchemaError(PROVIDER, 'Chazki returned an invalid history clock');
  return local;
}

/** An optional name the reply nests in an object, such as the service's. */
function nestedName(order: Record<string, unknown>, key: string, field: string): string {
  const value = order[key];
  if (value === null || value === undefined) return '';
  if (!isRecord(value)) throw new SchemaError(PROVIDER, `Chazki returned an invalid ${key}`);
  const name = value[field];
  if (name === null || name === undefined) return '';
  if (typeof name !== 'string') throw new SchemaError(PROVIDER, `Chazki returned an invalid ${key}`);
  return clean(name, 80);
}

interface Row {
  readonly event: CarrierEvent & { local_time: string; description: string; provider_code: string };
  readonly step: number;
  readonly index: number;
}

// The rail's step for each named row, which orders rows written in the same minute.
const STEPS: ReadonlyMap<number, number> = new Map([
  [154, 1], [155, 2], [159, 2], [199, 2], [156, 3], [157, 3], [161, 4], [162, 4], [166, 5], [168, 5], [169, 5], [170, 5], [198, 5],
]);

/**
 * The order the page opens, `getOrderPublic`, with only the fields the
 * adapter reads: its id and trackcode, which must be the ones asked, the
 * service's name, the current status and the history of status ids and
 * clocks. The reply's rows come in no order. The page names only some of
 * them, and the rest are left out as it leaves them out. The current status
 * decides the stage, as the page's rail shows it.
 */
export function parseChazkiOrder(payload: unknown, raw: string, id: number): CarrierResult {
  const number = normalizeChazkiNumber(raw);
  const order = answer(payload, 'OrderPublic');
  if (order === null) throw new IndeterminateError(PROVIDER, 'Chazki did not open the order its search found');
  if (!isRecord(order)) throw new SchemaError(PROVIDER, 'Chazki returned an invalid order');
  if (orderId(order.id) !== id || trackCode(order.trackCode) !== number) throw new IndeterminateError(PROVIDER, 'Chazki answered for another order');
  if (!isRecord(order.Status) || typeof order.Status.subclass !== 'string' || !clean(order.Status.subclass)) {
    throw new SchemaError(PROVIDER, 'Chazki returned an order without its status');
  }
  const status = clean(order.Status.subclass, 40).toUpperCase();
  const history = order.OrderServiceHistorialPublic ?? [];
  if (!Array.isArray(history) || history.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Chazki returned an invalid history');

  const rows: Row[] = [];
  const named = new Set<number>();
  (history as unknown[]).forEach((value, index) => {
    if (!isRecord(value)) throw new SchemaError(PROVIDER, 'Chazki returned an invalid history row');
    const statusId = value.statusID;
    if (typeof statusId !== 'number' || !Number.isSafeInteger(statusId) || statusId < 0) {
      throw new SchemaError(PROVIDER, 'Chazki returned a history row without its status');
    }
    const local = chazkiClock(value.createdAt);
    const row = chazkiRow(statusId);
    if (!row) return;
    named.add(statusId);
    rows.push({ event: { local_time: local, description: row.wording, provider_code: String(statusId),
      ...(row.stage ? { stage: row.stage, stage_source: 'carrier_map' } : {}) }, step: STEPS.get(statusId) ?? 0, index });
  });
  const seen = new Set<string>();
  const events = rows
    // The page shows the trip to the sender's 157 only when there is no 156.
    .filter((row) => row.event.provider_code !== '157' || !named.has(156))
    .filter((row) => {
      const key = `${row.event.local_time}|${row.event.provider_code}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    // Newest first; rows of one minute follow the rail's steps.
    .sort((left, right) => right.event.local_time.localeCompare(left.event.local_time) || right.step - left.step || right.index - left.index)
    .map((row) => row.event);

  const current = chazkiCurrent(status);
  const newest = events[0];
  const stage = (current?.stage ?? events.find((event) => event.stage)?.stage) as Stage | undefined;
  const service = nestedName(order, 'Service', 'name');
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: current?.wording ?? newest?.description ?? status,
    ...(events.length ? {} : { provider_code: status, summary_only: true }),
    last_update: null,
    ...(newest ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    ...(service ? { service_name: service } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
