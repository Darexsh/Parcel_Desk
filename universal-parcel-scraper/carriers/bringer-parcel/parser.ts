import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { bringerParcelStage, STATUS_LABELS } from './status.js';

export const PROVIDER = 'Bringer Parcel Xpress';
// A parcel with its history is under a kilobyte.
export const BRINGER_PARCEL_MAX_BYTES = 256 * 1024;
// BPS and twelve or thirteen letters and digits, as `bringer-parcel-1` claims them.
const NUMBER = /^BPS[A-Z0-9]{12,13}$/;
// A parcel status or event code, as the reply spells them.
const STATUS = /^[a-z][a-z_]{0,79}$/;
const CODE = /^[A-Z0-9][A-Z0-9-]{0,23}$/i;
// The scan's own instant: ISO 8601 in UTC, as the page reads it.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_PARCELS = 20;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A BPX number in capitals, as the page sends it; anything else is not one BPX issues. */
export function normalizeBringerParcelNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'BPX numbers are BPS and twelve or thirteen letters and digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `BPX returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A parcel status, which every parcel and scan carries. */
function status(row: Record<string, unknown>): string {
  const value = text(row, 'status', 80);
  if (!STATUS.test(value)) throw new SchemaError(PROVIDER, 'BPX returned an invalid status');
  return value;
}

/** The page's label for a parcel status; a status it has no label for is shown as it comes. */
function statusLabel(value: string): string {
  return STATUS_LABELS.get(value) ?? clean(value.replace(/_/g, ' '));
}

interface Scan {
  at: number;
  event: CarrierEvent;
}

function projectRow(row: Record<string, unknown>): { key: string; scan: Scan } {
  const parcelStatus = status(row);
  const code = text(row, 'bpxEventCode', 24).toUpperCase();
  if (code && !CODE.test(code)) throw new SchemaError(PROVIDER, 'BPX returned an invalid event code');
  // The page shows the scan's BPX wording, else its status's label.
  const description = text(row, 'bpxEventDescription') || statusLabel(parcelStatus);
  const created = text(row, 'createdAt', 40);
  const time = INSTANT.test(created) ? explicitOffsetTime(created) : null;
  if (!time) throw new SchemaError(PROVIDER, 'BPX returned an invalid scan time');
  // A place with a digit could be an address or a postal code.
  const place = text(row, 'location', 120);
  const location = /\d/.test(place) ? '' : place;
  const providerCode = code || parcelStatus;
  const staged = bringerParcelStage(code, parcelStatus, description);
  const event: CarrierEvent = {
    time: time.iso,
    ...(location ? { location } : {}),
    description,
    provider_code: providerCode,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([time.timestamp, providerCode, description, location]), scan: { at: time.timestamp, event } };
}

/** The parcel's own status where it ends the journey, which the page shows when the newest scan has no wording. */
function summaryStage(parcelStatus: string): Stage | undefined {
  if (parcelStatus === 'delivered') return 'delivered';
  if (parcelStatus === 'returned') return 'returned';
  if (parcelStatus === 'undeliverable') return 'exception';
  return undefined;
}

/**
 * The parcel the reply holds under the number asked. The tracker also finds a
 * parcel by another carrier's number it carries, so a parcel only counts when
 * its own BPX number is the one asked.
 */
function parcelOf(payload: unknown[], number: string): Record<string, unknown> {
  const parcels = payload.filter((parcel) => {
    if (!isRecord(parcel) || typeof parcel.trackingCode !== 'string') throw new SchemaError(PROVIDER, 'BPX returned a parcel without its number');
    return clean(parcel.trackingCode, 64).toUpperCase() === number;
  }) as Record<string, unknown>[];
  if (!parcels.length) throw new IndeterminateError(PROVIDER, 'BPX answered for another shipment');
  if (parcels.length > 1) throw new IndeterminateError(PROVIDER, 'BPX answered with several parcels under one number');
  return parcels[0]!;
}

/**
 * The reply of the tracking page's `/parcels/track-public/{number}`: a list of
 * the parcels the number names, each with its scans, newest first. An unknown
 * number is HTTP 404 with a message, read by `isBringerParcelMissing`; an
 * empty list is the page's "No shipment matched your search."
 */
export function parseBringerParcel(payload: unknown, raw: string): CarrierResult {
  const number = normalizeBringerParcelNumber(raw);
  if (!Array.isArray(payload)) throw new SchemaError(PROVIDER, 'BPX returned an invalid envelope');
  if (!payload.length) throw new NotFoundError(PROVIDER);
  if (payload.length > MAX_PARCELS) throw new SchemaError(PROVIDER, 'BPX returned too many parcels');
  const parcel = parcelOf(payload, number);
  const parcelStatus = status(parcel);
  const rows = parcel.events ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'BPX returned a parcel with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'BPX returned an oversized history');

  const seen = new Set<string>();
  const scans: Scan[] = [];
  rows.forEach((row) => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'BPX returned an invalid scan');
    const { key, scan } = projectRow(row);
    if (seen.has(key)) return;
    seen.add(key);
    scans.push(scan);
  });
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the page lists them; scans with one instant keep the reply's order.
  if (listsNewestFirst(scans.map(({ event }) => event)) === false) scans.reverse();
  scans.sort((left, right) => right.at - left.at);
  const events = scans.map((scan) => scan.event);

  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  const summary = summaryStage(parcelStatus);
  const stage = (summary ?? scanned?.stage) as Stage | undefined;
  const source = summary && summary !== scanned?.stage ? 'carrier_map' : scanned?.stage_source;
  const delivery = stage === 'delivered' ? events.find((event) => event.stage === 'delivered') : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: null,
    ...(delivery ? { delivered_at: delivery.time! } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}

/**
 * The tracker's HTTP 404 answer: `{"message":"Parcel with tracking code
 * {number} not found","error":"Not Found","statusCode":404}`. It is not found
 * only when it names the number asked; any other 404 is a moved route.
 */
export function isBringerParcelMissing(payload: unknown, raw: string): boolean {
  const number = normalizeBringerParcelNumber(raw);
  if (!isRecord(payload) || payload.statusCode !== 404 || typeof payload.message !== 'string') return false;
  const named = /^Parcel with tracking code (\S+) not found$/i.exec(clean(payload.message, 200))?.[1];
  return named?.toUpperCase() === number;
}
