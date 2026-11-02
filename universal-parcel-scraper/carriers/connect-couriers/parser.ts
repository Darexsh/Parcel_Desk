import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { connectCouriersStage } from './status.js';

export const PROVIDER = 'Connect Couriers';
// A long history is a few kilobytes.
export const CONNECT_COURIERS_MAX_BYTES = 256 * 1024;
// Digits only: the tracking page's field takes nothing else.
const NUMBER = /^\d{8,20}$/;
// The scan's wall clock, to the second; a fraction of a second is dropped.
const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,7})?$/;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A number for Connect Couriers' tracker, digits only; anything else is not one it issues. */
export function normalizeConnectCouriersNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Connect Couriers numbers are eight to twenty digits');
  return number;
}

/** A required text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Connect Couriers returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** Whether a tracking number in the reply is the number asked. */
function sameNumber(value: unknown, number: string): boolean {
  return typeof value === 'string' && value.length <= 64 && normalizeTrackingNumber(value) === number;
}

// A run of nine or more digits, with spaces, brackets, dots or hyphens
// between them, as phone numbers are written.
const PHONE = /(?<![A-Z\d])\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
// Who signed for the parcel, after a delivery's wording.
const SIGNATORY = /\s*[,;:.\-–(]?\s*\bsigned\s+(?:for\s+)?by\b[\s\S]*$/i;

/** A scan's wording without a signatory or phone numbers. */
export function connectCouriersWording(raw: string): string {
  return clean(raw.replace(SIGNATORY, '').replace(PHONE, '')).replace(/^[\s,;:.\-–/]+|[\s,;:\-–/]+$/g, '');
}

/**
 * A scan's clock. `stageDateTime` is a wall clock with no zone, which the
 * page shows as it is, so it stays local.
 */
function scanClock(row: Record<string, unknown>): string {
  const match = WALL_CLOCK.exec(text(row, 'stageDateTime', 40));
  const local = match?.[1] ?? '';
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  // Luxon rolls 24:00:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!match || !parsed.isValid || parsed.year < 2000 || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'Connect Couriers returned an invalid scan time');
  }
  return local;
}

/**
 * Whether a scan concerns the parcel asked. A scan lists the pieces of the
 * consignment it was made for; one that lists none concerns them all.
 */
function concerns(row: Record<string, unknown>, number: string): boolean {
  const pieces = row.packages ?? [];
  if (!Array.isArray(pieces) || pieces.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Connect Couriers returned a scan with invalid pieces');
  if (!pieces.length) return true;
  return pieces.some((piece) => {
    if (!isRecord(piece) || typeof piece.trackingNumber !== 'string') throw new SchemaError(PROVIDER, 'Connect Couriers returned an invalid piece');
    return sameNumber(piece.trackingNumber, number);
  });
}

function projectRow(row: Record<string, unknown>): { key: string; event: CarrierEvent } {
  const description = connectCouriersWording(text(row, 'stageStatus'));
  if (!description) throw new SchemaError(PROVIDER, 'Connect Couriers returned a scan without wording');
  const local = scanClock(row);
  const staged = connectCouriersStage(description);
  const event: CarrierEvent = {
    local_time: local,
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([local, description]), event };
}

/** The scans of the parcel asked, from the history's date groups. */
function scans(data: Record<string, unknown>, number: string): CarrierEvent[] {
  const groups = data.trackingHistory ?? [];
  if (!Array.isArray(groups) || groups.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Connect Couriers returned an invalid history');
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const group of groups) {
    if (!isRecord(group)) throw new SchemaError(PROVIDER, 'Connect Couriers returned an invalid history group');
    // The page skips a group without items.
    const rows = group.items ?? [];
    if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Connect Couriers returned an invalid history group');
    for (const row of rows) {
      if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Connect Couriers returned an invalid scan');
      if (!concerns(row, number)) continue;
      const scan = projectRow(row);
      if (seen.has(scan.key)) continue;
      seen.add(scan.key);
      events.push(scan.event);
      if (events.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Connect Couriers returned an oversized history');
    }
  }
  // Newest first; the groups are by day, and the scans within one are in no order.
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => (b.event.local_time as string).localeCompare(a.event.local_time as string) || a.index - b.index)
    .map(({ event }) => event);
}

/** The piece of the consignment that is the parcel asked. */
function piece(data: Record<string, unknown>, number: string): Record<string, unknown> {
  const pieces = data.packageData;
  if (!Array.isArray(pieces) || pieces.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Connect Couriers returned a shipment without its pieces');
  const found: unknown = pieces.find((entry) => isRecord(entry) && sameNumber(entry.trackingNumber, number));
  if (!isRecord(found)) throw new SchemaError(PROVIDER, 'Connect Couriers returned a shipment without the parcel asked');
  return found;
}

/** The headline status's word for a parcel whose journey ended or stopped. */
function headlineStage(found: Record<string, unknown>): Stage | undefined {
  if (typeof found.stageStatus !== 'string') return undefined;
  const stage = connectCouriersStage(connectCouriersWording(found.stageStatus))?.stage;
  return stage === 'delivered' || stage === 'returned' || stage === 'exception' ? stage : undefined;
}

/** The destination country the page flags, from the recipient's country code. */
function destination(found: Record<string, unknown>): string | null {
  if (!isRecord(found.recipient)) return null;
  return countryCode(clean(found.recipient.countryCode, 8)) ?? countryCode(clean(found.recipient.country, 60));
}

/**
 * The reply of the tracking page's WordPress action for one number. It
 * answers HTTP 200 with `{"success":false}` for a number it does not know,
 * which the page reports as an invalid tracking number. A found reply has
 * the consignment's pieces, a progress rail and the scans grouped by day;
 * the reply and the piece must both name the number asked.
 */
export function parseConnectCouriers(payload: unknown, raw: string): CarrierResult {
  const number = normalizeConnectCouriersNumber(raw);
  if (!isRecord(payload) || typeof payload.success !== 'boolean') throw new SchemaError(PROVIDER, 'Connect Couriers returned an invalid envelope');
  if (!payload.success) {
    // WordPress's error reply carries its reason in `data`; the tracker sends none for an unknown number.
    if (payload.data !== undefined && payload.data !== null) throw new IndeterminateError(PROVIDER, 'Connect Couriers did not complete the lookup');
    throw new NotFoundError(PROVIDER);
  }
  const data = payload.data;
  if (!isRecord(data) || typeof data.trackingNumber !== 'string') throw new SchemaError(PROVIDER, 'Connect Couriers returned a shipment without its number');
  if (!sameNumber(data.trackingNumber, number)) throw new IndeterminateError(PROVIDER, 'Connect Couriers answered for another shipment');
  const found = piece(data, number);
  const events = scans(data, number);
  if (!events.length) throw new NoHistoryError(PROVIDER);

  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  const headline = headlineStage(found);
  const stage = (headline ?? scanned?.stage) as Stage | undefined;
  const source = headline && headline !== scanned?.stage ? 'carrier_map' : scanned?.stage_source;
  const country = destination(found);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    ...(country ? { destination_country: country } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
