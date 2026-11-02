import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { skroutzStage } from './status.js';

export const PROVIDER = 'Skroutz Last Mile';
// A long history is a few kilobytes.
export const SKROUTZ_MAX_BYTES = 512 * 1024;

const NUMBER = /^[A-Z0-9]{13}$/;
// Greece's zone. Cyprus, the other country served, keeps the same offsets.
const ZONE = 'Europe/Athens';
// The reply's clocks are UTC instants, to the millisecond.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
// The estimates' clocks: instants in UTC or at an offset. A planned day is noon on that day.
const ESTIMATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
// The overall states the page shows no delivery estimate for.
const SETTLED = new Set(['delivered', 'at_locker', 'lost_or_damaged']);
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A Skroutz Last Mile voucher: thirteen capital letters and digits. */
export function normalizeSkroutzNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Skroutz Last Mile vouchers are thirteen letters and digits');
  return number;
}

/** A text field, required unless `optional`; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 500, optional = false): string {
  const value = row[key];
  if (optional && (value === null || value === undefined)) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Skroutz Last Mile returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** An instant at Greece's offset, or null when the value is not one in `form`. */
function instant(value: unknown, form = INSTANT): { iso: string; timestamp: number } | null {
  const parsed = typeof value === 'string' && form.test(value) ? DateTime.fromISO(value, { setZone: true }) : null;
  if (!parsed?.isValid) return null;
  return { iso: parsed.setZone(ZONE).toISO({ suppressMilliseconds: true })!, timestamp: parsed.toMillis() };
}

interface Scan { key: string; timestamp: number; event: CarrierEvent }

/**
 * One row of `trackingDetails`. The page shows the Greek or English wording
 * and the moment; a row without either wording is hidden. The `notes` beside
 * it hold the hub again, the courier's remarks and, on a delivery, where the
 * courier stood: the page never shows them, and they are not read.
 */
function projectRow(row: Record<string, unknown>): Scan | null {
  if (typeof row.description_en !== 'string' && typeof row.description_gr !== 'string') {
    throw new SchemaError(PROVIDER, 'Skroutz Last Mile returned a scan without wording');
  }
  const english = text(row, 'description_en', 500, true);
  const greek = text(row, 'description_gr', 500, true);
  const code = text(row, 'trackingState', 80, true).toUpperCase();
  const clock = instant(row.createdAt);
  if (!clock) throw new SchemaError(PROVIDER, 'Skroutz Last Mile returned an invalid scan time');
  const description = english || greek;
  if (!description) return null;
  const staged = skroutzStage(code, english, greek);
  const event: CarrierEvent = {
    time: clock.iso,
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([clock.timestamp, code, description]), timestamp: clock.timestamp, event };
}

/**
 * The estimate the page shows while the parcel is on its way: the window of
 * the courier's round, else the day planned for it. It shows none once the
 * parcel is delivered, in a locker, lost, cancelled or with another courier.
 */
function estimate(payload: Record<string, unknown>, stage: Stage | undefined): Pick<CarrierResult, 'expected_delivery' | 'expected_delivery_from'> {
  const status = typeof payload.status === 'string' ? payload.status : '';
  if (SETTLED.has(status) || payload.isCompleteCancelled === true || payload.thirdPartyCourier || payload.thirdPartyTrackingUrl
    || (stage && ['delivered', 'ready_for_pickup', 'returned'].includes(stage))) return { expected_delivery: null };
  if (isRecord(payload.eta)) {
    const from = instant(payload.eta.startTime, ESTIMATE);
    const to = instant(payload.eta.endTime, ESTIMATE);
    if (from && to && from.timestamp <= to.timestamp) return { expected_delivery_from: from.iso, expected_delivery: to.iso };
  }
  const planned = instant(payload.expectedDayOfDelivery, ESTIMATE);
  return { expected_delivery: planned ? planned.iso.slice(0, 10) : null };
}

/**
 * The reply of `api.sendx.gr/user/hp/{voucher}`, which Skroutz Last Mile's
 * tracking page reads. An unknown voucher is HTTP 400 with a plain-text
 * notice, handled before this. The reply names no voucher: the service
 * matches the whole voucher in its path, case included.
 */
export function parseSkroutz(payload: unknown, raw: string): CarrierResult {
  normalizeSkroutzNumber(raw);
  // The page's own check: an overall state and a list of scans.
  if (!isRecord(payload) || typeof payload.status !== 'string' || !payload.status.trim()) {
    throw new SchemaError(PROVIDER, 'Skroutz Last Mile returned an invalid envelope');
  }
  const rows = payload.trackingDetails;
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Skroutz Last Mile returned a parcel with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Skroutz Last Mile returned an oversized history');

  const seen = new Set<string>();
  const scans: Scan[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Skroutz Last Mile returned an invalid scan');
    const scan = projectRow(row);
    if (!scan || seen.has(scan.key)) continue;
    seen.add(scan.key);
    scans.push(scan);
  }

  if (!scans.length) {
    // The page reads a voucher without scans as "Route created / Awaiting pickup".
    const status = text(payload, 'statusTextEn', 200, true) || text(payload, 'statusTextGr', 200, true);
    return {
      status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map',
      last_status_text: status || null, last_update: null, ...estimate(payload, 'registered'), summary_only: true, events: [],
    };
  }
  // Newest first; scans at the same moment keep the reply's order, oldest first.
  const events = scans.reverse().sort((a, b) => b.timestamp - a.timestamp).map((scan) => scan.event);
  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  const stage = scanned?.stage as Stage | undefined;
  const delivered = stage === 'delivered' ? scanned : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: scanned!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    ...estimate(payload, stage),
    ...(delivered ? { delivered_at: delivered.time! } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
