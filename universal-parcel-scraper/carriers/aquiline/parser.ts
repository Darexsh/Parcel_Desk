import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, isoTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { aquilineStage } from './status.js';

export const PROVIDER = 'Aquiline';
export const CARRIER = 'aquiline';
// A reply is a few kilobytes.
export const AQUILINE_MAX_BYTES = 256 * 1024;

// AQUAA, ten digits and YQ, as its tracker accepts them.
const NUMBER = /^AQUAA\d{10}YQ$/;
// "2026-09-11 09:00:00": Amazon's clock in UTC, without an offset.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
// The tracker's answer for a number it has nothing under.
const UNKNOWN = 'Unknown';
const MAX_EVENTS = 200;

/** A number for Aquiline's tracker: AQUAA, ten digits and YQ. */
export function normalizeAquilineNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Aquiline numbers are AQUAA, ten digits and YQ');
  return number;
}

const field = (record: Record<string, unknown>, key: string, maxLength = 300): string => {
  const value = record[key];
  if (value !== undefined && value !== null && typeof value !== 'string') throw new SchemaError(PROVIDER, `Aquiline returned an invalid ${key}`);
  return clean(value ?? '', maxLength);
};

/**
 * A scan's clock, which Amazon's tracker gives in UTC: a link to one parcel was
 * opened at 00:09 UTC on a label created at 22:49 the evening before, before
 * that clock in any US zone. The row of the shipper's handover comes at
 * midnight and keeps its day alone.
 */
function clockOf(text: string): Pick<CarrierEvent, 'time' | 'local_time'> {
  const parts = CLOCK.exec(text);
  if (parts) {
    const [year, month, day] = parts.slice(1, 4).map(Number) as [number, number, number];
    const date = calendarDay(year, month, day);
    if (date && year >= 2000) {
      if (text.endsWith(' 00:00:00')) return { local_time: date };
      const time = isoTime(text.replace(' ', 'T'), 'UTC');
      if (time) return { time: time.iso };
    }
  }
  throw new SchemaError(PROVIDER, 'Aquiline returned an invalid scan time');
}

/** A scan's place without a postcode or a street: the shipper's facility can be given by its address. */
function placeOf(location: string): string {
  const parts: string[] = [];
  for (const raw of location.split(',')) {
    const part = raw.trim();
    if (part && !/\d/.test(part) && !parts.some((kept) => kept.toUpperCase() === part.toUpperCase())) parts.push(part);
  }
  return parts.join(', ');
}

function eventsOf(rows: unknown[]): CarrierEvent[] {
  if (rows.length > MAX_EVENTS) throw new SchemaError(PROVIDER, 'Aquiline returned an invalid history');
  const events = rows.map((row, index) => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Aquiline returned an invalid scan');
    const description = field(row, 'description') || field(row, 'status');
    if (!description) throw new SchemaError(PROVIDER, 'Aquiline returned a scan without wording');
    const location = placeOf(field(row, 'location', 200));
    const staged = aquilineStage(description);
    const event: CarrierEvent = {
      ...clockOf(field(row, 'date', 40)), description,
      ...(location ? { location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    };
    return { index, event };
  });
  // Newest first, as the tracker lists them; a day alone counts as the day's start.
  const key = ({ time, local_time: day }: CarrierEvent) => time ?? `${day}T00:00:00Z`;
  return events.sort((left, right) => Date.parse(key(right.event)) - Date.parse(key(left.event)) || left.index - right.index)
    .map(({ event }) => event);
}

/**
 * The reply of the tracker's `getTrackingStatus` function: the number, a
 * summary status and Amazon's scans, newest first. A number the tracker has
 * nothing under comes back as a success with the status "Unknown" and no
 * scans. The summary is not read: it can say "Error" over a parcel's scans.
 */
export function parseAquiline(payload: unknown, raw: string): CarrierResult {
  const number = normalizeAquilineNumber(raw);
  const result = isRecord(payload) ? payload.result : undefined;
  if (!isRecord(result) || typeof result.success !== 'boolean') throw new SchemaError(PROVIDER, 'Aquiline returned an invalid reply');
  if (!result.success) throw new IndeterminateError(PROVIDER, 'Aquiline did not complete the lookup');
  const data = result.data;
  if (!isRecord(data) || !Array.isArray(data.events)) throw new SchemaError(PROVIDER, 'Aquiline returned a reply without its shipment');
  if (normalizeTrackingNumber(field(data, 'trackingNumber', 64)) !== number) throw new IndeterminateError(PROVIDER, 'Aquiline answered for another number');

  const events = eventsOf(data.events);
  const newest = events[0];
  if (!newest) {
    if (field(data, 'currentStatus', 40) === UNKNOWN) throw new NotFoundError(PROVIDER, 'Aquiline has nothing under this number');
    throw new IndeterminateError(PROVIDER, 'Aquiline answered without scans');
  }
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const destination = field(data, 'destination', 8).toUpperCase();
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.time ? {} : { last_update_local: newest.local_time }),
    expected_delivery: null,
    ...(/^[A-Z]{2}$/.test(destination) ? { destination_country: destination } : {}),
    events,
  };
}
