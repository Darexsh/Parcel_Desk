import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { saiaShipmentStage, saiaStage, saiaTerminalActivity } from './status.js';

export const PROVIDER = 'Saia';
export const SAIA_ORIGIN = 'https://www.saia.com';
// A shipment's reply is a few kilobytes.
export const SAIA_MAX_BYTES = 1_000_000;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
const POUNDS_TO_KG = 0.453_592_37;
// The page's twelve-hour clock: hour 00 and hour 13 are no reading of it.
const CLOCK = /^(0[1-9]|1[0-2]):([0-5]\d) ?([AP])M$/i;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const WINDOW_CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
// Stages after which the tracker shows no estimate.
const FINAL: ReadonlySet<Stage> = new Set(['delivered', 'returned']);

/**
 * A PRO number as Saia's tracker takes it: eleven digits, or twelve, of which
 * the tracker looks up the first eleven.
 */
export function normalizeSaiaNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^\d{11,12}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Saia PRO numbers are eleven or twelve digits');
  return number;
}

/** The PRO the tracker sends: the number's first eleven digits. */
export function saiaPro(raw: string): string {
  return normalizeSaiaNumber(raw).slice(0, 11);
}

/** An eleven-digit PRO, the only form a reply binds as a whole. */
export function normalizeSaiaRecognitionNumber(raw: string): string {
  const number = normalizeSaiaNumber(raw);
  if (number.length !== 11) throw new InvalidInputError(PROVIDER, 'Saia answers a twelve-digit number for its first eleven digits');
  return number;
}

/** The tracker's details page for a PRO, the address its search opens. */
export function saiaTrackingUrl(raw: string): string {
  return `${SAIA_ORIGIN}/track/details;pro=${saiaPro(raw)}`;
}

/** An optional text field; an object, array or number is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Saia returned an invalid ${key}`);
  return clean(value, maxLength);
}

function dayOf(value: string): string | null {
  const match = DAY.exec(value);
  return match ? calendarDay(Number(match[1]), Number(match[2]), Number(match[3])) : null;
}

/**
 * A row's clock: its date and its twelve-hour time as an offset-less wall
 * clock, or its date alone without a time. The page prints "N/A" for the date
 * the service sends as "Invalid date"; such a row keeps no clock.
 */
function clockOf(row: Record<string, unknown>): { local_time?: string } {
  const date = text(row, 'date', 32);
  const time = text(row, 'time', 32);
  if (!date || date === 'Invalid date') return {};
  const day = dayOf(date);
  if (!day) throw new SchemaError(PROVIDER, 'Saia returned an invalid history date');
  if (!time) return { local_time: day };
  const match = CLOCK.exec(time);
  if (!match) throw new SchemaError(PROVIDER, 'Saia returned an invalid history time');
  const hour = (Number(match[1]) % 12) + (match[3]!.toUpperCase() === 'P' ? 12 : 0);
  return { local_time: `${day}T${String(hour).padStart(2, '0')}:${match[2]}:00` };
}

/**
 * One history row: its activity, which is the provider code, its local clock
 * and, for a terminal's activity, the terminal's city and state. At the
 * customer's site the city is the customer's, so those rows keep none. The
 * page leaves out a row without an activity.
 */
function eventOf(value: unknown): CarrierEvent | null {
  if (!isRecord(value)) throw new SchemaError(PROVIDER, 'Saia returned an invalid history row');
  const activity = text(value, 'activity');
  if (!activity) return null;
  const event: CarrierEvent = { ...clockOf(value), description: activity, provider_code: activity };
  const city = text(value, 'city', 80);
  const state = text(value, 'state', 8);
  if (saiaTerminalActivity(activity) && city && /^[A-Z]{2}$/.test(state)) event.location = `${city}, ${state}`;
  const staged = saiaStage(activity);
  if (staged) Object.assign(event, { stage: staged.stage, stage_source: staged.source });
  return event;
}

