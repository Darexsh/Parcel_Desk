import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime, type ParsedTime } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { northlineStage } from './status.js';

export const PROVIDER = 'Northline';
export const CARRIER = 'northline';
// A long history is under ten kilobytes.
export const NORTHLINE_MAX_BYTES = 512 * 1024;

// A digit, three letters set by the sender or booking channel, then five to eleven digits.
const NUMBER = /^\d[A-Z]{3}\d{5,11}$/;
// The reply puts a Z on every clock, but each is a wall clock.
const CLOCK = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})Z$/;
// The Australian zones a milestone's `branch` names, by abbreviation. Another stays a wall clock.
const OFFSETS: ReadonlyMap<string, string> = new Map([
  ['AEST', '+10:00'], ['AEDT', '+11:00'], ['ACST', '+09:30'], ['ACDT', '+10:30'], ['AWST', '+08:00'],
]);
const FINAL: ReadonlySet<Stage> = new Set(['delivered', 'returned']);
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A Northline consignment note number, in upper case; anything else is not one it issues. */
export function normalizeNorthlineNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Northline consignment numbers are a digit, three letters and five to eleven digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 120): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Northline returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A `…Z` clock's wall time, `YYYY-MM-DDTHH:mm:ss`, with its calendar checked. */
function wallClock(value: string): string | null {
  const match = CLOCK.exec(value);
  if (!match) return null;
  const wall = `${match[1]}T${match[2]}`;
  // Parsing in UTC checks the calendar digits only; the clock keeps no offset.
  const parsed = DateTime.fromISO(wall, { zone: 'UTC' });
  return parsed.isValid && parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") === wall ? wall : null;
}

interface Scan {
  key: string;
  instant: ParsedTime | null;
  event: CarrierEvent;
}

/**
 * One milestone: the status it moved to, the wall clock of the branch that
 * recorded it and that branch's zone abbreviation, which gives the offset.
 */
function scanOf(row: unknown, number: string): Scan {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Northline returned an invalid milestone');
  if (text(row, 'connoteNo', 64).toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'Northline answered with another consignment\'s milestone');
  const code = cleanScalar(row.newStatusValue, 8);
  if (!/^\d{1,4}$/.test(code)) throw new SchemaError(PROVIDER, 'Northline returned a milestone without a status');
  const description = text(row, 'newStatusText');
  if (!description) throw new SchemaError(PROVIDER, 'Northline returned a milestone without wording');
  const wall = wallClock(text(row, 'updatedOn', 40));
  if (!wall) throw new SchemaError(PROVIDER, 'Northline returned an invalid milestone time');
  const zone = text(row, 'branch', 8).toUpperCase();
  const offset = OFFSETS.get(zone);
  const instant = offset ? explicitOffsetTime(`${wall}${offset}`) : null;
  const staged = northlineStage(code, description);
  return {
    key: JSON.stringify([wall, zone, code, description]),
    instant,
    event: {
      ...(instant ? { time: instant.iso } : { local_time: wall }),
      description,
      provider_code: code,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    },
  };
}

/** The estimate, a calendar day the reply writes as midnight with a Z. */
function estimate(data: Record<string, unknown>): string | null {
  return wallClock(text(data, 'expectedDeliveryDate', 40))?.slice(0, 10) ?? null;
}

/**
 * The reply of the tracker's `/api/track/v3/public/reference` for one number.
 * A consignment comes in `data`, with its current status and its milestones,
 * newest first. A number the tracker does not know gets `data: null` with
 * "No result", which the page shows as not found; a refused request gets a
 * `status` with the service's message.
 *
 * The consignment must name the whole number asked: the lookup also takes
 * references. The account code, the sender's reference, the sender's and
 * receiver's suburbs, states and postcodes are not read.
 */
export function parseNorthline(payload: unknown, raw: string): CarrierResult {
  const number = normalizeNorthlineNumber(raw);
  if (!isRecord(payload) || !Object.hasOwn(payload, 'data')) throw new SchemaError(PROVIDER, 'Northline returned an invalid envelope');
  if (payload.status !== null && payload.status !== undefined) throw new IndeterminateError(PROVIDER, 'Northline did not complete the lookup');
  const data = payload.data;
  if (data === null) {
    if (payload.message === 'No result') throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Northline answered without a consignment');
  }
  if (!isRecord(data) || typeof data.connoteNo !== 'string') throw new SchemaError(PROVIDER, 'Northline returned a consignment without its number');
  if (clean(data.connoteNo, 64).toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'Northline answered for another consignment');
  const rows = data.milestoneHistory ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Northline returned a consignment with invalid milestones');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Northline returned an oversized history');

  const code = cleanScalar(data.statusValue, 8);
  const wording = text(data, 'statusName');
  const summary = /^\d{1,4}$/.test(code) && wording ? northlineStage(code, wording) : null;

  const seen = new Set<string>();
  const scans: Scan[] = [];
  for (const row of rows) {
    const scan = scanOf(row, number);
    // A depot scan can be listed several times over.
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    scans.push(scan);
  }
  if (!scans.length) {
    // A booked consignment has its status and no milestone yet.
    if (!summary) throw new NoHistoryError(PROVIDER);
    const expected = FINAL.has(summary.stage) ? null : estimate(data);
    return { status: languageStageStatus(summary.stage), current_stage: summary.stage, current_stage_source: summary.source,
      last_status_text: wording, provider_code: code, last_update: null, expected_delivery: expected, summary_only: true, events: [] };
  }
  // Newest first, as the reply lists them by wall clock; when every one has an
  // instant, by instant, since a history crosses zones.
  if (scans.every((scan) => scan.instant)) scans.sort((a, b) => b.instant!.timestamp - a.instant!.timestamp);
  const events = scans.map((scan) => scan.event);

  const newest = events[0]!;
  const staged = events.find((event) => event.stage);
  // The consignment's own status can lead its milestones to a delivery.
  const lead = summary && FINAL.has(summary.stage) && staged?.stage !== summary.stage ? summary : null;
  const stage = (lead?.stage ?? staged?.stage) as Stage | undefined;
  const delivered = stage === 'delivered' ? events.find((event) => event.stage === 'delivered')?.time ?? null : null;
  const expected = stage && FINAL.has(stage) ? null : estimate(data);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead?.source ?? staged!.stage_source! } : {}),
    last_status_text: lead ? wording : newest.description!,
    last_update: newest.time ?? null,
    ...(newest.time ? {} : { last_update_local: newest.local_time }),
    expected_delivery: expected,
    delivered_at: delivered,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
