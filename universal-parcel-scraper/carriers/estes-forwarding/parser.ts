import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InputRequiredError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { estesForwardingStage } from './status.js';

export const PROVIDER = 'Estes Forwarding Worldwide';
// A long history is a few kilobytes.
export const ESTES_FORWARDING_MAX_BYTES = 256 * 1024;
// A housebill: seven digits, as every housebill in archived and live lookups.
const NUMBER = /^\d{7}$/;
// A clock as the reply writes it: month, day, two-digit year, hours and minutes.
const CLOCK = /^(\d{2})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})$/;
const CODE = /^[A-Z0-9]{1,8}$/;
const NOT_FOUND = /\bnot found\b/i;
// What the tracker's own history leaves out: the appointment, whose time is the
// appointment's, and REC. The estimate (ETD) is read on its own.
const NOT_SCANS = new Set(['APP', 'ETD', 'REC']);
// Codes after which the tracker shows no scheduled delivery.
const CLOSED = new Set(['DEL', 'CLS', 'CXL']);
// Pickup services, whose scheduled date is a pickup's.
const PICKUP_SERVICES = new Set(['RN', 'RT', 'RI', 'PD']);
// The carrier's zone, in which an estimate's day is read.
const ZONE = 'America/New_York';
const POUNDS_TO_KG = 0.45359237;
const WEIGHT = /^\d+(?:\.\d+)?$/;
const MAX_SHIPMENTS = 50;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A housebill number for EFW's tracker; anything else is not one EFW issues. */
export function normalizeEstesForwardingNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'EFW housebill numbers are seven digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `EFW returned an invalid ${key}`);
  return clean(value, maxLength);
}

interface Instant {
  iso: string;
  millis: number;
}

/**
 * A clock the reply gives in GMT, such as `12/09/23 16:17`, as an instant; an
 * empty field is null.
 */
function clock(row: Record<string, unknown>, key: string): Instant | null {
  const raw = text(row, key, 32);
  if (!raw) return null;
  const parts = CLOCK.exec(raw);
  if (!parts) throw new SchemaError(PROVIDER, `EFW returned an invalid ${key}`);
  const [month, day, year, hour, minute] = parts.slice(1).map(Number) as [number, number, number, number, number];
  const parsed = DateTime.fromObject({ year: 2000 + year, month, day, hour, minute }, { zone: 'UTC' });
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!parsed.isValid || parsed.toFormat('MM/dd/yy HH:mm') !== raw) throw new SchemaError(PROVIDER, `EFW returned an invalid ${key}`);
  return { iso: parsed.toISO({ suppressMilliseconds: true }), millis: parsed.toMillis() };
}

interface Scan {
  key: string;
  event: CarrierEvent;
  millis: number;
  index: number;
}

function projectRow(row: Record<string, unknown>, code: string, index: number): Scan {
  const description = text(row, 'description', 200);
  if (!description) throw new SchemaError(PROVIDER, 'EFW returned an event without wording');
  const time = clock(row, 'datetimeGMT');
  if (!time) throw new SchemaError(PROVIDER, 'EFW returned an event without its time');
  const staged = estesForwardingStage(code, description);
  const event: CarrierEvent = {
    time: time.iso,
    description,
    provider_code: code,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([time.iso, code, description]), event, millis: time.millis, index };
}

/**
 * The day the parcel is due: the scheduled delivery the page shows, else the
 * estimate event. Both are instants; the reply names no recipient's zone, so
 * the day is read in the carrier's, where a delivery's day and hours fall on
 * the same date across the contiguous states.
 */
function estimate(shipment: Record<string, unknown>, rows: Record<string, unknown>[]): string | null {
  let due: Instant | null = null;
  const scheduled = shipment.scheduledDelivery;
  if (isRecord(scheduled) && shipment.scheduledDELactive !== true && text(shipment, 'shipmenttype', 32).toLowerCase() !== 'international'
    && !PICKUP_SERVICES.has(text(shipment, 'servicelevelcode', 16).toUpperCase())) {
    const from = clock(scheduled, 'fromGMT');
    if (from && clock(scheduled, 'toGMT')) due = from;
  }
  const etd = rows.find((row) => text(row, 'code', 16).toUpperCase() === 'ETD');
  due ??= etd ? clock(etd, 'datetimeGMT') : null;
  return due ? DateTime.fromMillis(due.millis, { zone: ZONE }).toISODate() : null;
}

