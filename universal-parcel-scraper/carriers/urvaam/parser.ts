import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { urvaamStage } from './status.js';

export const PROVIDER = 'Urvaam';
// A long history is a few kilobytes.
export const URVAAM_MAX_BYTES = 256 * 1024;
// Sixteen digits. The numbers rise over time and all start with 2.
const NUMBER = /^2\d{15}$/;
const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
const CODE = /^\d{1,4}$/;
// The service's answer when the route asks for a signed-in session.
const SIGN_IN = 1000;
// A platform or delivery depot's receipt names the depot in brackets.
const DEPOT_RECEIPT = /^((?:segundo\s+)?recibido\s+plataforma)\s*[(（]\s*([^()（）]+?)\s*[)）]$/i;
const MAX_SHIPMENTS = 50;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A number for Urvaam's tracker; anything else is not one it issues. */
export function normalizeUrvaamNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Urvaam numbers are sixteen digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Urvaam returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** An optional code, a string or a whole number; anything else is a changed reply. */
function code(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  const read = typeof value === 'number' && !Number.isInteger(value) ? '' : cleanScalar(value, 8);
  if (!CODE.test(read)) throw new SchemaError(PROVIDER, `Urvaam returned an invalid ${key}`);
  return read;
}

/**
 * A scan's clock. `update_time` is a wall clock to the second with no zone;
 * the page shows it as it comes, so it stays local.
 */
function scanClock(row: Record<string, unknown>): string {
  const match = WALL_CLOCK.exec(text(row, 'update_time', 32));
  const local = match ? `${match[1]}T${match[2]}` : '';
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!match || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'Urvaam returned an invalid scan time');
  }
  return local;
}

/** The pickup point the page shows under a scan: its name, street and town. Opening hours are not kept. */
function pickupPoint(row: Record<string, unknown>): { name: string; town: string; lines: string } | undefined {
  const point = row.network_info;
  if (!isRecord(point)) return undefined;
  const name = clean(point.name, 120);
  if (!name) return undefined;
  const town = clean(point.city, 80);
  return { name, town, lines: [name, clean(point.address, 200), town].filter(Boolean).join('\n') };
}

function projectRow(row: Record<string, unknown>): { key: string; event: CarrierEvent; pickup?: string } {
  const caption = text(row, 'caption_es') || text(row, 'caption_en');
  if (!caption) throw new SchemaError(PROVIDER, 'Urvaam returned a scan without wording');
  const depot = DEPOT_RECEIPT.exec(caption);
  const point = pickupPoint(row);
  const description = depot ? depot[1]! : caption;
  const location = depot ? depot[2]! : point?.town ?? '';
  const local = scanClock(row);
  const provider = code(row, 'status');
  const staged = urvaamStage(provider, code(row, 'track_status'), caption);
  const event: CarrierEvent = {
    local_time: local,
    ...(location ? { location } : {}),
    description,
    ...(provider ? { provider_code: provider } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([local, provider, description, location]), event, ...(point ? { pickup: point.lines } : {}) };
}

/** The shipment under the number asked; another number is someone else's parcel. */
function shipmentFor(rows: unknown[], number: string): Record<string, unknown> {
  const matches = rows.filter((row) => {
    if (!isRecord(row) || typeof row.line_no !== 'string') throw new SchemaError(PROVIDER, 'Urvaam returned a shipment without its number');
    return clean(row.line_no, 64).toUpperCase() === number;
  }) as Record<string, unknown>[];
  if (!matches.length) throw new IndeterminateError(PROVIDER, 'Urvaam answered for another shipment');
  if (matches.length > 1) throw new IndeterminateError(PROVIDER, 'Urvaam answered with several shipments under the number');
  return matches[0]!;
}

/**
 * The reply of `track/batch` for one number, the lookup the tracking page
 * makes. It answers `{"meta":{"code":0},"response":{"data":[]}}` for a number it
 * does not know, which the page reports as having no tracking. A shipment must
 * name the number asked; the customer reference beside it is the sender's.
 */
export function parseUrvaam(payload: unknown, raw: string): CarrierResult {
  const number = normalizeUrvaamNumber(raw);
  if (!isRecord(payload) || !isRecord(payload.meta)) throw new SchemaError(PROVIDER, 'Urvaam returned an invalid envelope');
  const status = payload.meta.code;
  if (status === SIGN_IN) throw new TransportError(PROVIDER, 'Urvaam asked for a signed-in session');
  if (status !== 0) throw new IndeterminateError(PROVIDER, 'Urvaam did not complete the lookup');
  const rows = isRecord(payload.response) ? payload.response.data : undefined;
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Urvaam returned an invalid shipment list');
  if (!rows.length) throw new NotFoundError(PROVIDER);
  if (rows.length > MAX_SHIPMENTS) throw new SchemaError(PROVIDER, 'Urvaam returned an oversized shipment list');
  const shipment = shipmentFor(rows, number);
  const scans = shipment.data ?? [];
  if (!Array.isArray(scans)) throw new SchemaError(PROVIDER, 'Urvaam returned a shipment with invalid scans');
  if (scans.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Urvaam returned an oversized history');

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  let pickup: string | undefined;
  for (const row of scans) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Urvaam returned an invalid scan');
    const scan = projectRow(row);
    pickup ??= scan.pickup;
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    events.push(scan.event);
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the page lists them.
  if (listsNewestFirst(events) === false) events.reverse();
  const newestFirst = events.sort((left, right) => String(right.local_time).localeCompare(String(left.local_time)));

  const newest = newestFirst[0]!;
  const scanned = newestFirst.find((event) => event.stage);
  const stage = scanned?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: scanned!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    ...(pickup ? { pickup_point: pickup } : {}),
    events: newestFirst.slice(0, MAX_EVENTS),
    ...(newestFirst.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
