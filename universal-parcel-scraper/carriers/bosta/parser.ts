import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryTimeZone, explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { bostaStage, bostaSummaryStage } from './status.js';

export const PROVIDER = 'Bosta';
// A long history is under ten kilobytes.
export const BOSTA_MAX_BYTES = 256 * 1024;
// Shipments have seven to ten digits and draft orders fewer. The service keeps
// them as integers, so none starts with a zero.
const NUMBER = /^[1-9]\d{3,9}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
// Before the merchant hands the order over, the page promises nothing yet.
const INITIAL = new Set([10, 11]);
// A courier on the way to the customer: the page says the order arrives today.
const OUT_TODAY = new Set([22, 40, 41]);
const FINAL: ReadonlySet<Stage> = new Set(['delivered', 'returned', 'exception']);
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A Bosta number: its digits, without a leading zero; anything else is not one Bosta issues. */
export function normalizeBostaNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Bosta numbers are four to ten digits without a leading zero');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Bosta returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A state code: a whole number, or nothing. */
function code(row: Record<string, unknown>): number | undefined {
  const value = row.code;
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new SchemaError(PROVIDER, 'Bosta returned an invalid state code');
  return value;
}

/** A scan's or a state's moment: an ISO instant in UTC, as the page reads it. */
function instant(row: Record<string, unknown>): { iso: string; timestamp: number } {
  const raw = text(row, 'timestamp', 40);
  const parsed = INSTANT.test(raw) ? explicitOffsetTime(raw) : null;
  if (!parsed) throw new SchemaError(PROVIDER, 'Bosta returned an invalid scan time');
  return parsed;
}

/** The shipment's own number: a string, or the integer a draft order carries. */
function shipmentNumber(payload: Record<string, unknown>): string {
  const value = payload.TrackingNumber;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string') return normalizeTrackingNumber(clean(value, 64));
  throw new SchemaError(PROVIDER, 'Bosta returned a shipment without its number');
}

interface Scan {
  readonly event: CarrierEvent;
  readonly timestamp: number;
  readonly code: number | undefined;
}

function projectRow(row: Record<string, unknown>): { key: string; scan: Scan } {
  const description = text(row, 'state');
  if (!description) throw new SchemaError(PROVIDER, 'Bosta returned a scan without wording');
  const state = code(row);
  const { iso, timestamp } = instant(row);
  const staged = bostaStage(state, description);
  const event: CarrierEvent = {
    time: iso,
    description,
    ...(state === undefined ? {} : { provider_code: String(state) }),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([iso, state, description]), scan: { event, timestamp, code: state } };
}

/** A calendar day from an instant, read in the destination's zone, or from a plain date. */
function day(value: unknown, zone: string): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (DAY.test(raw)) return DateTime.fromISO(raw, { zone: 'UTC' }).isValid ? raw : null;
  const parsed = INSTANT.test(raw) ? explicitOffsetTime(raw) : null;
  return parsed ? DateTime.fromMillis(parsed.timestamp, { zone }).toISODate() : null;
}

/**
 * The day the page promises: none before the merchant hands the order over,
 * the day the courier went out while it is out, else the promised day, or a
 * range up to a later working day when the reply gives one.
 */
function estimate(payload: Record<string, unknown>, current: Record<string, unknown>, zone: string):
  Pick<CarrierResult, 'expected_delivery' | 'expected_delivery_from'> {
  const state = code(current);
  if (state !== undefined && INITIAL.has(state)) return { expected_delivery: null };
  if (state !== undefined && OUT_TODAY.has(state)) return { expected_delivery: day(current.timestamp, zone) };
  const promised = day(payload.PromisedDate, zone);
  const later = promised ? day(payload.nextWorkingDayAfterScheduledAt, zone) : null;
  if (promised && later && later > promised) return { expected_delivery_from: promised, expected_delivery: later };
  return { expected_delivery: promised };
}

/**
 * The reply of the tracking page's `GET /shipments/track/{number}` for one
 * number. An unknown number is HTTP 404, which the adapter reads before this.
 * The service also answers some numbers with another shipment, so a reply
 * counts only when it names the number asked. A draft order the merchant has
 * not confirmed is not a shipment and has no history. The merchant's id is
 * never read.
 */
export function parseBosta(payload: unknown, raw: string): CarrierResult {
  const number = normalizeBostaNumber(raw);
  if (!isRecord(payload) || !isRecord(payload.CurrentStatus)) throw new SchemaError(PROVIDER, 'Bosta returned an invalid reply');
  if (shipmentNumber(payload) !== number) throw new IndeterminateError(PROVIDER, 'Bosta answered for another shipment');
  if (payload.isDraftOrder === true) throw new NoHistoryError(PROVIDER, 'Bosta has only a draft order under review for the number', { reason: 'no_history' });
  const current = payload.CurrentStatus;
  const rows = payload.TransitEvents ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Bosta returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Bosta returned an oversized history');

  const seen = new Set<string>();
  const scans: Scan[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Bosta returned an invalid scan');
    const { key, scan } = projectRow(row);
    if (seen.has(key)) continue;
    seen.add(key);
    scans.push(scan);
  }
  // Newest first, as the page sorts them by their instants.
  if (listsNewestFirst(scans.map(({ event }) => event)) === false) scans.reverse();
  scans.sort((a, b) => b.timestamp - a.timestamp);

  const country = text(payload, 'deliveryCountryCode', 8).toUpperCase();
  const destination = /^[A-Z]{2}$/.test(country) ? country : '';
  const zone = (destination && countryTimeZone(destination)) || 'Africa/Cairo';
  const state = code(current);
  const label = text(current, 'state', 120);
  // A return the merchant's order turned into: the page shows it as cancelled.
  const returning = text(payload, 'Type', 40).toUpperCase() === 'RTO';
  const summary = bostaSummaryStage(state);
  const facts = destination ? { destination_country: destination } : {};

  if (!scans.length) {
    // Older shipments keep only their current state, which the page shows alone.
    const staged = label ? bostaStage(state, label) : null;
    const stage = summary ?? (returning ? 'returned' : staged?.stage);
    if (!label || !stage) throw new NoHistoryError(PROVIDER);
    const { iso } = instant(current);
    return {
      status: languageStageStatus(stage), current_stage: stage, current_stage_source: 'carrier_map',
      last_status_text: label, ...(state === undefined ? {} : { provider_code: String(state) }),
      last_update: iso, ...(FINAL.has(stage) ? { expected_delivery: null } : estimate(payload, current, zone)),
      ...(state === 45 ? { delivered_at: iso } : {}),
      ...facts, summary_only: true, events: [],
    };
  }

  const events = scans.map((scan) => scan.event);
  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  const stage = summary ?? (returning ? 'returned' : scanned?.stage as Stage | undefined);
  const source = stage === scanned?.stage ? scanned?.stage_source : 'carrier_map';
  const delivery = stage === 'delivered' ? scans.find((scan) => scan.code === 45)?.event.time : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    ...(stage && FINAL.has(stage) ? { expected_delivery: null } : estimate(payload, current, zone)),
    ...(delivery ? { delivered_at: delivery } : {}),
    ...facts,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
