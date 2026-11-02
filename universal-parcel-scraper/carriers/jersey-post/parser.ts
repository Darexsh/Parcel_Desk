import { DateTime } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { jerseyPostStage } from './status.js';

export const PROVIDER = 'Jersey Post';
// A reply is a few kilobytes, most of them the carrier's logo as a data URL.
export const JERSEY_POST_MAX_BYTES = 512 * 1024;
// Jersey Post's own entry in the tracker's carrier list; other entries send the visitor to another carrier's site.
const JERSEY_POST_CARRIER = 10;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^\d{2}:\d{2}:\d{2}$/;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A Jersey Post item number: an S10 code ending JE with a valid check digit. */
export function normalizeJerseyPostNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!/^[A-Z]{2}\d{9}JE$/.test(number) || !isValidS10TrackingNumber(number)) {
    throw new InvalidInputError(PROVIDER, 'Jersey Post tracks S10 item numbers ending in JE');
  }
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength: number): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Jersey Post returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * A scan's clock: `eventDate` and `eventTime` to the second, with no zone. The
 * reply names none for Jersey's scans or the ones relayed from abroad, so the
 * clock stays local.
 */
function scanClock(row: Record<string, unknown>): string {
  const date = text(row, 'eventDate', 16);
  const time = text(row, 'eventTime', 16);
  const local = `${date}T${time}`;
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!DATE.test(date) || !CLOCK.test(time) || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'Jersey Post returned an invalid scan time');
  }
  return local;
}

function projectRow(row: Record<string, unknown>): { key: string; event: CarrierEvent } {
  const description = text(row, 'eventDesc', 300);
  if (!description) throw new SchemaError(PROVIDER, 'Jersey Post returned a scan without wording');
  const local = scanClock(row);
  const location = text(row, 'eventLocation', 120);
  const staged = jerseyPostStage(description);
  const event: CarrierEvent = {
    local_time: local,
    ...(location ? { location } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([local, description, location]), event };
}

/** The shipment's scans, newest first, as the page lists them. */
function history(item: Record<string, unknown>): CarrierResult {
  const rows = item.events ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Jersey Post returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Jersey Post returned an oversized history');
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Jersey Post returned an invalid scan');
    const scan = projectRow(row);
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    events.push(scan.event);
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // Newest first; an oldest-first reply is turned round.
  const newestFirst = (events[0]!.local_time as string) < (events.at(-1)!.local_time as string) ? events.reverse() : events;
  const newest = newestFirst[0]!;
  const scanned = newestFirst.find((event) => event.stage);
  const stage = scanned?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: scanned!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    events: newestFirst.slice(0, MAX_EVENTS),
    ...(newestFirst.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}

/**
 * The reply of the tracking page's lookup, `/Umbraco/Surface/Tools/Track/`,
 * for one number: `data` holds one item per number asked, and its `result`
 * says what the page shows. 1 is a history, 3 "No tracking information
 * available", 2 and 4 a number the tracker does not take, 5 another carrier's
 * number, 6 a question whether the item was posted in Jersey and -1 a refused
 * request. The item must name the number asked and Jersey Post as its carrier.
 * The proof of delivery (`pod`), which names who signed, is not read.
 */
export function parseJerseyPost(payload: unknown, raw: string): CarrierResult {
  const number = normalizeJerseyPostNumber(raw);
  if (!isRecord(payload) || typeof payload.success !== 'boolean') throw new SchemaError(PROVIDER, 'Jersey Post returned an invalid envelope');
  if (!payload.success) throw new IndeterminateError(PROVIDER, 'Jersey Post did not complete the lookup');
  const items = payload.data;
  if (!Array.isArray(items) || items.length !== 1 || !isRecord(items[0])) {
    throw new SchemaError(PROVIDER, 'Jersey Post did not return one item for the number');
  }
  const item = items[0];
  if (typeof item.trackingNumber !== 'string') throw new SchemaError(PROVIDER, 'Jersey Post returned an item without its number');
  if (clean(item.trackingNumber, 64).toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'Jersey Post answered for another item');
  const carrier = isRecord(item.carrier) ? item.carrier.carrierID : undefined;
  switch (item.result) {
    case 1:
      if (carrier !== JERSEY_POST_CARRIER) throw new IndeterminateError(PROVIDER, 'Jersey Post sent the number to another carrier');
      return history(item);
    case 3:
      if (carrier !== JERSEY_POST_CARRIER) throw new IndeterminateError(PROVIDER, 'Jersey Post sent the number to another carrier');
      throw new NotFoundError(PROVIDER);
    case 2:
    case 4:
      throw new InvalidInputError(PROVIDER, 'Jersey Post does not take this number', { reason: 'wrong_number' });
    case 5:
      throw new IndeterminateError(PROVIDER, 'Jersey Post sent the number to another carrier');
    case 6:
      throw new IndeterminateError(PROVIDER, 'Jersey Post asked whether the item was posted in Jersey');
    case -1:
      throw new IndeterminateError(PROVIDER, 'Jersey Post refused the tracking request');
    default:
      throw new SchemaError(PROVIDER, 'Jersey Post returned an unknown result');
  }
}
