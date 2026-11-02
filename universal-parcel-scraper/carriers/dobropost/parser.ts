import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { dobropostStage } from './status.js';

export const PROVIDER = 'DobroPost';
// A long history is under ten kilobytes; a refused key comes back with a Java stack trace of about fifteen.
export const DOBROPOST_MAX_BYTES = 512 * 1024;
// DobroPost's own parcel numbers, the layout its tracker asks for.
const NUMBER = /^DBRPST\d{10}$/;
const NOT_FOUND = /^Parcel with trackCode - (.{0,64}) not found$/;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A DobroPost parcel number in capitals; anything else is not one its tracker looks up as a parcel. */
export function normalizeDobropostNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'DobroPost parcel numbers are DBRPST and ten digits');
  return number;
}

// A run of nine or more digits, with spaces, brackets, dots or hyphens
// between them, as phone numbers are written.
const PHONE = /(?<![\p{L}\d])\+?\d(?:[\s().-]{0,2}\d){8,}(?![\p{L}\d])/gu;
// The town CDEK's scans name in brackets at the end: "Вручен (Нижний Новгород)".
const PLACE = /^(.*?\S)\s*\((\p{L}[\p{L}\s.'’-]{0,79})\)$/u;

/**
 * A scan's wording, in Russian as the page shows it, and the town a relayed
 * scan names at its end. The registry scan's wording ends with a number sign
 * whose number the tracker leaves out. Phone numbers are dropped.
 */
export function dobropostWording(russian: string, code: string): { description: string; location?: string } {
  const text = clean(clean(russian, 600).replace(PHONE, ''), 500).replace(/\s*№$/, '');
  const place = PLACE.exec(text);
  if (place) return { description: place[1]!, location: clean(place[2], 80) };
  return { description: text || code };
}

/** An optional text field; anything but a string or null is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength: number): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `DobroPost returned an invalid ${key}`);
  return clean(value, maxLength);
}

function category(row: Record<string, unknown>): number | null {
  const value = row.statusCategoryId;
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new SchemaError(PROVIDER, 'DobroPost returned an invalid status category');
  return value;
}

interface Scan { key: string; timestamp: number; event: CarrierEvent & { time: string; description: string } }

/**
 * One checkpoint. Its `date` carries an offset: the backend writes every
 * instant at Moscow's, its China warehouse scans included, so the offset is
 * kept and the clock is an instant.
 */
function projectRow(row: Record<string, unknown>): Scan {
  const clock = typeof row.date === 'string' ? explicitOffsetTime(row.date) : null;
  if (!clock) throw new SchemaError(PROVIDER, 'DobroPost returned an invalid scan time');
  // CDEK's codes can come with a trailing tab.
  const code = text(row, 'statusName', 120).toUpperCase();
  const { description, location } = dobropostWording(text(row, 'statusRUName', 600), code);
  if (!description) throw new SchemaError(PROVIDER, 'DobroPost returned a scan without wording');
  const staged = dobropostStage(code, description, category(row));
  const event = {
    time: clock.iso,
    ...(location ? { location } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([clock.timestamp, code, description, location ?? '']), timestamp: clock.timestamp, event };
}

/** The recipient's country as the reply names it ("Russia (Russian Federation)"). */
function destination(payload: Record<string, unknown>): Pick<CarrierResult, 'destination_country' | 'destination_country_name'> {
  const name = text(payload, 'recipientCountry', 80);
  const code = countryCode(name) ?? countryCode(name.replace(/\s*\([^()]*\)$/, ''));
  if (code) return { destination_country: code };
  return name ? { destination_country_name: name } : {};
}

/**
 * The reply of `GET /api/tracking/parcel` for one number: the countries and
 * the checkpoints, newest first, without the number. The service matches the
 * whole number only, in any case, so the request binds the reply to it. The
 * history is sorted by instant, since a relayed scan can be listed out of turn.
 */
export function parseDobropost(payload: unknown, raw: string): CarrierResult {
  normalizeDobropostNumber(raw);
  if (!isRecord(payload) || !Array.isArray(payload.checkpoints)) throw new SchemaError(PROVIDER, 'DobroPost returned a parcel without checkpoints');
  const rows: unknown[] = payload.checkpoints;
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'DobroPost returned an oversized history');

  const seen = new Set<string>();
  const scans: Scan[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'DobroPost returned an invalid checkpoint');
    const scan = projectRow(row);
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    scans.push(scan);
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first; equal instants keep the reply's order.
  const events = scans.map((scan, index) => ({ scan, index }))
    .sort((a, b) => b.scan.timestamp - a.scan.timestamp || a.index - b.index).map(({ scan }) => scan.event);

  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description,
    last_update: newest.time,
    expected_delivery: null,
    ...(stage === 'delivered' ? { delivered_at: current!.time } : {}),
    ...destination(payload),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}

/**
 * The service's HTTP 404 reply, which names the number it could not find:
 * `{"status":404,"message":"Parcel with trackCode - … not found"}`. Any other
 * 404 is a moved route.
 */
export function parseDobropostMissing(payload: unknown, raw: string): never {
  const number = normalizeDobropostNumber(raw);
  const message = isRecord(payload) && typeof payload.message === 'string' ? NOT_FOUND.exec(payload.message.trim()) : null;
  if (!message) throw new TransportError(PROVIDER, 'DobroPost tracking lookup is unavailable');
  if (message[1]!.trim().toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'DobroPost answered for another parcel');
  throw new NotFoundError(PROVIDER);
}
