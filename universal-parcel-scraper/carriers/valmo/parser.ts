import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { valmoStage } from './status.js';

export const PROVIDER = 'Valmo';
// A long history is a few kilobytes.
export const VALMO_MAX_BYTES = 256 * 1024;
// VL and thirteen digits. The tracker reads a lower-case number as unknown.
const NUMBER = /^VL\d{13}$/;
// How the tracker answers a number it has no parcel for, whether never issued or expired.
const UNKNOWN = /^Invalid AWB\/Tracking ID$/i;
// The page shows scan times in India; the reply's instants carry no zone.
const ZONE = 'Asia/Kolkata';
// Instants outside these bounds are not scan times.
const EARLIEST = Date.UTC(2015, 0, 1);
const LATEST = Date.UTC(2100, 0, 1);
// A hub scan names its hub: "Reached Patna hub", "Left New delhi west hub".
const HUB = /^(?:Reached|Left)\s+(.+?)\s+hub$/i;
const MAX_STEPS = 100;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A number for Valmo's tracker, in upper case; anything else is not one it issues. */
export function normalizeValmoNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Valmo tracking IDs are VL and thirteen digits');
  return number;
}

/** A required text field; anything but a non-empty string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = typeof row[key] === 'string' ? clean(row[key], maxLength) : '';
  if (!value) throw new SchemaError(PROVIDER, `Valmo returned a scan without its ${key}`);
  return value;
}

/** A scan's instant in epoch milliseconds, shown in India to the second. */
function scanTime(value: unknown): { time: string; at: number } {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < EARLIEST || value >= LATEST) {
    throw new SchemaError(PROVIDER, 'Valmo returned an invalid scan time');
  }
  const at = Math.floor(value / 1000) * 1000;
  return { time: DateTime.fromMillis(at, { zone: ZONE }).toISO({ suppressMilliseconds: true })!, at };
}

interface Scan { event: CarrierEvent; at: number; index: number }

/**
 * One step or hub scan. A step the parcel has not reached yet, which the page
 * greys out, is no scan.
 */
function projectRow(row: unknown, index: number): (Scan & { key: string }) | null {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Valmo returned an invalid scan');
  if (row.is_complete === false) return null;
  const code = text(row, 'status', 64).toUpperCase();
  const description = text(row, 'display_name');
  const { time, at } = scanTime(row.date);
  const hub = HUB.exec(description)?.[1];
  const staged = valmoStage(code, description);
  const event: CarrierEvent = {
    time,
    ...(hub ? { location: hub } : {}),
    description,
    provider_code: code,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { event, at, index, key: JSON.stringify([at, code, description]) };
}

/**
 * The reply of the track page's `/api/valmo-web/track-order` for one number.
 * It answers HTTP 200 with `success` and the number asked as `tracking_id`. A
 * parcel has `tracking`: its steps in order, each with the hub scans under it.
 * A number the tracker has no parcel for is `success: false` with the remark
 * "Invalid AWB/Tracking ID", which the page shows under its form.
 */
export function parseValmo(payload: unknown, raw: string): CarrierResult {
  const number = normalizeValmoNumber(raw);
  if (!isRecord(payload) || typeof payload.success !== 'boolean') throw new SchemaError(PROVIDER, 'Valmo returned an invalid envelope');
  if (typeof payload.tracking_id !== 'string') throw new SchemaError(PROVIDER, 'Valmo returned a reply without its tracking ID');
  if (clean(payload.tracking_id, 64) !== number) throw new IndeterminateError(PROVIDER, 'Valmo answered for another tracking ID');
  if (!payload.success) {
    if (UNKNOWN.test(clean(payload.remarks, 200))) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Valmo did not complete the lookup');
  }
  const steps = payload.tracking ?? [];
  if (!Array.isArray(steps)) throw new SchemaError(PROVIDER, 'Valmo returned a parcel with invalid steps');
  if (steps.length > MAX_STEPS) throw new SchemaError(PROVIDER, 'Valmo returned an oversized history');

  const seen = new Set<string>();
  const scans: Scan[] = [];
  let rows = 0;
  const add = (row: unknown) => {
    rows += 1;
    if (rows > MAX_ROWS) throw new SchemaError(PROVIDER, 'Valmo returned an oversized history');
    const scan = projectRow(row, rows);
    if (!scan || seen.has(scan.key)) return;
    seen.add(scan.key);
    scans.push(scan);
  };
  for (const step of steps) {
    add(step);
    const hubs = (step as Record<string, unknown>).sub_status_list ?? [];
    if (!Array.isArray(hubs)) throw new SchemaError(PROVIDER, 'Valmo returned a step with invalid scans');
    hubs.forEach(add);
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first; of two scans on one second, the one listed later is newer.
  const events = scans.sort((a, b) => (a.at === b.at ? b.index - a.index : b.at - a.at)).map(({ event }) => event);

  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: null,
    ...(stage === 'delivered' ? { delivered_at: current!.time! } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