/**
 * The tracker's estimate while the freight is on its way: the day, with the
 * window the page prints after it. Its clocks have no offset, so it stays on
 * the destination's own clock, as text: `YYYY-MM-DD HH:mm–HH:mm`, the day and
 * a single time, or the day alone. A day before the newest scan's is stale,
 * as is the customer-service notice the service sends in its place.
 */
function estimate(delivery: Record<string, unknown>, newestDay: string | null): string | null {
  const day = dayOf(text(delivery, 'expectedDeliveryDate', 80));
  if (!day || (newestDay && day < newestDay)) return null;
  const window = isRecord(delivery.expectedDeliveryTime) ? delivery.expectedDeliveryTime : {};
  const from = text(window, 'from', 40);
  const to = text(window, 'to', 40);
  if (!WINDOW_CLOCK.test(from)) return day;
  return WINDOW_CLOCK.test(to) && from < to ? `${day} ${from}–${to}` : `${day} ${from}`;
}

/** The shipment's weight in pounds, as kilograms. */
function weightKg(shipment: Record<string, unknown>): number | null {
  const pounds = Number(text(shipment, 'totalWeight', 16).replace(/,/g, ''));
  return Number.isFinite(pounds) && pounds > 0 && pounds < 1_000_000 ? Math.round(pounds * POUNDS_TO_KG * 1000) / 1000 : null;
}

/**
 * The reply of `find-full-details` on Saia's tracking service: the shipment
 * named by its PRO, its status and estimate, and its history newest first,
 * kept in the service's order since the clocks are each terminal's own. The
 * shipper and consignee, the line items, references, the delivery signature,
 * the driver and trailer, the terminals' addresses and contacts and the
 * partner carriers' details are never read.
 */
export function parseSaia(payload: unknown, raw: string): CarrierResult {
  const number = normalizeSaiaNumber(raw);
  const pro = number.slice(0, 11);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Saia returned an unexpected reply');
  const named = text(payload, 'proNumber', 32);
  if (!named) throw new SchemaError(PROVIDER, 'Saia returned a shipment without its PRO');
  if (named !== pro) throw new IndeterminateError(PROVIDER, 'Saia answered for another PRO');
  const shipment = payload.shipmentInformation;
  const delivery = payload.deliveryInformation;
  if (!isRecord(shipment) || !isRecord(delivery)) throw new SchemaError(PROVIDER, 'Saia returned a shipment without its status');
  const history = payload.history ?? [];
  if (!Array.isArray(history) || history.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Saia returned an invalid history');

  const seen = new Set<string>();
  const events = history.map(eventOf).filter((event): event is CarrierEvent => {
    if (!event) return false;
    const key = JSON.stringify(event);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const summary = text(shipment, 'status', 80);
  const summaryStage = saiaShipmentStage(summary);
  const newest = events[0];
  if (!newest && !summaryStage) throw new NoHistoryError(PROVIDER);
  // The status the page shows decides; without one it knows, the newest scan the map or wording rules stage.
  const scanned = events.find((event) => event.stage);
  const stage = (summaryStage ?? scanned?.stage) as Stage | undefined;
  const source = summaryStage ? 'carrier_map' : scanned?.stage_source;
  const newestDay = typeof newest?.local_time === 'string' ? newest.local_time.slice(0, 10) : null;
  const weight = weightKg(shipment);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source } : {}),
    // A status the history does not show yet, such as the delivery, is newer than its scans.
    last_status_text: summaryStage && summaryStage !== scanned?.stage ? summary : newest?.description ?? summary,
    last_update: null,
    last_update_local: typeof newest?.local_time === 'string' ? newest.local_time : null,
    expected_delivery: stage && FINAL.has(stage) ? null : estimate(delivery, newestDay),
    ...(weight !== null ? { weight_kg: weight } : {}),
    ...(number !== pro ? { canonical_tracking_number: pro } : {}),
    ...(newest ? {} : { summary_only: true }),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}

/** The service's own answer that it has no shipment for this PRO: a 422 naming it. */
export function isSaiaNotFound(payload: unknown, pro: string): boolean {
  return isRecord(payload) && Object.keys(payload).length === 1
    && payload.error === `The Shipment was not found for PRO Number: ${pro}`;
}
