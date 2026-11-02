import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { liccardiStage } from './status.js';

export const PROVIDER = 'Liccardi';
// A history is about ten kilobytes; the pickup it came in lists every parcel of that pickup.
export const LICCARDI_MAX_BYTES = 2 * 1024 * 1024;
const ZONE = 'Europe/Rome';
// The shipment's seven or eight digits, or the thirteen of its label, which
// the help page says start with 66: 660, the shipment number on eight digits
// and two more.
const NUMBER = /^(?:\d{7,8}|66\d{11})$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const WAYBILL = /^[A-Z0-9]{4,40}$/;
// A parcel's repeated scan: the same code at the same branch within a minute.
const REPEAT_MS = 60_000;
const MAX_PARCELS = 200;
const MAX_ROWS = 1000;
const MAX_EVENTS = 100;

/** A number for Liccardi's tracker; anything else is not one it issues. */
export function normalizeLiccardiNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) {
    throw new InvalidInputError(PROVIDER, 'Liccardi numbers are seven or eight digits, or thirteen starting with 66');
  }
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Liccardi returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A whole, nonnegative number the reply must give, such as a shipment number or an event code. */
function whole(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new SchemaError(PROVIDER, `Liccardi returned an invalid ${what}`);
  return value;
}

/** A UTC instant, as the page reads it, at Italy's offset. */
function instant(value: unknown): DateTime | null {
  const parsed = typeof value === 'string' && INSTANT.test(value) ? DateTime.fromISO(value, { setZone: true }) : null;
  return parsed?.isValid ? parsed.setZone(ZONE) : null;
}

const iso = (time: DateTime) => time.toISO({ suppressMilliseconds: true })!;

interface Scan { at: number; code: number; branch: string; event: CarrierEvent }

/**
 * One of a parcel's `esiti`. The driver who handled it and the driver's note
 * are not read.
 */
function projectScan(row: unknown): Scan {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Liccardi returned an invalid scan');
  const time = instant(row.eventDateTime);
  if (!time) throw new SchemaError(PROVIDER, 'Liccardi returned an invalid scan time');
  const code = whole(row.codEsito, 'event code');
  const description = text(row, 'descEsito');
  if (!description) throw new SchemaError(PROVIDER, 'Liccardi returned a scan without wording');
  const location = text(row, 'descFiliale', 120);
  const staged = liccardiStage(String(code), description);
  return {
    at: time.toMillis(), code, branch: text(row, 'filiale', 40) || location,
    event: {
      time: iso(time),
      ...(location ? { location } : {}),
      description,
      provider_code: String(code),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    },
  };
}

/** The scans of each parcel (`colli`), oldest first. */
function parcelScans(tracking: Record<string, unknown>): Scan[][] {
  const parcels = tracking.colli ?? [];
  if (!Array.isArray(parcels)) throw new SchemaError(PROVIDER, 'Liccardi returned invalid parcels');
  if (parcels.length > MAX_PARCELS) throw new SchemaError(PROVIDER, 'Liccardi returned too many parcels');
  let rows = 0;
  return parcels.map((parcel) => {
    if (!isRecord(parcel)) throw new SchemaError(PROVIDER, 'Liccardi returned an invalid parcel');
    const scans = parcel.esiti ?? [];
    if (!Array.isArray(scans)) throw new SchemaError(PROVIDER, 'Liccardi returned a parcel with invalid scans');
    rows += scans.length;
    if (rows > MAX_ROWS) throw new SchemaError(PROVIDER, 'Liccardi returned an oversized history');
    return scans.map(projectScan).sort((a, b) => a.at - b.at);
  });
}

/**
 * The shipment's history, newest first. Each parcel of a shipment has its own
 * scans, which mostly repeat the others' a second or two apart; a scan is kept
 * once per branch and code within a minute.
 */
function history(parcels: Scan[][]): Scan[] {
  const kept: Scan[] = [];
  for (const scan of parcels.flat().sort((a, b) => a.at - b.at)) {
    const repeat = kept.some((other) => other.code === scan.code && other.branch === scan.branch && scan.at - other.at <= REPEAT_MS);
    if (!repeat) kept.push(scan);
  }
  return kept.reverse();
}

/**
 * The stage the shipment is at: the newest staged scan of each parcel, and of
 * those, the newest that is not a delivery. One parcel delivered does not
 * deliver the shipment while another is still on its way.
 */
