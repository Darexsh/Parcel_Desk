import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { flashExpressResult, flashExpressWording, type FlashExpressScan } from '../flash-express/parser.js';
import { flashExpressPhStage } from './status.js';

export const PROVIDER = 'Flash Express Philippines';
// A long history is a few dozen kilobytes.
export const FLASH_EXPRESS_PH_MAX_BYTES = 512 * 1024;
// P, four digits, six or seven letters and digits and a letter.
const NUMBER = /^P\d{4}[0-9A-Z]{6,7}[A-Z]$/;
// The tracking page shows each scan on Manila's clock; the Philippines keeps one offset all year.
const ZONE = 'Asia/Manila';
// Unix seconds from 2001 to 2286: milliseconds or a date would be a changed reply.
const MIN_SECONDS = 1_000_000_000;
const MAX_SECONDS = 9_999_999_999;
// How the service words a refusal to answer more requests.
const THROTTLED = /too many|too frequent|frequently|rate limit|频繁/i;
// Scans that send the parcel back to its sender: the scans after them are the trip back.
const RETURN_STARTS = new Set(['PENDING_RETURN', 'SYSTEM_AUTO_RETURN']);
// The return's wording names where it went back to, which is the sender.
const RETURNED_AT = /\breturned\s+at\s+[^.]*\./i;
// The tracker's older courier wording went on to name the courier, with an id
// and a masked phone number, up to the place.
const COURIER = /\s*Courier information[\s\S]*?(?=\s*[,，]\s*【|$)/i;
const MAX_ROWS = 500;

/** A number for Flash Express Philippines' tracker, in upper case; anything else is not one it issues. */
export function normalizeFlashExpressPhNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Flash Express Philippines numbers are P, four digits, then letters and digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 500): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Flash Express Philippines returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A scan's instant from its Unix seconds, on Manila's clock. */
function scanTime(row: Record<string, unknown>): { time: string; at: number } {
  const seconds = row.routed_at;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < MIN_SECONDS || seconds > MAX_SECONDS) {
    throw new SchemaError(PROVIDER, 'Flash Express Philippines returned an invalid scan time');
  }
  const instant = DateTime.fromMillis(Math.floor(seconds) * 1000, { zone: ZONE });
  return { time: instant.toISO({ suppressMilliseconds: true })!, at: instant.toMillis() };
}

function projectRow(row: Record<string, unknown>): (FlashExpressScan & { code: string }) | null {
  const code = text(row, 'route_action', 64);
  const message = text(row, 'message', 1000).replace(COURIER, '');
  const { description, location } = flashExpressWording(code === 'PENDING_RETURN' ? message.replace(RETURNED_AT, 'returned.') : message,
    code, { provinceFirst: true });
  if (!description) throw new SchemaError(PROVIDER, 'Flash Express Philippines returned a scan without wording');
  // A linehaul van scan can come with a dash for its wording, which says nothing.
  if (!/[\p{L}\p{N}]/u.test(description)) return null;
  const { time, at } = scanTime(row);
  const staged = flashExpressPhStage(code, description);
  const event: CarrierEvent & { time: string; description: string } = {
    time,
    ...(location ? { location } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { event, at, code };
}

/**
 * Marks the trip back once the parcel is sent back to its sender: the scans
 * from then on keep their codes, and its delivery is the return.
 */
function markReturnLeg(scans: readonly (FlashExpressScan & { code: string })[]): void {
  const started = Math.min(...scans.filter((scan) => RETURN_STARTS.has(scan.code)).map((scan) => scan.at));
  for (const { event, at } of scans) {
    if (at < started) continue;
    Object.assign(event, { provider_leg: 'return' }, event.stage === 'delivered' ? { stage: 'returned', stage_source: 'carrier_map' } : {});
  }
}

/**
 * The reply of the app's `parcels/track_parcel_batch` for one number. It
 * answers HTTP 200 with `code` 1 and `data`, one entry per number asked, which
 * echoes the number in `pno`. A known parcel has its state and its scans,
 * newest first; an unknown number has neither. Only an entry for the whole
 * number asked is read.
 */
export function parseFlashExpressPh(payload: unknown, raw: string): CarrierResult {
  const number = normalizeFlashExpressPhNumber(raw);
  if (!isRecord(payload) || !Object.hasOwn(payload, 'code')) throw new SchemaError(PROVIDER, 'Flash Express Philippines returned an invalid envelope');
  if (payload.code !== 1) {
    if (THROTTLED.test(cleanScalar(payload.message, 200))) throw new RateLimitedError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Flash Express Philippines did not complete the lookup');
  }
  const data = payload.data;
  if (!Array.isArray(data)) throw new SchemaError(PROVIDER, 'Flash Express Philippines returned a reply without parcels');
  if (data.some((entry) => !isRecord(entry) || typeof entry.pno !== 'string')) {
    throw new SchemaError(PROVIDER, 'Flash Express Philippines returned a parcel without its number');
  }
  const entry = (data as Record<string, unknown>[]).find((candidate) => clean(candidate.pno, 64) === number);
  if (!entry) throw new IndeterminateError(PROVIDER, 'Flash Express Philippines did not answer for the parcel');
  if (entry.state !== undefined && entry.state !== null && typeof entry.state !== 'number') {
    throw new SchemaError(PROVIDER, 'Flash Express Philippines returned an invalid state');
  }
  const rows = entry.parcel_routes ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Flash Express Philippines returned a parcel with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Flash Express Philippines returned an oversized history');
  // An unknown number comes back with nothing but itself.
  if (typeof entry.state !== 'number' && !rows.length) throw new NotFoundError(PROVIDER);

  const scans = rows.flatMap((row) => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Flash Express Philippines returned an invalid scan');
    return projectRow(row) ?? [];
  });
  markReturnLeg(scans);
  return flashExpressResult(PROVIDER, scans, typeof entry.state === 'number' ? entry.state : undefined);
}
