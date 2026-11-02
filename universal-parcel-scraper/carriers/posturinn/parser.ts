import { DateTime } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { isPosturinnHomeScan, posturinnStage, posturinnStatusStage } from './status.js';

export const PROVIDER = 'Pósturinn';
// A long history is a few kilobytes.
export const POSTURINN_MAX_BYTES = 512 * 1024;

const ZONE = 'Atlantic/Reykjavik';
const MAX_ROWS = 500;
// "2025-11-28T10:49:57+00:00": a wall clock, labelled with an offset the tracking page strips.
const CLOCK = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$/;
// The estimate's calendar day, "05.12.2025", in its otherwise Icelandic sentence.
const ESTIMATE = /(?<!\d)(\d{2})\.(\d{2})\.(\d{4})(?!\d)/g;

/**
 * Pósturinn's tracker follows UPU S10 item codes: its own, ending IS, and
 * those of the posts that send mail to Iceland. The code needs a valid check digit.
 */
export function normalizePosturinnNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (isValidS10TrackingNumber(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Pósturinn tracks S10 item codes');
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength: number): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Pósturinn returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A scan's wall clock: the digits before the label, calendar-checked. */
function wallClock(value: string): string {
  const local = CLOCK.exec(value)?.[1];
  // Parsing in UTC checks the calendar fields only; no offset is assigned.
  const parsed = local ? DateTime.fromISO(local, { zone: 'UTC' }) : null;
  if (!local || !parsed?.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'Pósturinn returned an invalid scan time');
  }
  return local;
}

/** Iceland keeps UTC all year; an Icelandic scan's wall clock is read there, any other stays a wall clock. */
function clockOf(wall: string, home: boolean): { time: string } | { local_time: string } {
  if (!home) return { local_time: wall };
  return { time: firstOccurrence(DateTime.fromISO(wall, { zone: ZONE })).toISO({ suppressMilliseconds: true })! };
}

/**
 * One row of `trackingEvents`. Only the rows the page dates and ticks off,
 * `Historic`, are scans; `Current` and `Future` rows are steps still to come.
 */
function scanOf(row: unknown, domestic: boolean, inbound: boolean): CarrierEvent | null {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Pósturinn returned an invalid scan');
  const kind = text(row, 'chronologicalType', 20);
  if (!kind) throw new SchemaError(PROVIDER, 'Pósturinn returned a scan without its kind');
  if (kind !== 'Historic') return null;
  const description = text(row, 'description', 200);
  if (!description) throw new SchemaError(PROVIDER, 'Pósturinn returned a scan without wording');
  const wall = wallClock(text(row, 'timestamp', 40));
  if (row.location !== null && row.location !== undefined && !isRecord(row.location)) {
    throw new SchemaError(PROVIDER, 'Pósturinn returned an invalid scan location');
  }
  const location = isRecord(row.location) ? text(row.location, 'name', 120) : '';
  // A domestic parcel's scans are all Icelandic; mail from abroad also has the sending post's.
  const home = domestic || (inbound && isPosturinnHomeScan(description));
  const staged = posturinnStage(description);
  return {
    ...clockOf(wall, home),
    ...(location ? { location } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/** The tracker's own name for the service, as the English page shows it. */
function serviceOf(labels: unknown): string {
  if (!Array.isArray(labels)) return '';
  const english = (labels as unknown[]).find((label) => isRecord(label) && label.locale === 'EN');
  return isRecord(english) ? clean(english.title, 80) : '';
}

/** The estimated delivery day the tracker words for a parcel still on its way. */
function estimateOf(shipment: Record<string, unknown>): string | null {
  const days = Number(clean(shipment.estimatedNumberOfDaysUntilDelivery, 16) || Number.NaN);
  if (!(days > 0)) return null;
  const dates = [...text(shipment, 'estimatedDeliveryDateMessage', 300).matchAll(ESTIMATE)];
  if (dates.length !== 1) return null;
  const [, day, month, year] = dates[0]!;
  return calendarDay(Number(year), Number(month), Number(day));
}

function newestFirst(events: CarrierEvent[]): CarrierEvent[] {
  const clock = (event: CarrierEvent) => String(event.time ?? event.local_time).slice(0, 19);
  return events.length > 1 && clock(events[0]!) < clock(events.at(-1)!) ? [...events].reverse() : events;
}

/**
 * The reply of `GET /api/v1/shipments/{number}`, the lookup the tracking page
 * makes: the shipment's summary and its scans, oldest first. A code the
 * tracker does not know gets HTTP 204 instead, which the adapter reads.
 */
export function parsePosturinn(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizePosturinnNumber(rawNumber);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Pósturinn returned an invalid reply');
  const shipment = payload.shipment;
  if (shipment === null || shipment === undefined) {
    // The page lists the parcels of a multi-parcel answer; none of them is bound to the code.
    const others = payload.allPossibleTrackAndTraces;
    if (Array.isArray(others) && others.length) {
      throw new IndeterminateError(PROVIDER, 'Pósturinn returned several parcels for the code', { reason: 'several_parcels' });
    }
    throw new IndeterminateError(PROVIDER, 'Pósturinn returned no shipment for the code');
  }
  if (!isRecord(shipment) || typeof shipment.id !== 'string') throw new SchemaError(PROVIDER, 'Pósturinn returned a shipment without its code');
  if (normalizeTrackingNumber(clean(shipment.id, 64)) !== number) throw new SchemaError(PROVIDER, 'Pósturinn answered for a different item');
  const rows = payload.trackingEvents ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Pósturinn returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Pósturinn returned an oversized history');

  const domestic = shipment.isDomestic === true;
  const inbound = text(shipment, 'direction', 20) === 'Inbound';
  const seen = new Set<string>();
  const scans: CarrierEvent[] = [];
  for (const row of rows) {
    const event = scanOf(row, domestic, inbound);
    if (!event) continue;
    // A scan the reply lists twice is kept once.
    const identity = JSON.stringify(event);
    if (seen.has(identity)) continue;
    seen.add(identity);
    scans.push(event);
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  const events = newestFirst(scans);

  const latest = events[0]!;
  const current = events.find((event) => event.stage);
  const scanned = current?.stage as Stage | undefined;
  // The status settles a delivery, a return or a parcel waiting for its
  // recipient, unless the scans have already reached a delivery or a return.
  const settled = posturinnStatusStage(text(shipment, 'status', 60));
  const summary = settled && scanned !== 'delivered' && scanned !== 'returned' ? settled : undefined;
  const stage = summary ?? scanned;
  const source = summary && summary !== scanned ? 'carrier_map' : current?.stage_source;
  const delivered = stage === 'delivered' && scanned === 'delivered' ? current!.time : undefined;
  const service = serviceOf(shipment.labels);
  const expected = stage === 'delivered' || stage === 'returned' ? null : estimateOf(shipment);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    ...(latest.time ? {} : { last_update_local: latest.local_time }),
    expected_delivery: expected,
    ...(delivered ? { delivered_at: delivered } : {}),
    ...(service ? { service_name: service } : {}),
    // Domestic parcels and mail from abroad are delivered in Iceland.
    ...(domestic || inbound ? { destination_country: 'IS' } : {}),
    events,
  };
}
