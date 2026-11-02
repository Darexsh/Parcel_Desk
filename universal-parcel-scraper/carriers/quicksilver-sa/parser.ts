import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { quicksilverMappedStage, quicksilverStage } from './status.js';

export const PROVIDER = 'Quicksilver';
export const CARRIER = 'quicksilver-sa';
// A long history is a few kilobytes.
export const QUICKSILVER_MAX_BYTES = 256 * 1024;

// `QS` and nine digits on every number seen; one public sample is too few to
// rule out other layouts, so any eight to thirty letters and digits are sent.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,30}$/;
// "2026-01-31 18:05:09": the service's wall clock, to the second.
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
// The service's answer, with HTTP 404, for a number it does not know.
const UNKNOWN = /^Shipment not found$/i;
// The station a reason opens with, as "【Sample Station】Pick up task assigned to DA."
const STATION = /^【([^】]{1,120})】\s*/;
// A run of nine or more digits, with spaces, brackets, dots or hyphens
// between them, as phone numbers are written.
const PHONE = /(?<![A-Z\d])\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A number for Quicksilver's tracker, in upper case; anything else is not one it issues. */
export function normalizeQuicksilverNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Quicksilver numbers are eight to thirty letters and digits');
  return number;
}

/** Whether a reply is the service's own answer for a number it does not know. */
export function isQuicksilverUnknown(payload: unknown): boolean {
  return isRecord(payload) && !Object.hasOwn(payload, 'history') && typeof payload.error === 'string'
    && UNKNOWN.test(payload.error.trim());
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Quicksilver returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * A status's clock. `updated_at` is a wall clock to the second; the reply
 * names no zone and none has been verified, so it stays local.
 */
function wallClock(row: Record<string, unknown>): string {
  const match = CLOCK.exec(text(row, 'updated_at', 40));
  const local = match ? `${match[1]}T${match[2]}` : '';
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  // Luxon rolls 24:00:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!match || !parsed.isValid || parsed.year < 2000 || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'Quicksilver returned an invalid status time');
  }
  return local;
}

/**
 * A status's wording and place: its name, then the reason the page shows
 * under it, without the station the reason opens with, which becomes the
 * location, and without phone numbers. A delivery keeps its name alone, since
 * its reason could say who took the parcel.
 */
export function quicksilverWording(status: string, reason: string): { description: string; location: string } {
  const station = STATION.exec(reason);
  const location = station ? clean(station[1]!.replace(PHONE, ''), 120) : '';
  const own = clean(reason.replace(STATION, '').replace(PHONE, '').replace(/\s+([,;:.])/g, '$1'), 300).replace(/^[\s,;:.\-–]+|[\s,;:\-–]+$/g, '');
  const delivery = quicksilverMappedStage(status) === 'delivered';
  const description = !own || delivery || own.toLowerCase() === status.toLowerCase() ? status : `${status}: ${own}`;
  return { description, location };
}

function projectRow(row: Record<string, unknown>): { key: string; local: string; event: CarrierEvent } {
  const status = text(row, 'status', 80);
  if (!status) throw new SchemaError(PROVIDER, 'Quicksilver returned a status without its name');
  const local = wallClock(row);
  const { description, location } = quicksilverWording(status, text(row, 'reason'));
  const staged = quicksilverStage(status);
  const event: CarrierEvent = {
    local_time: local,
    ...(location ? { location } : {}),
    description,
    provider_code: status,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([local, status, description, location]), local, event };
}

/**
 * The reply of the tracking page's `customer/tracking/history` lookup for one
 * number: the number, the delivery driver's mobile number and the statuses,
 * mostly newest first, each with its name, a reason, a proof-of-delivery
 * photo and its clock. The service answers a number it does not know with
 * HTTP 404 and "Shipment not found", which the page words as a number that
 * is incorrect or does not exist. The reply must name the whole number asked.
 * The driver's number and the photos are not read.
 */
export function parseQuicksilver(payload: unknown, raw: string): CarrierResult {
  const number = normalizeQuicksilverNumber(raw);
  if (isQuicksilverUnknown(payload)) throw new NotFoundError(PROVIDER);
  if (!isRecord(payload) || !Object.hasOwn(payload, 'history')) throw new SchemaError(PROVIDER, 'Quicksilver returned an invalid envelope');
  if (typeof payload.tracking_number !== 'string') throw new SchemaError(PROVIDER, 'Quicksilver returned a shipment without its number');
  if (clean(payload.tracking_number, 64).toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'Quicksilver answered for another shipment');
  const rows = payload.history ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Quicksilver returned a shipment with invalid statuses');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Quicksilver returned an oversized history');

  const seen = new Set<string>();
  const scans: { local: string; index: number; event: CarrierEvent }[] = [];
  rows.forEach((row: unknown, index) => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Quicksilver returned an invalid status');
    const scan = projectRow(row);
    // A status the service lists twice at the same clock is kept once.
    if (seen.has(scan.key)) return;
    seen.add(scan.key);
    scans.push({ local: scan.local, index, event: scan.event });
  });
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first by clock: the service lists some statuses out of order.
  // Equal clocks keep its order, newest first.
  scans.sort((left, right) => right.local.localeCompare(left.local) || left.index - right.index);
  const events = scans.map(({ event }) => event);

  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
