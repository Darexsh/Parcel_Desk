import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { BORDER_EXPRESS_BARCODE, borderExpressNumber } from './number.js';
import { BOOKING_CODES, borderExpressMappedStage, borderExpressStage } from './status.js';

export const PROVIDER = 'Border Express';
export const CARRIER = 'border-express';
// A consignment of four units is under four kilobytes.
export const BORDER_EXPRESS_MAX_BYTES = 512 * 1024;

const ETA = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const MAX_CONSIGNMENTS = 20;
const MAX_ROWS = 100;
const MAX_UNITS = 2000;

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Border Express returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** An optional list; anything but an array is a changed reply. */
function list(row: Record<string, unknown>, key: string, max: number): unknown[] {
  const value = row[key];
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new SchemaError(PROVIDER, `Border Express returned an invalid ${key}`);
  if (value.length > max) throw new SchemaError(PROVIDER, `Border Express returned an oversized ${key}`);
  return value;
}

/** The suburb a row names, with its state. */
function place(row: Record<string, unknown>): string {
  const suburb = text(row, 'suburb', 80);
  const state = text(row, 'state', 8).toUpperCase();
  if (!suburb) return state;
  return state ? `${suburb}, ${state}` : suburb;
}

interface Row {
  timestamp: number;
  event: CarrierEvent;
}

/**
 * A status row: the status, when and where the consignment reached it, and
 * the unit scans behind it. Its clock carries the offset of the depot's state.
 * A row without a date, as the pickup step often is, is no scan.
 */
function projectRow(row: unknown, units: string[]): Row | null {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Border Express returned an invalid status row');
  const code = text(row, 'integrationCode', 8).toUpperCase();
  const description = text(row, 'status', 120);
  for (const scan of list(row, 'statusEvents', MAX_UNITS)) {
    if (!isRecord(scan)) throw new SchemaError(PROVIDER, 'Border Express returned an invalid unit scan');
    const unit = normalizeTrackingNumber(text(scan, 'itemBarcode', 64));
    if (unit) units.push(unit);
  }
  if (BOOKING_CODES.has(code)) return null;
  const occurred = row.dateOccurred;
  if (occurred === null || occurred === undefined) return null;
  const time = explicitOffsetTime(occurred);
  if (!time) throw new SchemaError(PROVIDER, 'Border Express returned an invalid status time');
  if (!description) throw new SchemaError(PROVIDER, 'Border Express returned a status row without wording');
  const location = place(row);
  const staged = borderExpressStage(code, description);
  return {
    timestamp: time.timestamp,
    event: {
      time: time.iso,
      ...(location ? { location } : {}),
      description,
      ...(code ? { provider_code: code } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    },
  };
}

/** The estimate, `d/MM/yyyy`, as a calendar day. */
function estimate(entry: Record<string, unknown>): string | null {
  const match = ETA.exec(text(entry, 'etaDate', 16));
  return match ? calendarDay(Number(match[3]), Number(match[2]), Number(match[1])) : null;
}

/**
 * The reply of the tracker's `quickTrackpublic` lookup for one consignment:
 * a list of consignments, each with its current status, its estimate and
 * delivery, the sender's and receiver's localities, the signatory and its
 * status rows, newest first. The entry must name the consignment asked. When
 * a unit barcode was asked, the units the rows list must include one of that
 * consignment's labels, if they list Border Express labels at all.
 *
 * The localities, postcodes, unit counts, unit barcodes and their scans, the
 * despatch day and the signatory are not read.
 */
export function parseBorderExpress(payload: unknown, raw: string): CarrierResult {
  const { consignment, barcode } = borderExpressNumber(raw);
  if (!isRecord(payload) || !Array.isArray(payload.consignments)) throw new SchemaError(PROVIDER, 'Border Express returned an invalid envelope');
  const matches = list(payload, 'consignments', MAX_CONSIGNMENTS).filter((entry) => {
    if (!isRecord(entry) || typeof entry.consignmentNumber !== 'string') {
      throw new SchemaError(PROVIDER, 'Border Express returned a consignment without its number');
    }
    return normalizeTrackingNumber(clean(entry.consignmentNumber, 64)) === consignment;
  }) as Record<string, unknown>[];
  if (!matches.length) throw new IndeterminateError(PROVIDER, 'Border Express answered for another consignment');
  if (matches.length > 1) throw new IndeterminateError(PROVIDER, 'Border Express answered with several consignments for the number');
  const entry = matches[0]!;

  const units: string[] = [];
  const rows = list(entry, 'statusHistory', MAX_ROWS).map((row) => projectRow(row, units))
    .filter((row): row is Row => row !== null);
  if (barcode) {
    // The label stem, the prefix, `BX` and the padded range, is the consignment's on every unit.
    const labels = units.filter((unit) => BORDER_EXPRESS_BARCODE.test(unit));
    if (labels.length && !labels.some((unit) => unit.slice(0, 17) === barcode.slice(0, 17))) {
      throw new IndeterminateError(PROVIDER, 'Border Express answered for a consignment whose units carry other labels');
    }
  }
  if (!rows.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the tracker lists them; a row's order follows its clock.
  const events = rows.map((row, index) => ({ ...row, index }))
    .sort((a, b) => b.timestamp - a.timestamp || a.index - b.index).map(({ event }) => event);

  const current = isRecord(entry.currentStatus) ? text(entry.currentStatus, 'integrationCode', 8).toUpperCase() : '';
  const summary = current ? borderExpressMappedStage(current) : undefined;
  const scanned = events.find((event) => event.stage);
  const stage = (summary ?? scanned?.stage) as Stage | undefined;
  const source = summary ? 'carrier_map' : scanned?.stage_source;
  const newest = events[0]!;
  const delivered = stage === 'delivered'
    ? explicitOffsetTime(entry.deliveredDate)?.iso ?? events.find((event) => event.stage === 'delivered')?.time ?? null
    : null;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: stage === 'delivered' ? null : estimate(entry),
    delivered_at: delivered,
    ...(barcode ? { canonical_tracking_number: consignment } : {}),
    events,
  };
}
