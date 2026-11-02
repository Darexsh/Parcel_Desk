import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { xdeLogisticsMappedStage, xdeLogisticsStage } from './status.js';

export const PROVIDER = 'XDE Logistics';
// A delivered history of four scans is about a kilobyte.
export const XDE_LOGISTICS_MAX_BYTES = 256 * 1024;
const ZONE = 'Asia/Manila';
// Letters and digits with at least one digit, as on every XDE number seen; the
// lookup answers any case and names the number in capitals.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,40}$/;
const CLOCK = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const CLOCK_FORMAT = 'yyyy-MM-dd HH:mm:ss';
// A receipt at a hub or warehouse, whose reference names the facility. On a
// delivery the reference names who took the parcel, so only these keep it.
const HUB_RECEIPT = /^(?:received|arrived|accepted)\b.*\b(?:hub|warehouse|branch|station|facility)\b/i;
// A run of nine or more digits, with the separators phone numbers are written with.
const PHONE = /(?<![A-Z\d])\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A number for XDE's lookup, in capitals; anything else is not one it issues. */
export function normalizeXdeLogisticsNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'XDE Logistics numbers are six or more letters and digits');
  return number;
}

/** Whether a reply is the lookup's own answer for a number it does not hold, which comes with HTTP 404. */
export function isXdeLogisticsNotFound(payload: unknown): boolean {
  return isRecord(payload) && payload.code === 404 && typeof payload.message === 'string' && /^invalid$/i.test(payload.message.trim());
}

/** An optional text field; the reply puts `false` or null where it has none, and anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined || value === false) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `XDE Logistics returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * A scan's instant. `created_at` is Manila's wall clock to the second, with no
 * zone: XDE delivers only in the Philippines, which keep one offset all year.
 */
function scanTime(value: unknown): { time: string; millis: number } {
  const raw = typeof value === 'string' ? value.trim() : '';
  // Parsing in UTC checks the calendar digits only; Luxon rolls 24:00 over, so only a clock that reads back unchanged is kept.
  const digits = DateTime.fromFormat(raw, CLOCK_FORMAT, { zone: 'UTC' });
  const parsed = CLOCK.test(raw) && digits.isValid && digits.toFormat(CLOCK_FORMAT) === raw ? zonedTime(raw, CLOCK_FORMAT, ZONE) : null;
  if (!parsed) throw new SchemaError(PROVIDER, 'XDE Logistics returned an invalid scan time');
  return { time: parsed.iso, millis: parsed.timestamp };
}

/** The facility a hub or warehouse receipt names, without phone numbers; any other scan's reference is not kept. */
export function xdeLogisticsLocation(status: string, reference: string): string {
  if (!HUB_RECEIPT.test(status.trim())) return '';
  const place = clean(reference.replace(PHONE, ''), 120).replace(/^[\s,;:.\-–]+|[\s,;:\-–]+$/g, '');
  return /[A-Z]/i.test(place) ? place : '';
}

interface Scan { millis: number; event: CarrierEvent }

function projectRow(row: unknown): Scan | null {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'XDE Logistics returned an invalid scan');
  // The page leaves out a scan without a status.
  if (row.status === null) return null;
  if (typeof row.status !== 'string') throw new SchemaError(PROVIDER, 'XDE Logistics returned an invalid status');
  const status = clean(row.status, 120);
  if (!status) return null;
  const { time, millis } = scanTime(row.created_at);
  const location = xdeLogisticsLocation(status, text(row, 'reference', 200));
  const staged = xdeLogisticsStage(status);
  return { millis, event: {
    time, ...(location ? { location } : {}), description: status,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  } };
}

/**
 * The reply of `/api/v2/client/public/services/shipment/{number}/history` for
 * one shipment: its number, its current status and its scans, newest first.
 * The shipment must name the number asked.
 */
export function parseXdeLogistics(payload: unknown, requested: string): CarrierResult {
  const number = normalizeXdeLogisticsNumber(requested);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'XDE Logistics returned an invalid envelope');
  if (typeof payload.tracking_number !== 'string') throw new SchemaError(PROVIDER, 'XDE Logistics returned a shipment without its number');
  if (normalizeTrackingNumber(clean(payload.tracking_number, 64)).toUpperCase() !== number) {
    throw new IndeterminateError(PROVIDER, 'XDE Logistics answered for another shipment');
  }
  const rows = payload.history ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'XDE Logistics returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'XDE Logistics returned an oversized history');
  const current = text(payload, 'current_status', 120);

  const seen = new Set<string>();
  const scans: Scan[] = [];
  rows.forEach((row) => {
    const scan = projectRow(row);
    if (!scan) return;
    const key = JSON.stringify([scan.event.time, scan.event.description, scan.event.location ?? '']);
    if (seen.has(key)) return;
    seen.add(key);
    scans.push(scan);
  });

  if (!scans.length) {
    // The page shows the current status over an empty history.
    if (!current) throw new NoHistoryError(PROVIDER);
    const staged = xdeLogisticsStage(current);
    return {
      status: staged ? languageStageStatus(staged.stage) : 'unknown',
      ...(staged ? { current_stage: staged.stage, current_stage_source: staged.source } : {}),
      last_status_text: current,
      last_update: null,
      expected_delivery: null,
      summary_only: true,
      events: [],
    };
  }

  // Newest first, as the reply lists them.
  if (listsNewestFirst(scans.map(({ event }) => event)) === false) scans.reverse();
  const events = scans.sort((left, right) => right.millis - left.millis).map(({ event }) => event);
  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  // The current status settles a journey that ended, should its scan be missing.
  const summary = current ? xdeLogisticsMappedStage(current) : undefined;
  const ended = summary === 'delivered' || summary === 'returned' ? summary : undefined;
  const stage = (ended ?? scanned?.stage) as Stage | undefined;
  const source = ended && ended !== scanned?.stage ? 'carrier_map' : scanned?.stage_source;
  const delivered = stage === 'delivered' ? events.find((event) => event.stage === 'delivered')?.time : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: null,
    ...(delivered ? { delivered_at: delivered } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
