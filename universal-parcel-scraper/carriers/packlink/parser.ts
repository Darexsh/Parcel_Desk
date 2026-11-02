import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { packlinkStage, packlinkWording } from './status.js';

export const PROVIDER = 'Packlink';
// A delivered shipment of two parcels is under four kilobytes.
export const PACKLINK_MAX_BYTES = 512 * 1024;
// Two letters for the market, the year, COM or PRO and ten digits.
const REFERENCE = /^[A-Z]{2}20\d{2}(?:COM|PRO)\d{10}$/;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const NUMBER = /^[A-Z0-9]{4,40}$/;
// The zone the page's Spanish visitors read Packlink's instants in.
const ZONE = 'Europe/Madrid';
const MAX_PARCELS = 50;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A Packlink reference, in capitals as the tracker needs it; anything else is not one Packlink issues. */
export function normalizePacklinkReference(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!REFERENCE.test(number)) throw new InvalidInputError(PROVIDER, 'Packlink references are two letters, the year, COM or PRO and ten digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Packlink returned an invalid ${key}`);
  return clean(value, maxLength);
}

function code(row: Record<string, unknown>, key: string): string {
  const value = text(row, key, 64);
  if (!CODE.test(value)) throw new SchemaError(PROVIDER, `Packlink returned an invalid ${key}`);
  return value;
}

function rows(row: Record<string, unknown>, key: string, max: number): Record<string, unknown>[] {
  const value = row[key] ?? [];
  if (!Array.isArray(value) || value.length > max || !value.every(isRecord)) {
    throw new SchemaError(PROVIDER, `Packlink returned invalid ${key}`);
  }
  return value;
}

/**
 * An instant as Packlink stamps it. Its offset holds for some collecting
 * carriers and not others, so the scan keeps it only as the wall clock the
 * page shows a visitor in Spain.
 */
function instant(value: string): DateTime {
  const parsed = INSTANT.test(value) ? DateTime.fromISO(value, { setZone: true }) : null;
  if (!parsed?.isValid) throw new SchemaError(PROVIDER, 'Packlink returned an invalid time');
  return parsed;
}

const wallClock = (time: DateTime) => time.setZone(ZONE).toFormat("yyyy-MM-dd'T'HH:mm:ss");

// A run of nine or more digits, with spaces, brackets, dots or hyphens
// between them, as phone numbers are written; a date stays.
const PHONE = /(?<![A-Z\d])(?!\d{4}-\d{2}-\d{2}(?!\d))\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
const EMAIL = /[^\s@]+@[^\s@]+\.[a-z]{2,}/gi;

/** The collecting carrier's own label for a scan, without phone numbers or e-mail addresses. */
export function carrierWording(value: string): string {
  return clean(value.replace(PHONE, '').replace(EMAIL, '')).replace(/^[\s,;:.\-–]+|[\s,;:\-–]+$/g, '');
}

interface Scan { at: number; event: CarrierEvent }

function scanEvent(status: string, wording: string, time: Record<string, string>): CarrierEvent {
  const description = wording || packlinkWording(status) || status;
  const staged = packlinkStage(status, wording);
  return { ...time, description, provider_code: status, ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) };
}

/** A parcel's scans as Packlink read them from the collecting carrier: its code, the carrier's label and the time. */
function checkpoint(row: Record<string, unknown>): Scan | null {
  const status = code(row, 'status');
  const raw = row.raw_carrier_status ?? {};
  if (!isRecord(raw)) throw new SchemaError(PROVIDER, 'Packlink returned an invalid carrier status');
  const stamp = text(row, 'occurred_at', 40);
  // An undated scan has no place in the history.
  if (!stamp) return null;
  const at = instant(stamp);
  return { at: at.toMillis(), event: scanEvent(status, carrierWording(text(raw, 'description')), { local_time: wallClock(at) }) };
}

/**
 * The milestones Packlink records itself, at the instant its own clock
 * noted each; read only when no parcel has a scan yet.
 */
