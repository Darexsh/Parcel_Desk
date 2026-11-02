import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { rivigoStage } from './status.js';

export const PROVIDER = 'Rivigo';
// A consignment's reply lists every scan with the staff who made it; a long history stays well under this.
export const RIVIGO_MAX_BYTES = 1024 * 1024;
// Ten digits, as Rivigo's consignment notes print them.
const NUMBER = /^\d{10}$/;
// The tracker's notice for a number it holds no consignment under.
const NO_MATCH = /^please check the cnote number entered\.?$/i;
// The notice for a consignment it holds but shows no tracking for, as for every public sample.
const WITHHELD = /^tracking of this consignment is not available\.?$/i;
const MAX_ROWS = 500;
// Scan clocks are epoch milliseconds; anything outside these years is not a clock.
const EARLIEST = Date.UTC(2000, 0, 1);
const LATEST = Date.UTC(2100, 0, 1);

/** A ten-digit consignment number; anything else is not one Rivigo issues. */
export function normalizeRivigoNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Rivigo consignment numbers are ten digits');
  return number;
}

function invalid(message: string): never {
  throw new SchemaError(PROVIDER, message);
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') invalid(`Rivigo returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** An optional object field. */
function record(row: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (!isRecord(value)) invalid(`Rivigo returned an invalid ${key}`);
  return value;
}

/** Epoch milliseconds, the platform's clock for scans and dates; null when absent. */
function epoch(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < EARLIEST || value >= LATEST) {
    invalid('Rivigo returned an invalid time');
  }
  return value;
}

function instant(at: number): string {
  return DateTime.fromMillis(at, { zone: 'utc' }).startOf('second').toISO({ suppressMilliseconds: true })!;
}

interface Scan { at: number; index: number; key: string; event: CarrierEvent }

/**
 * A scan, or null without a time or wording. Its `activity` is the wording,
 * else its `status` code with spaces; its place is the `city` the public page
 * shows. The staff who scanned, their phones, vehicles and remarks are not read.
 */
function projectRow(row: unknown, index: number): Scan | null {
  if (!isRecord(row)) invalid('Rivigo returned an invalid scan');
  const at = epoch(row.dateAndTime);
  const code = text(row, 'status', 60).toUpperCase();
  const description = text(row, 'activity', 300) || code.replaceAll('_', ' ');
  if (at === null || !description) return null;
  const location = text(row, 'city', 120);
  const staged = rivigoStage(code, description);
  const event: CarrierEvent = {
    time: instant(at),
    ...(location ? { location } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { at, index, key: JSON.stringify([at, code, description.toLowerCase(), location]), event };
}

/** The estimate, a day in India, where the whole network is. */
function estimate(payload: Record<string, unknown>): string | null {
  const value = payload.edd;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < EARLIEST || value >= LATEST) return null;
  return DateTime.fromMillis(value, { zone: 'Asia/Kolkata' }).toISODate();
}

/**
 * The reply of Zoom's consignment lookup, which the public tracking page
 * makes: `{status, payload}` on success, `{status: "FAILURE", errorMessage}`
 * otherwise. A number Rivigo holds nothing under answers `Please check the
 * cnote number entered.`; a consignment whose tracking it withholds answers
 * `Tracking of this consignment is not available`, which is inconclusive. The
 * payload must name the number asked. Its `transitHistory` lists scans oldest
 * first, each with an epoch time; when the newest is a vehicle's leg
 * (`INTRANSIT`), its time is the leg's arrival estimate, as the page labels
 * it, and it is left out. The consignor, consignee, their addresses and
 * phones, the invoice, the proof of delivery and the failed attempts' contacts
 * are never read.
 */
export function parseRivigo(reply: unknown, raw: string): CarrierResult {
  const number = normalizeRivigoNumber(raw);
  if (!isRecord(reply)) invalid('Rivigo returned an invalid reply');
  if (reply.status === 'FAILURE') {
    const notice = clean(reply.errorMessage, 200);
    if (NO_MATCH.test(notice)) throw new NotFoundError(PROVIDER, 'Rivigo has no consignment under this number');
    if (WITHHELD.test(notice)) {
      throw new IndeterminateError(PROVIDER, 'Rivigo holds the consignment but does not show its tracking', { reason: 'tracking_withheld' });
    }
    invalid('Rivigo answered with an unknown notice');
  }
  if (reply.status !== 'SUCCESS') invalid('Rivigo returned a reply without its status');
  const payload = reply.payload;
  if (!isRecord(payload)) invalid('Rivigo returned a reply without its consignment');

  const consignment = record(payload, 'consignmentDto');
  const named = [payload.cnote, consignment?.cnote].filter((value) => value !== null && value !== undefined);
  if (!named.length) invalid('Rivigo returned a consignment without its number');
  for (const value of named) {
    if (typeof value !== 'string' && typeof value !== 'number') invalid('Rivigo returned an invalid consignment number');
    if (normalizeTrackingNumber(cleanScalar(value, 64)) !== number) throw new IndeterminateError(PROVIDER, 'Rivigo answered for another consignment');
  }

  const rows = payload.transitHistory ?? [];
  if (!Array.isArray(rows)) invalid('Rivigo returned a consignment with invalid scans');
  if (rows.length > MAX_ROWS) invalid('Rivigo returned an oversized history');
  // The newest row of a vehicle's leg carries its arrival estimate, not a scan.
  const last = rows.at(-1) as unknown;
  const scanned = isRecord(last) && last.activityType === 'INTRANSIT' ? rows.slice(0, -1) : rows;

  const seen = new Set<string>();
  const scans: Scan[] = [];
  scanned.forEach((row: unknown, index) => {
    const scan = projectRow(row, index);
    if (!scan || seen.has(scan.key)) return;
    seen.add(scan.key);
    scans.push(scan);
  });
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first; the reply lists the oldest first, so of two scans at one instant the later row is newer.
  const events = scans.sort((a, b) => b.at - a.at || b.index - a.index).map((scan) => scan.event);

  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  let stage = current?.stage as Stage | undefined;
  // Boxes split off under child consignments keep a delivery partial, as the page says.
  const children = record(payload, 'externalChildCnDto')?.childCnotes;
  const partial = (Array.isArray(children) && children.length > 0)
    || [payload.status, consignment?.status].some((status) => status === 'PARTIALLY_DELIVERED');
  if (partial && stage === 'delivered') stage = 'in_transit';
  // A return consignment raised for this one is the freight going back to the consignor.
  const reverse = record(payload, 'reverseMovementDTO');
  if (reverse && text(reverse, 'consignmentMovementType', 20) === 'RETURN' && stage !== 'delivered') stage = 'returned';
  const source = stage && stage !== current?.stage ? 'carrier_map' : current?.stage_source;
  const handedOn = typeof payload.lfTrackingUrl === 'string' && payload.lfTrackingUrl.trim() !== '';
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: stage === 'delivered' || stage === 'returned' ? null : estimate(payload),
    ...(stage === 'delivered' ? { delivered_at: current!.time! } : {}),
    // With this link the page shows only the newer part of the history and links the earlier part.
    ...(handedOn ? { history_truncated: true } : {}),
    events,
  };
}
