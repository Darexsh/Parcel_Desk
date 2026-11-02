import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { isSekoBookkeeping, sekoMappedStage, sekoStage } from './status.js';

export const PROVIDER = 'SEKO Logistics';
// A long history is a few kilobytes.
export const SEKO_MAX_BYTES = 512 * 1024;
/**
 * SEKO's own shipment numbers: a shipper's letters before seven digits, or
 * digits alone. The service also finds forwarding shipments by their booking
 * reference, so a short reference could name someone else's shipment; only a
 * whole number with a seven-digit run is sent.
 */
const NUMBER = /^(?=[A-Z0-9]*\d{7})[A-Z0-9]{8,20}$/;
// An offset-less wall clock, with seconds and an optional fraction.
const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,7})?$/;
const POUNDS_TO_KG = 0.453_592_37;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
// How far a stage has gone along the ordinary journey; the others stand apart.
const PROGRESS: readonly Stage[] = ['registered', 'accepted', 'in_transit', 'out_for_delivery'];
const FINAL: ReadonlySet<Stage> = new Set(['delivered', 'returned', 'exception']);

/** A number for SEKO's tracker, in capitals; anything else is not one it issues. */
export function normalizeSekoNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'SEKO numbers are eight to twenty letters and digits, with at least seven digits in a row');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `SEKO returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * A milestone's clock: SEKO's own wall clock, to the minute, with no zone.
 * The delivery's milestone runs one or two hours off the proof of delivery's
 * clock at the address, so the clocks are not the scanning place's either.
 */
function wallClock(value: string): string {
  const local = WALL_CLOCK.exec(value)?.[1];
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  if (!local || DateTime.fromISO(local, { zone: 'UTC' }).toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'SEKO returned an invalid milestone time');
  }
  return local;
}

/** A calendar day the reply gives as midnight, such as the due date. */
function day(data: Record<string, unknown>, key: string): string | null {
  const value = text(data, key, 40);
  if (!value) return null;
  return wallClock(value).slice(0, 10);
}

/** The total weight in kilograms, from pounds or kilograms. */
function weightKg(data: Record<string, unknown>): number | null {
  const value = data.totalWeight;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const unit = text(data, 'unitOfWeight', 8).toUpperCase();
  const kg = unit === 'LB' || unit === 'LBS' ? value * POUNDS_TO_KG : unit === 'KG' ? value : null;
  return kg === null ? null : Math.round(kg * 1000) / 1000;
}

function projectMilestone(row: unknown): CarrierEvent | null {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'SEKO returned an invalid milestone');
  const description = text(row, 'message');
  if (!description) throw new SchemaError(PROVIDER, 'SEKO returned a milestone without wording');
  const local = wallClock(text(row, 'eventDate', 40));
  if (isSekoBookkeeping(description)) return null;
  const staged = sekoStage(description);
  return {
    local_time: local,
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/**
 * The current stage: the summary's word for a finished or held shipment, else
 * whichever of the summary and the newest staged milestone has gone further.
 */
function currentStage(summary: Stage | undefined, scanned: CarrierEvent | undefined): { stage: Stage; source: string } | undefined {
  const scan = scanned?.stage as Stage | undefined;
  if (summary && (FINAL.has(summary) || !scan || (PROGRESS.includes(scan) && PROGRESS.indexOf(summary) > PROGRESS.indexOf(scan)))) {
    return { stage: summary, source: 'carrier_map' };
  }
  return scan ? { stage: scan, source: scanned!.stage_source as string } : undefined;
}

/**
 * The reply of `tracking-service/track/{number}`, the lookup behind SEKO's
 * tracking page. It answers a number it does not know with an empty HTTP
 * 404, which the adapter reads before this. The reply repeats the number
 * asked.
 */
export function parseSeko(payload: unknown, raw: string): CarrierResult {
  const number = normalizeSekoNumber(raw);
  if (!isRecord(payload) || typeof payload.trackingNumber !== 'string') throw new SchemaError(PROVIDER, 'SEKO returned a shipment without its number');
  if (normalizeTrackingNumber(clean(payload.trackingNumber, 64)) !== number) throw new IndeterminateError(PROVIDER, 'SEKO answered for another shipment');
  const rows = payload.milestones ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'SEKO returned a shipment with invalid milestones');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'SEKO returned an oversized history');

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    const event = projectMilestone(row);
    if (!event) continue;
    // The history repeats a status change, sometimes in another case, within a minute.
    const key = `${event.local_time as string} ${event.description!.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(event);
  }
  // The reply lists milestones oldest first, but the newest first within a minute,
  // so equal clocks keep its order.
  const newestFirst = events.map((event, index) => ({ event, index }))
    .sort((left, right) => (right.event.local_time as string).localeCompare(left.event.local_time as string) || left.index - right.index)
    .map(({ event }) => event);

  const status = text(payload, 'shipmentStatus', 120);
  const summary = status ? sekoMappedStage(status) : undefined;
  if (!newestFirst.length && !summary) throw new NoHistoryError(PROVIDER);
  const current = currentStage(summary, newestFirst.find((event) => event.stage));
  const finished = current?.stage === 'delivered' || current?.stage === 'returned';
  const service = text(payload, 'serviceLevel', 80);
  const destination = countryCode(text(payload, 'destinationCountryCode', 8));
  const weight = weightKg(payload);
  const newest = newestFirst[0];
  return {
    status: current ? languageStageStatus(current.stage) : 'unknown',
    ...(current ? { current_stage: current.stage, current_stage_source: current.source } : {}),
    last_status_text: newest?.description ?? status,
    last_update: null,
    ...(newest ? { last_update_local: newest.local_time } : {}),
    expected_delivery: finished ? null : day(payload, 'dueDate'),
    ...(service ? { service_name: service } : {}),
    ...(destination ? { destination_country: destination } : {}),
    ...(weight !== null ? { weight_kg: weight } : {}),
    events: newestFirst.slice(0, MAX_EVENTS),
    ...(newestFirst.length > MAX_EVENTS ? { history_truncated: true } : {}),
    ...(newestFirst.length ? {} : { summary_only: true }),
  };
}