function currentScan(parcels: Scan[][]): Scan | undefined {
  const currents = parcels.map((scans) => [...scans].reverse().find((scan) => scan.event.stage))
    .filter((scan): scan is Scan => scan !== undefined);
  const open = currents.filter((scan) => scan.event.stage !== 'delivered');
  return (open.length ? open : currents).reduce<Scan | undefined>((newest, scan) => (!newest || scan.at > newest.at ? scan : newest), undefined);
}

/** A calendar day the reply gives, or null. */
function day(tracking: Record<string, unknown>, key: string): string | null {
  const value = text(tracking, key, 16);
  return DATE.test(value) && DateTime.fromISO(value, { zone: 'UTC' }).isValid ? value : null;
}

/**
 * The delivery day: the one the page shows over the history when the reply
 * has it, else the planned day as last updated, else the first planned.
 */
function estimate(tracking: Record<string, unknown>): string | null {
  return day(tracking, 'estimatedArrivalDate') ?? day(tracking, 'dataPrevistaConsegnaAggiornata') ?? day(tracking, 'dataPrevistaConsegnaTeorica');
}

/**
 * Another courier's waybill, which the page shows as that courier's lettera
 * di vettura when the reply names both the courier and the number.
 */
function partnerWaybill(tracking: Record<string, unknown>, own: string[]): string | null {
  const courier = text(tracking, 'externalCourierCode', 40);
  const waybill = normalizeTrackingNumber(text(tracking, 'externalCourierLdv', 64));
  return courier && WAYBILL.test(waybill) && !own.includes(waybill) ? waybill : null;
}

/**
 * The shipment's summary: the event the reply files the shipment under, with
 * its time, or null when it names none.
 */
function summaryScan(tracking: Record<string, unknown>): Scan | null {
  if (tracking.codEvento === null || tracking.codEvento === undefined) return null;
  return projectScan({ eventDateTime: tracking.dateTimeEv, codEsito: tracking.codEvento, descEsito: tracking.descEvento });
}

/**
 * The reply of the tracker's `/tracking/{number}` for one shipment. The
 * service finds a shipment by its own number (`ldv`) or by its label's
 * thirteen digits (`courierLdv`); the reply must give back the one asked. The
 * recipient's town and postcode, the sender's references, the drivers, the
 * proof of delivery and the pickup the parcel came in are not kept.
 */
export function parseLiccardi(payload: unknown, raw: string): CarrierResult {
  const number = normalizeLiccardiNumber(raw);
  if (!isRecord(payload) || !isRecord(payload.status)) throw new SchemaError(PROVIDER, 'Liccardi returned an invalid envelope');
  if (payload.status.code !== 200) throw new IndeterminateError(PROVIDER, 'Liccardi did not complete the lookup');
  const tracking = payload.tracking;
  if (!isRecord(tracking)) throw new SchemaError(PROVIDER, 'Liccardi returned a reply without a shipment');
  const shipment = whole(tracking.ldv, 'shipment number');
  const label = text(tracking, 'courierLdv', 64);
  const matches = number.length === 13 ? label === number : shipment === Number(number);
  if (!matches) throw new IndeterminateError(PROVIDER, 'Liccardi answered for another shipment');

  const parcels = parcelScans(tracking);
  const scans = history(parcels);
  const waybill = partnerWaybill(tracking, [number, label, String(shipment)]);
  const handoff = waybill ? { delivery_tracking_number: waybill } : {};
  if (!scans.length) {
    // A shipment whose parcels have no scan yet still has its summary's event.
    const summary = summaryScan(tracking);
    if (!summary) throw new NoHistoryError(PROVIDER);
    const stage = summary.event.stage as Stage | undefined;
    return {
      status: stage ? languageStageStatus(stage) : 'unknown',
      ...(stage ? { current_stage: stage, current_stage_source: summary.event.stage_source! } : {}),
      last_status_text: summary.event.description!,
      ...(summary.event.provider_code ? { provider_code: summary.event.provider_code } : {}),
      last_update: summary.event.time!,
      expected_delivery: stage === 'delivered' || stage === 'returned' ? null : estimate(tracking),
      ...handoff,
      summary_only: true,
      events: [],
    };
  }
  const events = scans.map((scan) => scan.event);
  const newest = events[0]!;
  const current = currentScan(parcels);
  const stage = current?.event.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.event.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: stage === 'delivered' || stage === 'returned' ? null : estimate(tracking),
    ...(stage === 'delivered' ? { delivered_at: events.find((event) => event.stage === 'delivered')!.time! } : {}),
    ...handoff,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
