import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { skykingStage } from './status.js';

export const PROVIDER = 'SkyKing';
// A long history is a few kilobytes.
export const SKYKING_MAX_BYTES = 256 * 1024;
// Nine digits, or eight on older consignments.
const NUMBER = /^\d{8,9}$/;
// Every scan is at a SkyKing branch or hub in India, which keeps UTC+5:30 all year.
const ZONE = 'Asia/Kolkata';
const CLOCK = 'dd/MM/yyyy - HH:mm:ss';
// The details a wording lists after a comma, each under its label, such as "Area Name: …, Delivery Boy: …".
const DETAILS = /,\s*[^,:]{1,60}:[\s\S]*$/;
// What a delivery or return lists after its wording, such as how it was signed for.
const REMARK = /\s*,[\s\S]*$/;
// A run of nine or more digits, with spaces, brackets, dots or hyphens between them, as phone numbers are written.
const PHONE = /(?<!\d)\+?\d(?:[\s().-]{0,2}\d){8,}(?!\d)/g;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A SkyKing consignment number: nine digits, or eight. Anything else is not a number SkyKing issues. */
export function normalizeSkykingNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'SkyKing consignment numbers are nine or eight digits');
  return number;
}

/** A text field; anything but a string, or null, is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `SkyKing returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A scan's wall clock, read in India and read back unchanged, as an instant. */
function scanTime(local: string): string {
  const wall = firstOccurrence(DateTime.fromFormat(local, CLOCK, { zone: ZONE }));
  // Luxon rolls 24:00:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!wall.isValid || wall.toFormat(CLOCK) !== local) throw new SchemaError(PROVIDER, 'SkyKing returned an invalid scan time');
  return wall.toUTC().toISO({ suppressMilliseconds: true });
}

/**
 * A scan's wording without the details listed after it, which name the courier
 * and the delivery area, and without phone numbers. A delivery or return keeps
 * its wording alone.
 */
export function skykingWording(status: string, stage?: string): string {
  const own = stage === 'delivered' || stage === 'returned' ? status.replace(REMARK, '') : status.replace(DETAILS, '');
  return clean(own.replace(PHONE, ''), 200).replace(/^[\s,;:.\-–]+|[\s,;:\-–]+$/g, '');
}

/** The branch or hub a scan names, as "SAMPLE MARKET, SAMPLE CITY". */
function place(value: string): string {
  return clean(value.replace(/\s*,\s*/g, ', '), 120).replace(/^[\s,]+|[\s,]+$/g, '');
}

interface Scan { event: CarrierEvent; at: string; index: number }

function projectRow(row: unknown, index: number, number: string): Scan & { key: string } {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'SkyKing returned an invalid scan');
  if (typeof row.CNote !== 'string') throw new SchemaError(PROVIDER, 'SkyKing returned a scan without its consignment');
  if (row.CNote.length > 64 || normalizeTrackingNumber(row.CNote) !== number) {
    throw new IndeterminateError(PROVIDER, 'SkyKing answered for another consignment');
  }
  const status = text(row, 'Status');
  if (!status) throw new SchemaError(PROVIDER, 'SkyKing returned a scan without wording');
  const time = scanTime(text(row, 'DateTime', 32));
  const staged = skykingStage(status);
  const description = skykingWording(status, staged?.stage);
  if (!description) throw new SchemaError(PROVIDER, 'SkyKing returned a scan without wording');
  const location = place(text(row, 'Location'));
  const event: CarrierEvent = {
    time,
    ...(location ? { location } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { event, at: time, index, key: JSON.stringify([time, description, location]) };
}

/**
 * The reply of the tracking page's `ConsignmentMTrack_WebSite_AuthNew` for one
 * consignment number: its scans, oldest first, each naming the consignment. An
 * empty list is the page's "No Tracking Information Available". Branch and
 * location ids, manifest references, run sheet kinds, status flags and the
 * proof-of-delivery and booking images are not read.
 */
export function parseSkyking(payload: unknown, raw: string): CarrierResult {
  const number = normalizeSkykingNumber(raw);
  if (!Array.isArray(payload)) throw new SchemaError(PROVIDER, 'SkyKing returned an invalid history');
  if (!payload.length) throw new NotFoundError(PROVIDER);
  if (payload.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'SkyKing returned an oversized history');

  const seen = new Set<string>();
  const scans: Scan[] = [];
  payload.forEach((row, index) => {
    const scan = projectRow(row, index, number);
    if (seen.has(scan.key)) return;
    seen.add(scan.key);
    scans.push(scan);
  });
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first; of two scans on one second, the one listed later is newer, as the reply lists them oldest first.
  const events = scans.sort((a, b) => (a.at === b.at ? b.index - a.index : a.at < b.at ? 1 : -1)).map(({ event }) => event);

  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: null,
    ...(stage === 'delivered' ? { delivered_at: current!.time! } : {}),
    timezone: ZONE,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
