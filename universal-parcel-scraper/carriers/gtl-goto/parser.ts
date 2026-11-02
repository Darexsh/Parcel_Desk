import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { epochMillisTime, explicitOffsetTime, EXPLICIT_OFFSET_PATTERN } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { gtlStage } from './status.js';

export const PROVIDER = 'GoTo Logistics';
// A long history is a few kilobytes.
export const GTL_MAX_BYTES = 256 * 1024;
/** The reply's code for a number the tracker does not know. */
export const GTL_NOT_FOUND = 5413;
// TKGTL and eleven digits and capitals, printed with a hyphen after TKGTL, or GTL and ten digits.
const TKGTL = /^TKGTL[0-9A-Z]{11}$/;
const GTL = /^GTL\d{10}$/;
// An offset-less ISO clock, with a space or a T, to the second or below.
const WALL = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d{1,6})?$/;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A GoTo Logistics number without separators, as the library compares it; anything else is not one GTL issues. */
export function normalizeGtlNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!TKGTL.test(number) && !GTL.test(number)) {
    throw new InvalidInputError(PROVIDER, 'GoTo Logistics numbers are TKGTL and eleven letters and digits, or GTL and ten digits');
  }
  return number;
}

/** The number as GTL prints it and the tracking page sends it: a TKGTL number keeps its hyphen. */
export function gtlRequestNumber(raw: string): string {
  const number = normalizeGtlNumber(raw);
  return TKGTL.test(number) ? `TKGTL-${number.slice(5)}` : number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `GoTo Logistics returned an invalid ${key}`);
  return clean(value, maxLength);
}

// A run of nine or more digits, with spaces, brackets, dots or hyphens
// between them, as phone numbers are written; a date stays.
const PHONE = /(?<![A-Z\d])(?!\d{4}-\d{2}-\d{2}(?!\d))\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
// A delivery names who took the parcel after "oleh" or "by": "Paket sudah
// sampai dan diterima oleh …".
const HANDOVER = /\b(?:diterima|delivered|received)\b/i;
const RECEIVER = /\s*[,;:.\-–]?\s*\b(?:oleh|by|kepada|to)\b[\s\S]*$/i;

/** A scan's wording, without phone numbers or the person a delivery names. */
export function gtlWording(status: string): string {
  const own = HANDOVER.test(status) ? status.replace(RECEIVER, '') : status;
  return clean(own.replace(PHONE, '').replace(/\s+([,;:.])/g, '$1')).replace(/^[\s,;:.\-–]+|[\s,;:\-–]+$/g, '');
}

/**
 * A scan's clock, as the page reads it with `new Date()`: an ISO time with
 * an offset or epoch milliseconds is an instant, which the page shows in the
 * visitor's own zone. An ISO time without one is a wall clock whose zone the
 * reply does not give, and Indonesia has three, so it stays local.
 */
function scanClock(value: unknown): { time?: string; local_time?: string; order: number } {
  if (typeof value === 'number') {
    const instant = Number.isInteger(value) && value >= 1e12 ? epochMillisTime(value) : null;
    if (instant) return { time: instant.iso, order: instant.timestamp };
  } else if (typeof value === 'string') {
    const raw = clean(value, 40);
    if (EXPLICIT_OFFSET_PATTERN.test(raw)) {
      const instant = /^\d{4}-\d{2}-\d{2}T/.test(raw) ? explicitOffsetTime(raw) : null;
      if (instant) return { time: instant.iso, order: instant.timestamp };
    } else {
      const wall = WALL.exec(raw);
      const local = wall ? `${wall[1]}T${wall[2]}` : '';
      // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
      const parsed = DateTime.fromISO(local, { zone: 'UTC' });
      if (wall && parsed.isValid && parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") === local) return { local_time: local, order: parsed.toMillis() };
    }
  }
  throw new SchemaError(PROVIDER, 'GoTo Logistics returned an invalid scan time');
}

function projectRow(row: Record<string, unknown>): { key: string; order: number; event: CarrierEvent } {
  const description = gtlWording(text(row, 'status'));
  if (!description) throw new SchemaError(PROVIDER, 'GoTo Logistics returned a scan without wording');
  const code = text(row, 'status_code', 64);
  const { order, ...clock } = scanClock(row.date_time);
  // The page heads each scan with its hub; the archived reply had an empty `location` instead.
  const location = [text(row, 'hub_name', 120), text(row, 'location', 120)].find((place) => place && !/^-+$/.test(place)) ?? '';
  const staged = gtlStage(description, code || null);
  const event: CarrierEvent = {
    ...clock,
    ...(location ? { location } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([clock.time ?? clock.local_time, description, location]), order, event };
}

/**
 * The reply of the tracking page's lookup for one number. It answers HTTP 422
 * with code 5413 for a number it does not know, and code 200 with the
 * shipment for one it knows, which must name the number asked.
 */
export function parseGtl(payload: unknown, raw: string): CarrierResult {
  const number = normalizeGtlNumber(raw);
  if (!isRecord(payload) || !['number', 'string'].includes(typeof payload.code)) {
    throw new SchemaError(PROVIDER, 'GoTo Logistics returned an invalid envelope');
  }
  const code = cleanScalar(payload.code, 16);
  if (code !== '200') {
    if (code === String(GTL_NOT_FOUND) && payload.retryable !== true) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'GoTo Logistics did not complete the lookup');
  }
  const data = payload.data;
  // The page reports a success without a shipment as not found, but it names no number.
  if (data === null || data === undefined) throw new IndeterminateError(PROVIDER, 'GoTo Logistics answered without a shipment');
  if (!isRecord(data) || typeof data.awb !== 'string') throw new SchemaError(PROVIDER, 'GoTo Logistics returned a shipment without its number');
  const awb = data.awb.length <= 64 ? normalizeTrackingNumber(data.awb) : '';
  if (awb !== number) throw new IndeterminateError(PROVIDER, 'GoTo Logistics answered for another shipment');
  const rows = data.history ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'GoTo Logistics returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'GoTo Logistics returned an oversized history');

  const seen = new Set<string>();
  const scans: { order: number; event: CarrierEvent }[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'GoTo Logistics returned an invalid scan');
    const scan = projectRow(row);
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    scans.push(scan);
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the page lists them; an oldest-first reply is turned round.
  if (scans[0]!.order < scans.at(-1)!.order) scans.reverse();
  const events = scans.map((scan) => scan.event);

  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  const stage = scanned?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: scanned!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
