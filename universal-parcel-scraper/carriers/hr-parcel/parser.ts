import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { hrParcelStage } from './status.js';

export const PROVIDER = 'HR Parcel';
// A long history is a few kilobytes.
export const HR_PARCEL_MAX_BYTES = 256 * 1024;
// Letters and digits with at least one digit: HR Parcel's fourteen-digit
// barcodes, and the senders' own label numbers it tracks under, such as SSCCs.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,40}$/;
// The scan's wall clock; a .NET clock can carry a fraction of a second.
const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,7})?$/;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A number for HR Parcel's barcode search, in upper case; anything else is not one it tracks. */
export function normalizeHrParcelNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'HR Parcel barcodes are eight or more letters and digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `HR Parcel returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A scan's town and province, which some branches give twice: "Town (NA) (NA)". */
function town(row: Record<string, unknown>): string {
  return text(row, 'town', 120).replace(/(\([A-Z]{2}\))(?:\s*\1)+$/i, '$1');
}

/**
 * A scan's clock. `originalDate` is the branch's wall clock to the second,
 * with no zone, so it stays local; `date` is the same clock to the minute.
 */
function scanClock(row: Record<string, unknown>): string {
  const match = WALL_CLOCK.exec(text(row, 'originalDate', 40));
  const local = match?.[1] ?? '';
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  // Luxon rolls 24:00:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!match || !parsed.isValid || parsed.year < 2000 || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'HR Parcel returned an invalid scan time');
  }
  return local;
}

function projectRow(row: Record<string, unknown>): { key: string; event: CarrierEvent } {
  const code = cleanScalar(row.code, 16);
  const description = text(row, 'status');
  if (!description) throw new SchemaError(PROVIDER, 'HR Parcel returned a scan without wording');
  const local = scanClock(row);
  const location = town(row);
  const staged = hrParcelStage(code, description);
  const event: CarrierEvent = {
    local_time: local,
    ...(location ? { location } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([local, code, description, location]), event };
}

/** Whether the shipment's barcodes include the number asked. */
function barcoded(response: Record<string, unknown>, number: string): boolean {
  const list = response.BarcodeList;
  if (!Array.isArray(list) || list.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'HR Parcel returned a shipment without its barcodes');
  return list.some((entry) => {
    if (!isRecord(entry) || typeof entry.Barcode !== 'string') throw new SchemaError(PROVIDER, 'HR Parcel returned an invalid barcode');
    return normalizeTrackingNumber(clean(entry.Barcode, 64)) === number;
  });
}

/**
 * The reply of the tracking page's barcode search, `admin-ajax.php` with
 * `api-action=barcode`. It answers HTTP 200 for every number: `shipment` and
 * `steps` are what the page shows, `response` the shipment service's own
 * record. A shipment without an `id` is one HR Parcel does not know, which
 * the page reports as not found; a service error comes as `InternalError`.
 * The shipment's barcodes must include the number asked.
 */
export function parseHrParcel(payload: unknown, raw: string): CarrierResult {
  const number = normalizeHrParcelNumber(raw);
  if (!isRecord(payload) || !isRecord(payload.shipment) || !Array.isArray(payload.steps) || !isRecord(payload.response)) {
    throw new SchemaError(PROVIDER, 'HR Parcel returned an invalid envelope');
  }
  const { shipment, steps: rows, response } = payload;
  if (response.InternalError !== undefined && response.InternalError !== null) {
    throw new IndeterminateError(PROVIDER, 'HR Parcel did not complete the lookup');
  }
  if (shipment.id === null || shipment.id === undefined) {
    if (rows.length || response.ShipmentData !== undefined) throw new SchemaError(PROVIDER, 'HR Parcel returned a shipment without its id');
    throw new NotFoundError(PROVIDER);
  }
  if (!Number.isSafeInteger(shipment.id) || (shipment.id as number) <= 0) throw new SchemaError(PROVIDER, 'HR Parcel returned an invalid shipment id');
  if (!barcoded(response, number)) throw new IndeterminateError(PROVIDER, 'HR Parcel answered for another shipment');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'HR Parcel returned an oversized history');

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'HR Parcel returned an invalid scan');
    const scan = projectRow(row);
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    events.push(scan.event);
  }
  // A shipment the sender booked shows no scans until HR Parcel has its data.
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the page lists them; scans on one clock keep their order.
  const newestFirst = events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => {
      const later = (b.event.local_time as string).localeCompare(a.event.local_time as string);
      return later || a.index - b.index;
    })
    .map(({ event }) => event);

  const newest = newestFirst[0]!;
  const current = newestFirst.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    events: newestFirst.slice(0, MAX_EVENTS),
    ...(newestFirst.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
