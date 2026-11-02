import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, explicitOffsetTime } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { isImileRelay, topyouStage } from './status.js';

export const PROVIDER = 'TopYou';
// A long history is a few kilobytes.
export const TOPYOU_MAX_BYTES = 256 * 1024;
// The waybills TopYou issues: TYZR, a letter, ten digits and YQ.
const NUMBER = /^TYZR[A-Z]\d{10}YQ$/;
const CLOCK = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}:\d{2}:\d{2})$/;
const OFFSET = /^[+-]\d{2}:\d{2}$/;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A TopYou waybill in upper case, as its tracker matches it; anything else is not one it issues. */
export function normalizeTopyouNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'TopYou waybills are TYZR, a letter, ten digits and YQ');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `TopYou returned an invalid ${key}`);
  return clean(value, maxLength);
}

// The offset TopYou states for its own scans, on China's clock.
const OWN_OFFSET = '+08:00';

/**
 * A scan's clock. TopYou's own scans state +08:00. The delivery carrier's
 * come either as a wall clock without an offset, which their place dates
 * (USPS's), or on a UTC wall clock under another offset: GOFO's scans in
 * France and Italy, stated +01:00, came an hour before GOFO's own instants
 * for them, and iMile's in Germany, stated +08:00 like TopYou's own, eight
 * hours before iMile's.
 */
function scanClock(row: Record<string, unknown>, imile: boolean): { time: string } | { local_time: string } {
  const match = CLOCK.exec(text(row, 'changeDate', 32));
  const zone = text(row, 'timeZone', 8);
  const local = match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}` : '';
  // Parsing in UTC checks the calendar digits only; Luxon rolls 24:00 over, so only a clock that reads back unchanged is kept.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!match || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local || (zone && !OFFSET.test(zone))) {
    throw new SchemaError(PROVIDER, 'TopYou returned an invalid scan time');
  }
  if (!zone) return { local_time: local };
  const instant = explicitOffsetTime(`${local}${zone === OWN_OFFSET && !imile ? zone : '+00:00'}`);
  if (!instant) throw new SchemaError(PROVIDER, 'TopYou returned an invalid scan time');
  return { time: instant.iso };
}

/**
 * A scan's place. TopYou's own scans name the destination country, the
 * origin airport's included, so a place that is only countries is left out
 * of them; the delivery carrier's scans keep theirs.
 */
function place(row: Record<string, unknown>, own: boolean): string {
  const location = text(row, 'location', 120);
  if (own && location.split(',').every((part) => countryCode(part))) return '';
  return location;
}

// A closing preposition whose place the tracker left empty, as "Departed from customs of ".
const DANGLING = /\s+(?:of|to|in|at|from)$/i;

function projectRow(row: Record<string, unknown>): { key: string; clock: string; event: CarrierEvent } {
  const description = text(row, 'record').replace(DANGLING, '');
  if (!description) throw new SchemaError(PROVIDER, 'TopYou returned a scan without wording');
  const code = cleanScalar(row.status, 8);
  const imile = isImileRelay(description);
  const clock = scanClock(row, imile);
  // TopYou's own scans state China's offset; the delivery carriers' relayed scans state another, or iMile's the same.
  const location = place(row, text(row, 'timeZone', 8) === OWN_OFFSET && !imile);
  const staged = topyouStage(code, description);
  const event: CarrierEvent = {
    ...clock,
    ...(location ? { location } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  const raw = text(row, 'changeDate', 32);
  return { key: JSON.stringify([raw, text(row, 'timeZone', 8), code, description, location]), clock: raw, event };
}

/** The tracker's summary of a parcel whose journey ended, which it shows over the scans. */
function summaryStage(track: Record<string, unknown>): Stage | undefined {
  const status = cleanScalar(track.status, 8);
  if (status === '30') return 'delivered';
  if (status === '40') return 'returned';
  return undefined;
}

/** The weight TopYou charged, in kilograms. */
function weight(track: Record<string, unknown>): number | undefined {
  const value = Number(cleanScalar(track.weight, 16));
  return Number.isFinite(value) && value > 0 && value < 1000 ? value : undefined;
}

/**
 * The reply of the tracker's `/order/track` for one waybill. A number it does
 * not know comes back with no scans and no destination, which the page shows
 * as not found; an order with a destination and no scans is announced only.
 * The tracker echoes the number asked, so the entry must name it.
 */
export function parseTopyou(payload: unknown, raw: string): CarrierResult {
  const number = normalizeTopyouNumber(raw);
  if (!isRecord(payload) || !isRecord(payload.data)) throw new SchemaError(PROVIDER, 'TopYou returned an invalid envelope');
  if (payload.success !== true || payload.data.success !== 'true') throw new IndeterminateError(PROVIDER, 'TopYou did not complete the lookup');
  const tracks = payload.data.tracks;
  if (!Array.isArray(tracks) || !tracks.length || !tracks.every(isRecord)) throw new SchemaError(PROVIDER, 'TopYou returned invalid tracks');
  const track = tracks.find((entry) => text(entry, 'trackNumber', 64).toUpperCase() === number);
  if (!track) throw new IndeterminateError(PROVIDER, 'TopYou answered for another shipment');
  const rows = track.trackInfo ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'TopYou returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'TopYou returned an oversized history');
  const destination = text(track, 'dCountry', 80);
  // The page's "暂无轨迹信息" (no tracking information yet).
  if (track.success === 'false') throw new NoHistoryError(PROVIDER);
  if (!rows.length) {
    // The page's "预上网" (announced) when the order has a destination, else "查询不到" (not found).
    if (destination) throw new NoHistoryError(PROVIDER);
    throw new NotFoundError(PROVIDER);
  }

  const seen = new Set<string>();
  const scans: ReturnType<typeof projectRow>[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'TopYou returned an invalid scan');
    const scan = projectRow(row);
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    scans.push(scan);
  }
  // Newest first; the tracker lists them oldest first.
  if (scans[0]!.clock < scans.at(-1)!.clock) scans.reverse();

  const events = scans.map((scan) => scan.event);
  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  const summary = summaryStage(track);
  const stage = (summary ?? scanned?.stage) as Stage | undefined;
  const source = summary && summary !== scanned?.stage ? 'carrier_map' : scanned?.stage_source;
  const deliveredAt = stage === 'delivered' ? events.find((event) => event.stage === 'delivered')?.time : undefined;
  const country = countryCode(destination);
  const transfer = normalizeTrackingNumber(text(track, 'transferNo', 64)).toUpperCase();
  const kilograms = weight(track);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.time ? {} : { last_update_local: newest.local_time }),
    ...(deliveredAt ? { delivered_at: deliveredAt } : {}),
    ...(kilograms ? { weight_kg: kilograms } : {}),
    ...(country ? { destination_country: country } : destination ? { destination_country_name: destination } : {}),
    // The number the delivery carrier tracks it by. TopYou's `carrierCode` names its own line,
    // not that carrier (a parcel USPS delivered came under "DHL Paket"), so it is not read.
    ...(/^[A-Z0-9]{4,40}$/.test(transfer) && transfer !== number ? { delivery_tracking_number: transfer } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
