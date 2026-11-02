import { DateTime } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { postaFaroeStage } from './status.js';

export const PROVIDER = 'Posta';
// A long history is a few kilobytes.
export const POSTA_FAROE_MAX_BYTES = 512 * 1024;

const ZONE = 'Atlantic/Faroe';
const MAX_ROWS = 500;
// "2022-12-13 18:43", which the page shows as the reader's own wall clock.
const CLOCK = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2})(?:\.\d{1,7})?)?(Z|[+-]\d{2}:\d{2})?$/;
// A scan of the post abroad names its country first: "NL - AMSTERDAM".
const COUNTRY = /^([A-Z]{2})\s*-\s*\S/;
// Mail numbers Posta's customs help describes beside S10 codes.
const MAIL_NUMBER = /^\d{20}$/;

/**
 * Posta's tracker follows UPU S10 item codes, its own and those of the posts
 * that send mail to the Faroe Islands, with a valid check digit, and 20-digit
 * mail numbers.
 */
export function normalizePostaFaroeNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (isValidS10TrackingNumber(number) || MAIL_NUMBER.test(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Posta tracks S10 item codes and 20-digit mail numbers');
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength: number): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Posta returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** An optional whole number; anything else is a changed reply. */
function count(row: Record<string, unknown>, key: string): number | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new SchemaError(PROVIDER, `Posta returned an invalid ${key}`);
  return value;
}

/** A scan's wall clock, calendar-checked, and its offset if the reply gives one. */
function clockOf(value: string): { wall: string; offset: string } {
  const match = CLOCK.exec(value);
  const wall = match ? `${match[1]}T${match[2]}:${match[3] ?? '00'}` : '';
  // Parsing in UTC checks the calendar fields only; no offset is assigned.
  const parsed = wall ? DateTime.fromISO(wall, { zone: 'UTC' }) : null;
  if (!match || !parsed?.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== wall) {
    throw new SchemaError(PROVIDER, 'Posta returned an invalid scan time');
  }
  return { wall, offset: match[4] ?? '' };
}

/** Whether the scan is Posta's own: a place in the Faroe Islands, not one the post abroad names with its country. */
export function isPostaFaroeHomeScan(location: string): boolean {
  if (!location) return false;
  const country = COUNTRY.exec(location)?.[1];
  return country === undefined || country === 'FO';
}

/**
 * Posta's own scans are dated in the Faroe Islands. The post abroad's scans,
 * and a scan without a place, keep their wall clock; an explicit offset stays.
 */
function timeOf(wall: string, offset: string, home: boolean): { time: string } | { local_time: string } {
  if (offset) return { time: DateTime.fromISO(`${wall}${offset}`, { setZone: true }).toISO({ suppressMilliseconds: true })! };
  if (!home) return { local_time: wall };
  return { time: firstOccurrence(DateTime.fromISO(wall, { zone: ZONE })).toISO({ suppressMilliseconds: true })! };
}

function scanOf(row: unknown): { parcel: number | undefined; event: CarrierEvent } {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Posta returned an invalid scan');
  const code = count(row, 'eventTypeId');
  if (code === undefined) throw new SchemaError(PROVIDER, 'Posta returned a scan without its code');
  const description = text(row, 'eventDescription', 200);
  if (!description) throw new SchemaError(PROVIDER, 'Posta returned a scan without wording');
  const { wall, offset } = clockOf(text(row, 'eventDateTime', 40));
  const location = text(row, 'locationName', 120);
  const staged = postaFaroeStage(String(code), description);
  return {
    parcel: count(row, 'parcelSequenceNo'),
    event: {
      ...timeOf(wall, offset, isPostaFaroeHomeScan(location)),
      ...(location ? { location } : {}),
      description,
      provider_code: String(code),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    },
  };
}

function newestFirst(events: CarrierEvent[]): CarrierEvent[] {
  const clock = (event: CarrierEvent) => String(event.time ?? event.local_time).slice(0, 19);
  return events.length > 1 && clock(events[0]!) < clock(events.at(-1)!) ? [...events].reverse() : events;
}

/**
 * The reply of `GET /api/TrackTrace?trackTraceCode={number}`, the lookup the
 * tracking page makes: the item's scans, newest first, each with the number of
 * the parcel it belongs to. The reply does not repeat the number. A number the
 * tracker does not know gets HTTP 204 instead, which the page reads as null.
 */
export function parsePostaFaroe(payload: unknown, rawNumber: string): CarrierResult {
  normalizePostaFaroeNumber(rawNumber);
  if (payload === null) throw new NotFoundError(PROVIDER);
  if (!Array.isArray(payload)) throw new SchemaError(PROVIDER, 'Posta returned an invalid reply');
  if (payload.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Posta returned an oversized history');

  const parcels = new Set<number>();
  const seen = new Set<string>();
  const scans: CarrierEvent[] = [];
  for (const row of payload as unknown[]) {
    const { parcel, event } = scanOf(row);
    if (parcel !== undefined) parcels.add(parcel);
    // A scan the reply lists twice is kept once.
    const identity = JSON.stringify(event);
    if (seen.has(identity)) continue;
    seen.add(identity);
    scans.push(event);
  }
  // The page shows each parcel of a shipment as its own item; one history cannot stand for them all.
  if (parcels.size > 1) throw new IndeterminateError(PROVIDER, 'Posta returned several parcels for the number', { reason: 'several_parcels' });
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  const events = newestFirst(scans);

  const latest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const delivered = stage === 'delivered' ? current!.time : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    ...(latest.time ? {} : { last_update_local: latest.local_time }),
    expected_delivery: null,
    ...(delivered ? { delivered_at: delivered } : {}),
    events,
  };
}
