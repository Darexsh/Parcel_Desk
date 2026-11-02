import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { HYWL_CHINA_ZONE, hywlInChina } from './clock.js';
import { hywlStage } from './status.js';

export const PROVIDER = 'Huiyi Logistics';
// A history is a few kilobytes.
export const HYWL_MAX_BYTES = 256 * 1024;
// TRK and twelve upper-case hexadecimal characters, or four letters, two digits, D, four digits and
// four letters; the tracker matches the number case-sensitively.
const NUMBER = /^(?:TRK[0-9A-F]{12}|[A-Z]{4}\d{2}D\d{4}[A-Z]{4})$/;
// The reply's own label for every shipment it holds.
const CARRIER_LABEL = 'SZHYWL';
const STAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})?$/;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A Huiyi Logistics number; anything else is a number its tracker is not asked for. */
export function normalizeHywlNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Huiyi Logistics numbers are TRK and twelve hexadecimal characters, or four letters, two digits, D, four digits and four letters');
  return number;
}

/** The unknown-number answer of `GET /tracking/{number}`, sent with HTTP 404. */
export function isHywlNotFound(payload: unknown): boolean {
  return isRecord(payload) && Object.keys(payload).length === 1 && payload.detail === 'tracking number not found';
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 500): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Huiyi Logistics returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * A place without its postcode. Destination rows name the recipient's town and
 * postcode, and the first row a town and an office code: each comma-separated
 * part ends before its first digit, and a part that starts with one is dropped.
 */
export function hywlPlace(raw: string): string {
  return raw.split(/[,，]/).map((part) => {
    const digit = part.search(/\d/);
    let kept = digit === -1 ? part : part.slice(0, digit);
    // A Latin word the digits were written into, such as a postcode district, goes with them.
    if (digit > 0 && /[A-Za-z]$/.test(kept)) kept = kept.replace(/[A-Za-z]+$/, '');
    return clean(kept.replace(/[\s\-–/(]+$/, ''), 100);
  }).filter(Boolean).join(', ');
}

/**
 * A row's wording without the postcodes it repeats: the row's place, as
 * written, is replaced by the place kept, and every bracketed place loses its
 * postcode too. Wording from a signatory on is cut, and any other run of four
 * or more digits is dropped.
 */
export function hywlWording(description: string, location: string, place: string): string {
  const placed = location ? description.split(location).join(place) : description;
  return clean(placed
    .replace(/【([^】]*)】/g, (_, inner: string) => `【${hywlPlace(inner)}】`)
    .replace(/\[([^\]]*)\]/g, (_, inner: string) => `[${hywlPlace(inner)}]`)
    .replace(/(?:签收人|signed (?:for )?by|signatory)[\s\S]*$/i, '')
    .replace(/\s*\d{4,}/g, '')
    .replace(/【\s*】|\[\s*\]/g, '')
    .replace(/\s+([,，])/g, '$1')
    .replace(/([,，])(?:\s*[,，])+/g, '$1'))
    .replace(/^[,，\s]+|[,，\s]+$/g, '');
}

/**
 * The English half of a bilingual row, "Delivered【Town】, 已妥投【Town】": the
 * Chinese half translates it, and the rows of the English wording carry it
 * alone, with the place in square brackets ("Delivered [Town]"). A row is kept
 * whole when its Chinese half names another place or holds Latin text.
 */
export function hywlEnglishHalf(wording: string): string {
  const match = /^([A-Za-z][^【】[\]\p{Script=Han},，]*?)\s*(?:【([^】]*)】)?[,，]\s*(.+)$/u.exec(wording);
  if (!match) return wording;
  const [, english, place = '', chinese] = match;
  const outside = chinese!.replace(/【[^】]*】|\[[^\]]*\]/g, '');
  if (!/\p{Script=Han}/u.test(outside) || /[A-Za-z]/.test(outside)) return wording;
  if ([...chinese!.matchAll(/【([^】]*)】|\[([^\]]*)\]/g)].some((named) => (named[1] ?? named[2]) !== place)) return wording;
  return place ? `${english!.trim()} [${place}]` : english!.trim();
}

