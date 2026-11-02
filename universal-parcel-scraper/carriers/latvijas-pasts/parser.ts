import { DateTime } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { lastMovement } from '../../core/result/pickup.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryTimeZone, isoTime } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { latvijasPastsStage } from './status.js';

export const PROVIDER = 'Latvijas Pasts';
// A long history is a few kilobytes.
export const LATVIJAS_PASTS_MAX_BYTES = 256_000;

const MAX_ROWS = 500;
const MAX_EVENTS = 100;
const HOME_ZONE = 'Europe/Riga';
const CODE = /^\d{1,6}$/;
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.\d{1,6})?$/;
// The notices the English tracker gives instead of a history.
const NOT_FOUND = 'No information received on the tracking of the postal item. Please, try again!';
const MALFORMED = 'Postal item number entered incorrectly. Please check it and enter it again.';
// An office without an English name comes back as the company's own name, which places nothing.
const NO_PLACE = /^(?:latvijas )?pasts$/i;
// An office's postcode, which the Latvian names carry.
const POSTCODE = /,?\s*\bLV-?\d{4}\b/gi;

/** Latvijas Pasts tracks UPU S10 items, its own and those it delivers for other posts. */
export function normalizeLatvijasPastsNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (isValidS10TrackingNumber(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Latvijas Pasts tracks S10 item codes');
}

/** The scan's clock ("2026-03-04 09:15:00.000") as a wall clock. It carries no offset. */
function wallClock(value: unknown): string | null {
  const match = typeof value === 'string' ? CLOCK.exec(value.trim()) : null;
  if (!match) return null;
  // UTC only checks the calendar fields. No offset is assigned.
  const parsed = DateTime.fromFormat(`${match[1]} ${match[2]}`, 'yyyy-MM-dd HH:mm:ss', { zone: 'UTC' });
  return parsed.isValid ? parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") : null;
}

/**
 * When the scan happened. A Latvian office's scan is on Riga's clock and a
 * foreign post's on its country's, when that country keeps a single clock;
 * otherwise, and when the wall clock is ambiguous at a change of summer time,
 * it stays a local time.
 */
function clockOf(wall: string, zone: string | null): { time: string } | { local_time: string } {
  if (zone && DateTime.fromISO(wall, { zone }).getPossibleOffsets().length === 1) {
    const placed = isoTime(wall, zone);
    if (placed?.iso.startsWith(wall)) return { time: placed.iso };
  }
  return { local_time: wall };
}

/** The office the scan names, else the country a foreign post's event comes from. */
function placeOf(row: Record<string, unknown>): { name: string; office: boolean } {
  const office = clean(row.office, 200).replace(POSTCODE, '').trim();
  if (office) return { name: NO_PLACE.test(office) ? '' : office, office: true };
  return { name: clean(row.country, 100), office: false };
}

interface Scan { readonly event: CarrierEvent; readonly wall: string; readonly office: boolean; readonly group: number; readonly index: number }

/**
 * The tracker's reply for one item: its scans newest first, each with an event
 * code, wording, a wall clock and the office, or the country of a foreign
 * post's event, or a notice instead. The reply does not repeat the number; it
 * answers for the one number the request names.
 */
export function parseLatvijasPasts(payload: unknown, rawNumber: string): CarrierResult {
  normalizeLatvijasPastsNumber(rawNumber);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Latvijas Pasts did not return an item');
  // The tracker shows the history when there is one, else the notice.
  if (!Object.hasOwn(payload, 'data')) {
    if (typeof payload.info !== 'string') throw new SchemaError(PROVIDER, 'Latvijas Pasts returned neither a history nor a notice');
    const notice = clean(payload.info, 300);
    if (notice === NOT_FOUND) throw new NotFoundError(PROVIDER);
    if (notice === MALFORMED) throw new InvalidInputError(PROVIDER, 'Latvijas Pasts does not accept this item code', { reason: 'wrong_number' });
    throw new IndeterminateError(PROVIDER, 'Latvijas Pasts returned a notice instead of the item history');
  }
  const rows = payload.data;
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Latvijas Pasts returned an invalid item history');

  const scans: Scan[] = [];
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Latvijas Pasts returned an invalid scan');
    const code = cleanScalar(row.event_code, 16);
    const time = wallClock(row.event_timestamp);
    if (!CODE.test(code) || !time) throw new SchemaError(PROVIDER, 'Latvijas Pasts returned a scan without a code or clock');
    const place = placeOf(row);
    const zone = place.office ? HOME_ZONE : countryTimeZone(place.name);
    const event: CarrierEvent = { ...clockOf(time, zone), description: clean(row.event, 300) || code, provider_code: code,
      ...(place.name ? { location: place.name } : {}) };
    // A foreign post's event can come twice.
    const identity = JSON.stringify(event);
    if (seen.has(identity)) return;
    seen.add(identity);
    const group = Number(row.event_group_sequence_number);
    scans.push({ event, wall: time, office: place.office, group: Number.isInteger(group) ? group : 0, index });
  });
  if (!scans.length) throw new IndeterminateError(PROVIDER, 'Latvijas Pasts returned no scans');
  // Newest first. Scans at the same second follow the tracker's progress
  // groups, from created to delivered, then the reply's order.
  scans.sort((left, right) => (right.wall > left.wall ? 1
    : right.wall < left.wall ? -1 : right.group - left.group || left.index - right.index));
  const events = scans.map(({ event }) => event);
  for (const event of events) {
    const classified = latvijasPastsStage(event.provider_code!, event.description!);
    if (classified) Object.assign(event, { stage: classified.stage, stage_source: classified.source });
  }

  const latest = events[0]!;
  const stage = latest.stage as Stage | undefined;
  // The Latvian office an item waits at is its pickup point. A delivered item
  // was collected there when it waited there last before the delivery.
  const waiting = stage === 'ready_for_pickup' ? scans[0]
    : stage === 'delivered' && lastMovement(events.slice(1)) === 'ready_for_pickup'
      ? scans.slice(1).find(scan => scan.event.stage === 'ready_for_pickup') : undefined;
  const point = waiting?.office ? waiting.event.location ?? '' : '';

  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: latest.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    ...(latest.time ? {} : { last_update_local: latest.local_time! }),
    expected_delivery: null,
    ...(point ? { pickup_point: point } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
