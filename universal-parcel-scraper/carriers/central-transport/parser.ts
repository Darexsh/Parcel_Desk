import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { centralTransportStage } from './status.js';

export const PROVIDER = 'Central Transport';
// A shipment's summary is about 2 kB and its history less.
export const CENTRAL_TRANSPORT_MAX_BYTES = 256 * 1024;

// A PRO number: nine digits, or ten or eleven, which the tracker prints with
// dashes (`000-0000000-0`). The tracker finds a PRO typed without them.
const PRO = /^\d{9,11}$/;
const SUMMARY_CLOCK = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}) ([AP]M)$/;
const DAY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const HISTORY_DAY = /^[A-Z][a-z]+, (\d{1,2}) ([A-Z][a-z]+) (\d{4})$/;
const HISTORY_TIME = /^(\d{1,2}):(\d{2}):(\d{2}) ([AP]M)$/;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November',
  'December'];
const POUNDS = /^\d{1,7}$/;
const POUNDS_TO_KG = 0.453_592_37;
const MAX_DAYS = 200;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
const NO_ESTIMATE: ReadonlySet<Stage> = new Set(['delivered', 'returned']);

/** A PRO number as the tracker takes it, digits only; anything else is not one Central Transport issues. */
export function normalizeCentralTransportNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!PRO.test(number)) throw new InvalidInputError(PROVIDER, 'Central Transport PRO numbers are nine to eleven digits');
  return number;
}