/** The total weight the page shows, in pounds, as kilograms; none when a line lacks it. */
function weightOf(shipment: Record<string, unknown>): number | null {
  const freight = shipment.freight ?? [];
  if (!Array.isArray(freight) || freight.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'EFW returned invalid freight');
  let pounds = 0;
  for (const line of freight) {
    if (!isRecord(line)) throw new SchemaError(PROVIDER, 'EFW returned an invalid freight line');
    const weight = cleanScalar(line.weight, 16);
    if (!WEIGHT.test(weight)) return null;
    pounds += Number(weight);
  }
  return pounds > 0 ? Math.round(pounds * POUNDS_TO_KG * 1000) / 1000 : null;
}

function projectShipment(shipment: Record<string, unknown>): CarrierResult {
  const listed = shipment.events ?? [];
  if (!Array.isArray(listed)) throw new SchemaError(PROVIDER, 'EFW returned a shipment with invalid events');
  if (listed.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'EFW returned an oversized history');
  const rows = listed.map((row) => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'EFW returned an invalid event');
    return row;
  });

  const seen = new Set<string>();
  const scans: Scan[] = [];
  let closed = false;
  rows.forEach((row, index) => {
    const code = text(row, 'code', 16).toUpperCase();
    if (!CODE.test(code)) throw new SchemaError(PROVIDER, 'EFW returned an event without its code');
    if (NOT_SCANS.has(code)) return;
    closed ||= CLOSED.has(code);
    const scan = projectRow(row, code, index);
    if (seen.has(scan.key)) return;
    seen.add(scan.key);
    scans.push(scan);
  });
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first; events at one instant keep the reply's order, whose last is the page's status.
  const events = scans.sort((a, b) => b.millis - a.millis || b.index - a.index).map(({ event }) => event);

  const newest = events[0]!;
  const staged = events.find((event) => event.stage);
  const stage = staged?.stage as Stage | undefined;
  const expected = closed || stage === 'delivered' || stage === 'returned' ? null : estimate(shipment, rows);
  const service = text(shipment, 'servicelevel', 80);
  const weight = weightOf(shipment);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: expected,
    ...(stage === 'delivered' ? { delivered_at: staged!.time! } : {}),
    ...(service ? { service_name: service } : {}),
    ...(weight !== null ? { weight_kg: weight } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}

/**
 * The reply of `get_shipment_tracking` for one number, the lookup EFW's
 * tracking page makes. A number it does not know is HTTP 404 with a message
 * saying so and no shipment list. A shipment the tracker shows only with the
 * delivery ZIP code asks for it. The one shipment that names the number asked
 * makes the result.
 */
export function parseEstesForwarding(payload: unknown, raw: string): CarrierResult {
  const number = normalizeEstesForwardingNumber(raw);
  if (!isRecord(payload) || !isRecord(payload.metadata)) throw new SchemaError(PROVIDER, 'EFW returned an invalid envelope');
  const { metadata } = payload;
  const messages = metadata.messages ?? [];
  if (!Array.isArray(messages) || !messages.every((message) => typeof message === 'string')) {
    throw new SchemaError(PROVIDER, 'EFW returned invalid messages');
  }
  if (metadata.needed === 'zip') {
    throw new InputRequiredError(PROVIDER, 'the delivery ZIP code', 'EFW shows this shipment only with its delivery ZIP code');
  }
  const listed = payload.payload;
  if (listed === undefined || listed === null) {
    if (messages.some((message) => NOT_FOUND.test(message))) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'EFW did not complete the lookup');
  }
  if (!Array.isArray(listed) || listed.length > MAX_SHIPMENTS) throw new SchemaError(PROVIDER, 'EFW returned an invalid shipment list');
  const own = listed.filter((shipment): shipment is Record<string, unknown> => {
    if (!isRecord(shipment) || typeof shipment.trackingnumber !== 'string') throw new SchemaError(PROVIDER, 'EFW returned a shipment without its number');
    return clean(shipment.trackingnumber, 64) === number;
  });
  if (!own.length) throw new IndeterminateError(PROVIDER, listed.length ? 'EFW answered for another shipment' : 'EFW did not complete the lookup');
  if (own.length > 1) throw new IndeterminateError(PROVIDER, 'EFW lists several shipments under the number', { reason: 'several_parcels' });
  return projectShipment(own[0]!);
}
