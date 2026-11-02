import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { ramStage } from './status.js';

export const PROVIDER = 'RAM Hand-to-Hand Couriers';
// A long history is a few kilobytes.
export const RAM_MAX_BYTES = 256 * 1024;
// Waybills such as RAM and eight digits, and shorter references of letters and digits. The
// lookup answers for anything, and cuts the number it echoes to thirty characters.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,30}$/;
const CLOCK = /^\d{2}:\d{2}$/;
// The only line of a reply for a number RAM does not know.
const NOT_FOUND = /^no tracking found\.?$/i;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A number for RAM's tracker, in upper case as the lookup echoes it; anything else is not one RAM issues. */
export function normalizeRamNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'RAM waybills are six to thirty letters and digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `RAM returned an invalid ${key}`);
  return clean(value, maxLength);
}

// Who took the parcel, after a delivery's wording ("DELIVERED, RECEIVED BY …").
const RECEIVER = /[\s,;:.\-–]*\b(?:RECEIVED|SIGNED)\s+BY\b[\s\S]*$/i;
// A detail kept after the wording and ` - `: a reason, a call's subject or a message's text, in
// words only. Notes staff type, with RAM's # over digits, addresses or e-mail addresses, are not.
const DETAIL = /^[A-Za-z][A-Za-z ,'&()/]{0,79}$/;
// A road leg names both ends; the scan happened where it left from or arrived.
const DEPARTURE = /^(DEPARTED BY [A-Z]+ TO .+?) FROM (.+)$/;
const ARRIVAL = /^(ARRIVED BY [A-Z]+ FROM .+?) TO (.+)$/;
// The tracker's capitalized wording, then IN and the place of the scan.
const PLACED = /^([A-Z]+(?: [A-Z]+)*?) IN (\S.*)$/;
// RAM's word for the sender's premises, which names no place.
const CLIENT_SITE = /^client site$/i;

/**
 * A line of the tracker as a scan's wording and place: the place after `IN`
 * or at the scanning end of a road leg moves to the location, and the line
 * keeps one detail after ` - `. A delivery loses who took the parcel; a staff
 * note after the detail is dropped.
 */
export function ramLine(raw: string): { description: string; location?: string } {
  const line = clean(raw.replace(RECEIVER, ''), 2000);
  const [head = '', detail = ''] = line.split(' - ').map((part) => part.trim().replace(/[\s.]+$/, ''));
  const road = DEPARTURE.exec(head) ?? ARRIVAL.exec(head);
  const placed = road ? null : PLACED.exec(head);
  const wording = road?.[1] ?? placed?.[1] ?? head;
  const place = clean(road?.[2] ?? placed?.[2], 120);
  const description = DETAIL.test(detail) ? `${wording} - ${detail}` : wording;
  return { description, ...(place && !CLIENT_SITE.test(place) ? { location: place } : {}) };
}

/**
 * A scan's wall clock, from its day's `d MMMM yyyy` heading and its `HH:mm`
 * time. The reply names no zone, so the clock stays local.
 */
function wallClock(date: string, time: string): string {
  const day = DateTime.fromFormat(date, 'd MMMM yyyy', { zone: 'UTC', locale: 'en' });
  const local = day.isValid && CLOCK.test(time) ? `${day.toFormat('yyyy-MM-dd')}T${time}:00` : '';
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  if (!local || DateTime.fromISO(local, { zone: 'UTC' }).toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'RAM returned an invalid scan time');
  }
  return local;
}

/** The tracker's lines, oldest first, with the not-found lines counted apart. */
function lines(groups: unknown[]): { scans: { local: string; said: string }[]; unknown: number } {
  const scans: { local: string; said: string }[] = [];
  let unknown = 0;
  let rows = 0;
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.events)) throw new SchemaError(PROVIDER, 'RAM returned an invalid day of scans');
    const date = text(group, 'date', 40);
    let previous = '';
    for (const row of group.events) {
      rows += 1;
      if (rows > MAX_ROWS) throw new SchemaError(PROVIDER, 'RAM returned an oversized history');
      if (!isRecord(row)) throw new SchemaError(PROVIDER, 'RAM returned an invalid scan');
      const said = text(row, 'description', 2000);
      if (!said) throw new SchemaError(PROVIDER, 'RAM returned a scan without wording');
      if (NOT_FOUND.test(said)) {
        unknown += 1;
        previous = '';
        continue;
      }
      const local = wallClock(date, text(row, 'time', 16));
      // The page shows a run of the same line on one day once, at its last time: one per parcel of the waybill.
      if (said === previous) {
        scans.at(-1)!.local = local;
        continue;
      }
      previous = said;
      scans.push({ local, said });
    }
  }
  return { scans, unknown };
}

/**
 * The reply of the tracking page's `/api/track/{number}`: the number, the
 * sender's reference and the scans grouped by day, oldest first. An unknown
 * number gets HTTP 200 and one `NO TRACKING FOUND` line, which the page
 * reports as not found. The reply must echo the whole number asked.
 */
export function parseRam(payload: unknown, raw: string): CarrierResult {
  const number = normalizeRamNumber(raw);
  if (!isRecord(payload) || typeof payload.waybillNo !== 'string' || !Array.isArray(payload.groups)) {
    throw new SchemaError(PROVIDER, 'RAM returned an invalid reply');
  }
  if (clean(payload.waybillNo, 64).toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'RAM answered for another waybill');
  const { scans, unknown } = lines(payload.groups);
  if (!scans.length) {
    if (unknown) throw new NotFoundError(PROVIDER);
    throw new NoHistoryError(PROVIDER);
  }

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  // Newest first; the stable sort keeps the reply's order, turned round, within a minute.
  for (const { local, said } of scans.reverse().sort((left, right) => right.local.localeCompare(left.local))) {
    const { description, location } = ramLine(said);
    const key = JSON.stringify([local, description, location]);
    if (!description || seen.has(key)) continue;
    seen.add(key);
    const staged = ramStage(description);
    events.push({
      local_time: local,
      ...(location ? { location } : {}),
      description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    });
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);

  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  const stage = scanned?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: scanned!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
