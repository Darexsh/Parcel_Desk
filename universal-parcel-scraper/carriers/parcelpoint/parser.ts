import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { parcelpointStage } from './status.js';

export const PROVIDER = 'ParcelPoint';
// A parcel's reply is about a kilobyte.
export const PARCELPOINT_MAX_BYTES = 128 * 1024;
// The tracker finds a parcel by its PARCELPOINT booking code or by the number of the carrier
// that brought it or collects it, so it takes any run of letters and digits with a digit.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,40}$/;
// The numbers a reply gives the parcel, as the page labels them: Consignment ID, Booking Code, Reference.
const IDENTITIES = ['consignmentId', 'bookingCode', 'reference'] as const;
// A row's clock to the minute, in UTC.
const CLOCK = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A number for ParcelPoint's tracker, in capitals as the page sends it; anything else is not one it tracks. */
export function normalizeParcelpointNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'ParcelPoint tracks booking codes and carrier numbers of six to forty letters and digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `ParcelPoint returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A code as the page shows it when a row has no wording: CHECKED_IN as "Checked In". */
function humanise(code: string): string {
  return code.toLowerCase().split('_').filter(Boolean).map((word) => word[0]!.toUpperCase() + word.slice(1)).join(' ');
}

/**
 * A row's `date`, "2026-05-01 06:53". The page reads it as UTC, and the scans the delivering
 * carrier logs for the same handovers agree.
 */
function instant(raw: string): string {
  const parsed = DateTime.fromFormat(raw, 'yyyy-MM-dd HH:mm', { zone: 'UTC' });
  // Luxon rolls 24:00 over, so only a clock that reads back unchanged is kept.
  const time = CLOCK.test(raw) && parsed.isValid && parsed.toFormat('yyyy-MM-dd HH:mm') === raw
    ? parsed.toISO({ suppressMilliseconds: true }) : null;
  if (!time) throw new SchemaError(PROVIDER, 'ParcelPoint returned an invalid scan time');
  return time;
}

/** A row as an event, or nothing for an undated step, which the page's proxy leaves out. */
function projectRow(row: unknown): CarrierEvent | null {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'ParcelPoint returned an invalid scan');
  const code = text(row, 'status', 64);
  const date = text(row, 'date', 32);
  const description = text(row, 'description') || humanise(code);
  if (!description) throw new SchemaError(PROVIDER, 'ParcelPoint returned a scan without a status');
  const location = text(row, 'location', 120);
  if (!date) return null;
  const staged = parcelpointStage(code, description);
  return {
    time: instant(date),
    ...(location ? { location } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/** Rows newest first, as the page lists them, with a repeated row once. */
function eventsOf(rows: readonly unknown[]): CarrierEvent[] {
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    const event = projectRow(row);
    if (!event) continue;
    const key = JSON.stringify([event.time, event.provider_code, event.description, event.location]);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(event);
  }
  // Every clock is an instant in one format, so the text sorts them; sort keeps ties in reply order.
  if (listsNewestFirst(events) === false) events.reverse();
  return events.sort((a, b) => (a.time === b.time ? 0 : a.time! < b.time! ? 1 : -1));
}

/**
 * The point a parcel waits at, or was collected from: the place of the scan that made it ready
 * for collection, when that is the parcel's last movement or the one before its collection.
 */
function pickupPoint(events: readonly CarrierEvent[], stage: Stage | undefined): string | undefined {
  if (stage !== 'ready_for_pickup' && stage !== 'delivered') return undefined;
  const staged = events.filter((event) => event.stage);
  const at = stage === 'delivered' ? staged.findIndex((event) => event.stage === 'delivered') + 1 : 0;
  const ready = staged[at];
  return ready?.stage === 'ready_for_pickup' ? ready.location : undefined;
}

/**
 * The reply of the tracker's `wp-json/parcelpoint/v1/track?trackingId={number}`: the number
 * asked, the parcel's current status, its numbers and its events. A number the network does not
 * hold keeps the number and leaves the rest empty. The reply must name the parcel by the whole
 * number asked, as its consignment id, its booking code or its reference.
 */
export function parseParcelpoint(payload: unknown, raw: string): CarrierResult {
  const asked = normalizeParcelpointNumber(raw);
  if (!isRecord(payload) || typeof payload.trackingId !== 'string') throw new SchemaError(PROVIDER, 'ParcelPoint returned an invalid reply');
  if (normalizeTrackingNumber(text(payload, 'trackingId', 64)) !== asked) throw new IndeterminateError(PROVIDER, 'ParcelPoint answered for another number');
  const rows = payload.events;
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'ParcelPoint returned invalid events');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'ParcelPoint returned an oversized history');
  const current = text(payload, 'currentStatus', 64);
  const summary = text(payload, 'statusDesc');
  const details = payload.details;
  // The service encodes an empty set of numbers as an empty list.
  if (Array.isArray(details) && !details.length) {
    if (!rows.length && !current && !summary) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'ParcelPoint answered without the parcel’s numbers');
  }
  if (!isRecord(details)) throw new SchemaError(PROVIDER, 'ParcelPoint returned invalid parcel details');
  const numbers = IDENTITIES.map((key) => normalizeTrackingNumber(text(details, key, 64)));
  if (!numbers.includes(asked)) throw new IndeterminateError(PROVIDER, 'ParcelPoint answered for another parcel');

  const events = eventsOf(rows);
  const headline = summary || (current ? humanise(current) : '');
  if (!events.length) {
    if (!headline) throw new NoHistoryError(PROVIDER);
    const staged = parcelpointStage(current, headline);
    return {
      status: staged ? languageStageStatus(staged.stage) : 'unknown',
      ...(staged ? { current_stage: staged.stage, current_stage_source: staged.source } : {}),
      last_status_text: headline,
      ...(current ? { provider_code: current } : {}),
      last_update: null,
      summary_only: true,
      events: [],
    };
  }
  const newest = events[0]!;
  // The summary repeats the newest event; the newest staged event stands in when it has no stage.
  const own = current || summary ? parcelpointStage(current, headline) : null;
  const scanned = events.find((event) => event.stage);
  const stage = (own?.stage ?? scanned?.stage) as Stage | undefined;
  const source = own?.source ?? scanned?.stage_source;
  const delivered = stage === 'delivered' ? events.find((event) => event.stage === 'delivered') : undefined;
  const point = pickupPoint(events, stage);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: headline || newest.description!,
    last_update: newest.time!,
    ...(delivered ? { delivered_at: delivered.time! } : {}),
    ...(point ? { pickup_point: point } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
