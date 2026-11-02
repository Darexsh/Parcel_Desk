import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { mylerzStage } from './status.js';

export const PROVIDER = 'Mylerz';
// A delivered parcel's reply is a few kilobytes, its courier's calls included.
export const MYLERZ_MAX_BYTES = 512 * 1024;
// The tracker's own test for a barcode: fourteen characters starting 63. It
// sends anything else to its merchant reference search.
const NUMBER = /^63\d{12}$/;
// A wall clock to the second, with the fraction the reply sometimes adds.
const CLOCK = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,7})?$/;
const MAX_ROWS = 300;

/** A Mylerz barcode; anything else is not a number its tracker looks up as one. */
export function normalizeMylerzNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Mylerz barcodes are fourteen digits starting 63');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Mylerz returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A status id: a nonnegative whole number, or nothing. */
function statusCode(value: unknown): string {
  if (value === null || value === undefined) return '';
  const code = cleanScalar(value, 8);
  if (typeof value === 'object' || !/^\d+$/.test(code)) throw new SchemaError(PROVIDER, 'Mylerz returned an invalid status');
  return String(Number(code));
}

/**
 * A scan's clock: the reply's wall clock to the second, without its fraction.
 * The reply names no zone, so it stays local.
 */
function scanClock(value: unknown): string {
  const local = typeof value === 'string' ? CLOCK.exec(value.trim())?.[1] : undefined;
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = local ? DateTime.fromISO(local, { zone: 'UTC' }) : null;
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!local || !parsed?.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'Mylerz returned an invalid scan time');
  }
  return local;
}

/**
 * One row of `PackageStatusLog`. The tracker shows the consumer status
 * (`StatusBusId` and its English name) and the time; the internal status name
 * stands in for a consumer name the row lacks. The courier's calls and text
 * messages on the row are not read.
 */
function projectRow(row: Record<string, unknown>): { key: string; event: CarrierEvent } {
  const code = statusCode(row.StatusBusId);
  const description = text(row, 'StatusBusEnName') || text(row, 'StatusEnName');
  if (!description) throw new SchemaError(PROVIDER, 'Mylerz returned a scan without wording');
  const local = scanClock(row.ChangedDate);
  const staged = mylerzStage(code, description);
  const event: CarrierEvent = {
    local_time: local,
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([local, code, description]), event };
}

/**
 * The reply of `GetPackageTrackingDetailsByBarCode` for one barcode. A barcode
 * the instance does not know is `IsErrorState` with `NOT_FOUND`; any other
 * error it reports, such as its database failing, leaves the answer open. A
 * shipment must name the barcode asked.
 */
export function parseMylerz(payload: unknown, raw: string): CarrierResult {
  const number = normalizeMylerzNumber(raw);
  if (!isRecord(payload) || typeof payload.IsErrorState !== 'boolean') throw new SchemaError(PROVIDER, 'Mylerz returned an invalid envelope');
  if (payload.IsErrorState) {
    if (payload.ErrorDescription === 'NOT_FOUND' && payload.Value == null) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Mylerz could not complete the lookup');
  }
  const value = payload.Value;
  if (!isRecord(value)) throw new SchemaError(PROVIDER, 'Mylerz returned a reply without a shipment');
  const details = value.PackageTrackingShipmentDetails;
  if (!isRecord(details) || !['string', 'number'].includes(typeof details.Barcode)) {
    throw new SchemaError(PROVIDER, 'Mylerz returned a shipment without its barcode');
  }
  if (cleanScalar(details.Barcode, 64) !== number) throw new IndeterminateError(PROVIDER, 'Mylerz answered for another shipment');
  const rows = value.PackageStatusLog ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Mylerz returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Mylerz returned an oversized history');

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Mylerz returned an invalid scan');
    const scan = projectRow(row);
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    events.push(scan.event);
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the tracker lists them; the sort keeps the reply's order for equal clocks.
  if (listsNewestFirst(events) === false) events.reverse();
  events.sort((a, b) => (b.local_time as string).localeCompare(a.local_time as string));

  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  const stage = scanned?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: scanned!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    events,
  };
}