/** The body the tracking page posts to trace one PRO number, without its own form state. */
export function centralTransportTraceBody(raw: string): { data: { type: string; typeName: string; items: { id: number; number: string }[] } } {
  return { data: { type: '1', typeName: 'PRO', items: [{ id: 0, number: normalizeCentralTransportNumber(raw) }] } };
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Central Transport returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A PRO number as the reply writes it, with or without dashes, in digits. */
function digitsOf(value: string): string {
  return /^\d[\d-]{0,20}$/.test(value) ? value.replace(/-/g, '') : '';
}

/** A twelve-hour clock as 24-hour `HH:mm:ss`, or null. */
function hours(hour: string, minute: string, second: string, half: string): string | null {
  const value = Number(hour);
  if (value < 1 || value > 12 || Number(minute) > 59 || Number(second) > 59) return null;
  return `${String((value % 12) + (half === 'PM' ? 12 : 0)).padStart(2, '0')}:${minute}:${second}`;
}

/** The summary's status clock, `M/D/YYYY h:mm AM`, as a wall clock without an offset. */
function summaryClock(value: string): string | null {
  const match = SUMMARY_CLOCK.exec(value);
  if (!match) return null;
  const day = calendarDay(Number(match[3]), Number(match[1]), Number(match[2]));
  const clock = hours(match[4]!, match[5]!, '00', match[6]!);
  return day && clock ? `${day}T${clock}` : null;
}

/** A history row's clock: its day's heading (`Monday, 08 September 2025`) and its time (`08:52:29 AM`). */
function historyClock(date: string, time: string): string | null {
  const day = HISTORY_DAY.exec(date);
  const clock = HISTORY_TIME.exec(time);
  if (!day || !clock) return null;
  const iso = calendarDay(Number(day[3]), MONTHS.indexOf(day[2]!) + 1, Number(day[1]));
  const wall = hours(clock[1]!, clock[2]!, clock[3]!, clock[4]!);
  return iso && wall ? `${iso}T${wall}` : null;
}

/** What the trace says about the PRO: the key its history is filed under and its summary. */
export interface CentralTransportTrace {
  /** The PRO number as the tracker writes it. */
  pro: string;
  /** The tracker's own key for the shipment, which its history lookup asks for. */
  key: number;
  shipment: Record<string, unknown>;
}

/**
 * The reply of `GetTraceLegStatus` for one PRO number. The tracker answers a
 * PRO it does not know, and a failed lookup, with the same message to try
 * again later, so neither is a missing shipment. A shipment must name the
 * whole number asked.
 */
export function parseCentralTransportTrace(payload: unknown, raw: string): CentralTransportTrace {
  const number = normalizeCentralTransportNumber(raw);
  const trace = isRecord(payload) ? payload.d : undefined;
  if (!isRecord(trace) || typeof trace.ServerResponseFailed !== 'boolean' || !Array.isArray(trace.ShipmentInfo)) {
    throw new SchemaError(PROVIDER, 'Central Transport returned an invalid trace');
  }
  if (trace.ServerResponseFailed) throw new IndeterminateError(PROVIDER, 'Central Transport could not trace the PRO number');
  const shipments: unknown[] = trace.ShipmentInfo;
  if (!shipments.length) throw new IndeterminateError(PROVIDER, 'Central Transport traced no shipment for the PRO number');
  if (shipments.length > 1) throw new IndeterminateError(PROVIDER, 'Central Transport traced several shipments for the PRO number');
  const shipment = shipments[0];
  if (!isRecord(shipment) || typeof shipment.ProNumber !== 'string') {
    throw new SchemaError(PROVIDER, 'Central Transport returned a shipment without its PRO number');
  }
  const pro = clean(shipment.ProNumber, 24);
  if (digitsOf(pro) !== number) throw new IndeterminateError(PROVIDER, 'Central Transport answered for another shipment');
  const key = shipment.ProNumKey;
  if (typeof key !== 'number' || !Number.isSafeInteger(key) || key <= 0) {
    throw new SchemaError(PROVIDER, 'Central Transport returned a shipment without its key');
  }
  if (typeof shipment.IsDelivered !== 'boolean') throw new SchemaError(PROVIDER, 'Central Transport returned a shipment without its delivery flag');
  return { pro, key, shipment };
}

/**
 * The reply of `GetTrackDetails` for the shipment's key: its scans, grouped by
 * day, newest day first. The lookup echoes the PRO number it is sent, and
 * names none when it has no row.
 */
export function parseCentralTransportHistory(payload: unknown, raw: string): CarrierEvent[] {
  const number = normalizeCentralTransportNumber(raw);
  const details = isRecord(payload) ? payload.d : undefined;
  if (!isRecord(details) || !Array.isArray(details.TrackingHistories)) {
    throw new SchemaError(PROVIDER, 'Central Transport returned an invalid history');
  }
  const days = details.TrackingHistories;
  if (details.ProNumber === null && !days.length) return [];
  if (typeof details.ProNumber !== 'string' || digitsOf(clean(details.ProNumber, 24)) !== number) {
    throw new IndeterminateError(PROVIDER, 'Central Transport returned the history of another shipment');
  }
  if (days.length > MAX_DAYS) throw new SchemaError(PROVIDER, 'Central Transport returned an oversized history');
  let rows = 0;
  const listed = days.map((day) => {
    if (!isRecord(day) || !Array.isArray(day.HistoryItems)) throw new SchemaError(PROVIDER, 'Central Transport returned an invalid history day');
    rows += day.HistoryItems.length;
    if (rows > MAX_ROWS) throw new SchemaError(PROVIDER, 'Central Transport returned an oversized history');
    const date = text(day, 'Date', 40);
    const scans = day.HistoryItems.map((row) => {
      if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Central Transport returned an invalid history row');
      const id = row.RowId;
      if (typeof id !== 'number' || !Number.isSafeInteger(id)) throw new SchemaError(PROVIDER, 'Central Transport returned a row without its id');
      const exception = row.IsSeviceException ?? false;
      if (typeof exception !== 'boolean') throw new SchemaError(PROVIDER, 'Central Transport returned an invalid exception flag');
      const description = text(row, 'StatusMessage');
      const local = historyClock(date, text(row, 'Time', 16));
      if (!description || !local) throw new SchemaError(PROVIDER, 'Central Transport returned a row without its status or clock');
      const location = text(row, 'CityState', 80);
      const staged = centralTransportStage(description, exception);
      const event: CarrierEvent = { local_time: local, description, ...(location ? { location } : {}),
        ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) };
      return { id, event };
    });
    // The page lists a day's rows by id, latest first.
    return scans.sort((a, b) => b.id - a.id).map(({ event }) => event);
  }).filter((scans) => scans.length);
  // Newest day first, as the page shows them; days listed oldest first are turned round.
  if (listed.length > 1 && (listed[0]![0]!.local_time as string) < (listed.at(-1)![0]!.local_time as string)) listed.reverse();
  const seen = new Set<string>();
  return listed.flat().filter((event) => {
    const key = JSON.stringify(event);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The estimated delivery day, `M/D/YYYY`, while the shipment is still to be delivered. */
function estimate(shipment: Record<string, unknown>, stage: Stage | undefined): string | null {
  const match = DAY.exec(text(shipment, 'DeliveryDateEstimate', 16));
  if (!match || (stage && NO_ESTIMATE.has(stage))) return null;
  return calendarDay(Number(match[3]), Number(match[1]), Number(match[2]));
}

/** The shipment's weight, whole pounds, in kilograms. */
function weightKg(shipment: Record<string, unknown>): number | null {
  const pounds = text(shipment, 'Weight', 16);
  if (!POUNDS.test(pounds) || Number(pounds) <= 0) return null;
  return Math.round(Number(pounds) * POUNDS_TO_KG * 1000) / 1000;
}

/**
 * The shipment's answer: its history, under the summary's current status when
 * that is newer than every row. Every clock is the scanning terminal's wall
 * clock, without an offset. A delivered shipment is delivered whatever its
 * newest row says. `history` is null when the history could not be read.
 */
export function centralTransportResult(trace: CentralTransportTrace, history: readonly CarrierEvent[] | null): CarrierResult {
  const { shipment } = trace;
  const delivered = shipment.IsDelivered === true;
  const rows = history ?? [];
  const events = [...rows];
  const status = text(shipment, 'StatusMessage');
  const clock = summaryClock(text(shipment, 'StatusDate', 32));
  if (status && clock && (!rows.length || clock > (rows[0]!.local_time as string))) {
    const here = delivered ? '' : text(shipment, 'CurrentLocation', 120);
    const staged = delivered ? { stage: 'delivered', source: 'carrier_map' } : centralTransportStage(status, false);
    events.unshift({ local_time: clock, description: status, ...(here ? { location: here } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) });
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  const stage = (delivered ? 'delivered' : scanned?.stage) as Stage | undefined;
  const source = delivered && scanned?.stage !== 'delivered' ? 'carrier_map' : scanned?.stage_source;
  const weight = weightKg(shipment);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: estimate(shipment, stage),
    ...(weight !== null ? { weight_kg: weight } : {}),
    ...(rows.length ? {} : { summary_only: true }),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