function milestone(row: Record<string, unknown>): Scan {
  const status = code(row, 'status');
  const at = instant(text(row, 'time', 40));
  return { at: at.toMillis(), event: scanEvent(status, '', { time: at.toUTC().toISO({ suppressMilliseconds: true })! }) };
}

/** The collecting carrier's number for the shipment, else for its only parcel. */
function deliveryNumber(data: Record<string, unknown>, parcels: Record<string, unknown>[], reference: string): string | undefined {
  const own = (value: string) => {
    const number = normalizeTrackingNumber(value).toUpperCase();
    return NUMBER.test(number) && number !== reference ? number : undefined;
  };
  const shipment = own(text(data, 'carrier_shipment_tracking_number', 64));
  if (shipment) return shipment;
  const numbers = new Set(parcels.map((parcel) => own(text(parcel, 'carrier_tracking_number', 64))));
  return numbers.size === 1 ? [...numbers][0] : undefined;
}

/** The delivery estimate, a calendar day, from the shipment else its parcels. */
function estimate(data: Record<string, unknown>, parcels: Record<string, unknown>[]): string | null {
  for (const row of [data, ...parcels]) {
    const value = text(row, 'estimated_time_of_delivery', 32).slice(0, 10);
    if (DATE.test(value) && DateTime.fromISO(value, { zone: 'UTC' }).isValid) return value;
  }
  return null;
}

/**
 * The reply of `GET /v1/trackings/{reference}` on Packlink's API, which its
 * tracking page reads. A shipment must name the reference asked. An unknown
 * reference is HTTP 404 with `{"messages":[{"message":"Not Found"}]}`.
 */
export function parsePacklink(payload: unknown, raw: string): CarrierResult {
  const reference = normalizePacklinkReference(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Packlink returned an invalid envelope');
  if (!Object.hasOwn(payload, 'shipment_reference')) {
    const messages = payload.messages;
    if (Array.isArray(messages) && messages.some((row) => isRecord(row) && row.message === 'Not Found')) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'Packlink returned a reply without its shipment');
  }
  if (typeof payload.shipment_reference !== 'string') throw new SchemaError(PROVIDER, 'Packlink returned an invalid shipment reference');
  if (clean(payload.shipment_reference, 64).toUpperCase() !== reference) throw new IndeterminateError(PROVIDER, 'Packlink answered for another shipment');
  const parcels = rows(payload, 'parcels', MAX_PARCELS);

  const seen = new Set<string>();
  const scans: Scan[] = [];
  const keep = (scan: Scan | null) => {
    if (!scan) return;
    const key = JSON.stringify([scan.at, scan.event.provider_code, scan.event.description]);
    if (seen.has(key)) return;
    seen.add(key);
    scans.push(scan);
  };
  let total = 0;
  for (const parcel of parcels) {
    const checkpoints = rows(parcel, 'checkpoints', MAX_ROWS);
    total += checkpoints.length;
    if (total > MAX_ROWS) throw new SchemaError(PROVIDER, 'Packlink returned an oversized history');
    // Parcels of one shipment usually share their scans; each is kept once.
    checkpoints.forEach((row) => keep(checkpoint(row)));
  }
  if (!scans.length) rows(payload, 'status_history', MAX_ROWS).forEach((row) => keep(milestone(row)));
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first; the reply lists them oldest first.
  const events = scans.map((scan, index) => ({ ...scan, index }))
    .sort((left, right) => right.at - left.at || right.index - left.index).map((scan) => scan.event);

  const newest = events[0]!;
  const staged = events.find((event) => event.stage);
  const stage = staged?.stage as Stage | undefined;
  const handoff = deliveryNumber(payload, parcels, reference);
  const expected = stage === 'delivered' || stage === 'returned' ? null : estimate(payload, parcels);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    expected_delivery: expected,
    ...(handoff ? { delivery_tracking_number: handoff } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
