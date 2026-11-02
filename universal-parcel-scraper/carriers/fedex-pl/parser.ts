import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime, firstOccurrence } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { fedexPlStage, fedexPlSummaryStage } from './status.js';

export const PROVIDER = 'FedEx Poland';
export const FEDEX_PL_ZONE = 'Europe/Warsaw';
// A long history is a few kilobytes.
export const FEDEX_PL_MAX_BYTES = 256 * 1024;
// The tracking page's own check: thirteen digits.
const NUMBER = /^\d{13}$/;
// "2026-06-22T12:32:05+0200": the scan's instant, with the offset Poland had then.
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:?\d{2}$/;
// The courier's delivery window, which the page shows under the scan that gave the parcel to them.
const WINDOW = /^Planowane doręczenie w przedziale godzinowym (\d{2}):(\d{2}) ?- ?(\d{2}):(\d{2})\.?$/;
const OUT_FOR_DELIVERY = 'WK';
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A FedEx Poland domestic number: thirteen digits. Anything else is not one it issues. */
export function normalizeFedexPlNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'FedEx Poland domestic numbers are thirteen digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `FedEx Poland returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** An instant the service states with its offset, or null without one; any other form is a changed reply. */
function instant(row: Record<string, unknown>, key: string): { iso: string; timestamp: number } | null {
  const raw = text(row, key, 40);
  if (!raw) return null;
  const parsed = STAMP.test(raw) ? explicitOffsetTime(raw) : null;
  if (!parsed) throw new SchemaError(PROVIDER, `FedEx Poland returned an invalid ${key}`);
  return parsed;
}

interface Scan { event: CarrierEvent; timestamp: number; extra: string }

function projectRow(row: Record<string, unknown>): { key: string; scan: Scan } {
  const code = cleanScalar(row.eventCode, 16).toUpperCase();
  const description = text(row, 'eventName');
  if (!description) throw new SchemaError(PROVIDER, 'FedEx Poland returned a scan without wording');
  const when = instant(row, 'eventDate');
  if (!when) throw new SchemaError(PROVIDER, 'FedEx Poland returned a scan without its time');
  const location = text(row, 'depot', 120);
  const staged = fedexPlStage(code, description);
  const event: CarrierEvent = {
    time: when.iso,
    ...(location ? { location } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  // `argsExtra` holds the courier's delivery window on a WK scan; on others it
  // carries payment or proof-of-delivery details, which are not read.
  const extra = code === OUT_FOR_DELIVERY && typeof row.argsExtra === 'string' ? clean(row.argsExtra, 200) : '';
  return { key: JSON.stringify([when.timestamp, code, description, location]), scan: { event, timestamp: when.timestamp, extra } };
}

/** A wall clock on the scan's day in Poland, settled on its first occurrence. */
function polishTime(day: string, hour: string, minute: string): DateTime | null {
  const parsed = firstOccurrence(DateTime.fromISO(`${day}T${hour}:${minute}:00`, { zone: FEDEX_PL_ZONE }));
  return parsed.isValid && parsed.toFormat('HH:mm') === `${hour}:${minute}` ? parsed : null;
}

/** The window the courier's scan gives, on that scan's day, when it ends after the scan. */
function deliveryWindow(scan: Scan): Pick<CarrierResult, 'expected_delivery' | 'expected_delivery_from'> | null {
  const match = WINDOW.exec(scan.extra);
  if (!match) return null;
  const day = DateTime.fromMillis(scan.timestamp, { zone: FEDEX_PL_ZONE }).toFormat('yyyy-MM-dd');
  const from = polishTime(day, match[1]!, match[2]!);
  const to = polishTime(day, match[3]!, match[4]!);
  if (!from || !to || from.toMillis() >= to.toMillis() || to.toMillis() < scan.timestamp) return null;
  return { expected_delivery_from: from.toISO({ suppressMilliseconds: true }), expected_delivery: to.toISO({ suppressMilliseconds: true }) };
}

/**
 * The reply of the tracking service's `/info` for one number with HTTP 200.
 * The service answers an unknown number with an empty HTTP 204, which the
 * adapter reads before this. A reply counts only when its `trackingKey`, the
 * number the page shows as searched, is the number asked.
 */
export function parseFedexPl(payload: unknown, raw: string): CarrierResult {
  const number = normalizeFedexPlNumber(raw);
  if (!isRecord(payload) || !Object.hasOwn(payload, 'events')) throw new SchemaError(PROVIDER, 'FedEx Poland returned an invalid shipment');
  if (typeof payload.trackingKey !== 'string' || typeof payload.shipmentNo !== 'string' || !NUMBER.test(payload.shipmentNo)) {
    throw new SchemaError(PROVIDER, 'FedEx Poland returned a shipment without its number');
  }
  if (payload.trackingKey !== number) throw new IndeterminateError(PROVIDER, 'FedEx Poland answered for another number');
  const rows = payload.events ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'FedEx Poland returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'FedEx Poland returned an oversized history');

  const seen = new Set<string>();
  const scans: Scan[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'FedEx Poland returned an invalid scan');
    const { key, scan } = projectRow(row);
    if (seen.has(key)) continue;
    seen.add(key);
    scans.push(scan);
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the page lists them; a stable sort keeps the service's order within one second.
  if (listsNewestFirst(scans.map(({ event }) => event)) === false) scans.reverse();
  scans.sort((left, right) => right.timestamp - left.timestamp);
  const events = scans.map((scan) => scan.event);

  const newest = scans[0]!;
  const scanned = events.find((event) => event.stage);
  const summary = fedexPlSummaryStage(text(payload, 'status', 60));
  // The overall status settles a delivery the scans have not staged, unless the newest staged scan is
  // the return to the sender; otherwise that scan decides.
  const stage = (summary === 'delivered' && scanned?.stage !== 'returned' ? summary : scanned?.stage ?? summary) as Stage | undefined;
  const source = stage && stage !== scanned?.stage ? 'carrier_map' : scanned?.stage_source;
  const delivered = stage === 'delivered'
    ? instant(payload, 'deliveryDate')?.iso ?? events.find((event) => event.stage === 'delivered')?.time ?? null : null;
  const window = stage === 'out_for_delivery' && newest.event.provider_code === OUT_FOR_DELIVERY ? deliveryWindow(newest) : null;
  const weight = typeof payload.weight === 'number' && Number.isFinite(payload.weight) && payload.weight > 0 ? payload.weight : null;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: newest.event.description!,
    last_update: newest.event.time!,
    expected_delivery: window?.expected_delivery ?? null,
    ...(window ? { expected_delivery_from: window.expected_delivery_from } : {}),
    ...(delivered ? { delivered_at: delivered } : {}),
    ...(weight ? { weight_kg: weight } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