/** A row's wall clock. Its `+00:00` and `UTC` are not kept: see the README. */
function wallClock(stamp: string): string {
  const match = STAMP.exec(stamp);
  const local = match ? `${match[1]}T${match[2]}` : '';
  const parsed = local ? DateTime.fromISO(local, { zone: 'UTC' }) : null;
  // Luxon rolls 24:00:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!parsed?.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'Huiyi Logistics returned an invalid scan time');
  }
  return local;
}

function projectRow(row: unknown, readAt: number): { key: string; clock: string; event: CarrierEvent } | null {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Huiyi Logistics returned an invalid scan');
  const stamp = text(row, 'time', 64);
  const code = text(row, 'status_code', 64);
  const location = text(row, 'location', 200);
  const place = hywlPlace(location);
  const description = hywlEnglishHalf(hywlWording(text(row, 'description'), location, place)) || code;
  if (!stamp || !description) throw new SchemaError(PROVIDER, 'Huiyi Logistics returned a scan without a time or wording');
  const local = wallClock(stamp);
  // A row in China is on Beijing's clock; any other keeps its wall clock.
  const instant = hywlInChina(place) ? firstOccurrence(DateTime.fromISO(local, { zone: HYWL_CHINA_ZONE })) : null;
  // A row dated after the read is not a scan yet: one in China by its instant, any other as the reply labels it.
  if ((instant ?? DateTime.fromISO(local, { zone: 'UTC' })).toMillis() > readAt) return null;
  const staged = hywlStage(code, description);
  const event: CarrierEvent = {
    ...(instant ? { time: instant.toISO({ suppressMilliseconds: true })! } : { local_time: local }),
    description,
    ...(place ? { location: place } : {}),
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([local, code, description, place]), clock: local, event };
}

/**
 * The reply of `GET /tracking/{number}`. It names the shipment it holds, and
 * that number must be the one asked. Rows come oldest first; they are returned
 * newest first by their wall clocks, which all carry the same label. The
 * summary status, its update time and the origin are not read: rows held back
 * can be ahead of them.
 */
export function parseHywl(payload: unknown, raw: string, readAt = Date.now()): CarrierResult {
  const number = normalizeHywlNumber(raw);
  if (!isRecord(payload) || typeof payload.success !== 'boolean') throw new SchemaError(PROVIDER, 'Huiyi Logistics returned an invalid envelope');
  if (!payload.success) throw new IndeterminateError(PROVIDER, 'Huiyi Logistics did not complete the lookup');
  if (typeof payload.tracking_number !== 'string' || typeof payload.carrier !== 'string') {
    throw new SchemaError(PROVIDER, 'Huiyi Logistics returned a shipment without its number');
  }
  if (payload.tracking_number !== number) throw new IndeterminateError(PROVIDER, 'Huiyi Logistics answered with another shipment');
  if (payload.carrier !== CARRIER_LABEL) throw new IndeterminateError(PROVIDER, 'Huiyi Logistics answered for another carrier');
  const rows = payload.events;
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Huiyi Logistics returned a shipment without scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Huiyi Logistics returned an oversized history');

  const seen = new Set<string>();
  const events: { clock: string; event: CarrierEvent }[] = [];
  for (const row of rows) {
    const scan = projectRow(row, readAt);
    if (!scan || seen.has(scan.key)) continue;
    seen.add(scan.key);
    events.push(scan);
  }
  // The page reads an empty list as "found, no scans yet".
  if (!events.length) throw new IndeterminateError(PROVIDER, 'Huiyi Logistics has no scans for the shipment yet');
  // Oldest first in the reply; a stable sort keeps the order of rows on one clock.
  const newestFirst = events.map(({ clock, event }, index) => ({ clock, event, index }))
    .sort((a, b) => (a.clock === b.clock ? b.index - a.index : a.clock < b.clock ? 1 : -1))
    .map(({ event }) => event);

  const newest = newestFirst[0]!;
  const current = newestFirst.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const destination = text(payload, 'destination_country', 8).toUpperCase();
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    ...(/^[A-Z]{2}$/.test(destination) ? { destination_country: destination } : {}),
    events: newestFirst.slice(0, MAX_EVENTS),
    ...(newestFirst.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
