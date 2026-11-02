import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { classifyWording, languageStageStatus, type Stage } from '../../core/status/index.js';
import { zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { nextLevelStage } from './status.js';

export const PROVIDER = 'Next Level';
export const CARRIER = 'next-level-delivery';
// A long history is a few kilobytes.
export const NEXT_LEVEL_MAX_BYTES = 256 * 1024;
// Next Level's own movements, read in Sofia time.
const ZONE = 'Europe/Sofia';
// Thirteen-digit shipments and eight-digit return shipments.
const NUMBER = /^(?:\d{8}|\d{13})$/;
const CLOCK = /^(\d{4}-\d{2}-\d{2}) ((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)$/;
const STATUS_ID = /^\d{1,6}$/;
const PARTNER_NUMBER = /^[A-Z0-9]{4,40}$/;
// The postcode the tracker writes after a town, "Town (1000)".
const POSTCODE = /\s*\([^()]*\d[^()]*\)$/;
// An office or town as the tracker names it: no digits, which a street would carry.
const PLACE = /^\p{L}[\p{L}\p{M} .,'’&/-]{0,79}$/u;
// The movement that hands the parcel to the subcontractor delivering it.
const SUBCONTRACTOR = /подизпълнител|subcontractor/i;
// Movements that can happen at the recipient's or the sender's address.
const AT_ADDRESS: readonly Stage[] = ['delivered', 'failed_attempt', 'returned'];
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

type Row = Record<string, unknown>;

/** A Next Level waybill as its tracker looks it up: its digits only. */
export function normalizeNextLevelNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Next Level waybills are thirteen digits, or eight for a return shipment');
  return number;
}

/** A waybill a movement names, normalized; an object or other value is a changed reply. */
function identifier(row: Row, key: string): string {
  const value = row[key];
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Next Level returned an invalid ${key}`);
  return value.length <= 64 ? normalizeTrackingNumber(value) : '';
}

/** The status id of a movement; the subcontractor's acceptance has none. */
function statusId(row: Row): string {
  const value = row.status_id;
  if (value === null || value === undefined) return '';
  const code = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value)
    : typeof value === 'string' ? value.trim() : '';
  if (!STATUS_ID.test(code)) throw new SchemaError(PROVIDER, 'Next Level returned an invalid status id');
  return code;
}

/**
 * The clock of a movement. Next Level's own are Sofia wall clocks, kept as
 * local time in the hour a clock change skips or repeats. The subcontractor's
 * can be another country's, so they stay local time.
 */
function scanClock(value: unknown, abroad: boolean): Pick<CarrierEvent, 'time'> | { local_time: string } {
  const text = typeof value === 'string' ? value.trim() : '';
  const match = CLOCK.exec(text);
  const parsed = match ? zonedTime(text, 'yyyy-MM-dd HH:mm:ss', ZONE) : null;
  if (!match || !parsed) throw new SchemaError(PROVIDER, 'Next Level returned an invalid movement time');
  const wall = `${match[1]}T${match[2]}`;
  const unique = DateTime.fromISO(wall, { zone: ZONE }).getPossibleOffsets().length === 1;
  return !abroad && parsed.iso.startsWith(wall) && unique ? { time: parsed.iso } : { local_time: wall };
}

/**
 * The office or town of a movement, without its postcode. A movement still at
 * the sender can name the sender's site, and a delivery, an attempt or a
 * return can be at an address, so theirs is not kept.
 */
function place(value: unknown, code: string, stage: Stage | undefined): string {
  if (code === '1' || (stage && AT_ADDRESS.includes(stage))) return '';
  const text = clean(value, 120).replace(POSTCODE, '');
  return PLACE.test(text) ? text : '';
}

/**
 * The reply of the lookup Next Level's tracker page makes,
 * `POST api.nextlevel.delivery/v1/track` with `{ ids: [number] }`: one list of
 * movements per number asked, oldest first, and an empty list for a number the
 * tracker does not have. Every movement names the waybill in `parcel` and the
 * subcontractor's waybill in `courier_awb`, which repeats `parcel` while no
 * subcontractor is involved. The tracker also finds a shipment by the
 * subcontractor's waybill; such a reply is the subcontractor's shipment. The
 * person who scanned (`worker`), free-text comments and the return shipment's
 * original waybill are never read.
 */
export function parseNextLevel(payload: unknown, raw: string): CarrierResult {
  const number = normalizeNextLevelNumber(raw);
  if (!Array.isArray(payload) || payload.length !== 1 || !Array.isArray(payload[0])) {
    throw new SchemaError(PROVIDER, 'Next Level returned a reply that is not one list of movements');
  }
  const rows: unknown[] = payload[0];
  // The page shows nothing under the number: the tracker has no such waybill.
  if (!rows.length) throw new NotFoundError(PROVIDER);
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Next Level returned an oversized history');
  if (!rows.every(isRecord)) throw new SchemaError(PROVIDER, 'Next Level returned an invalid movement');
  const records = rows as Row[];
  const parcels = records.map((row) => identifier(row, 'parcel'));
  const partners = records.map((row) => identifier(row, 'courier_awb'));
  if (parcels.some((parcel) => parcel !== number)) {
    if (partners.includes(number)) throw new IndeterminateError(PROVIDER, 'Next Level found a shipment by its subcontractor\'s waybill');
    throw new IndeterminateError(PROVIDER, 'Next Level answered for another waybill');
  }
  const handedOver = [...new Set(partners.filter((partner) => partner && partner !== number))];
  const delivery = handedOver.length === 1 && PARTNER_NUMBER.test(handedOver[0]!) ? handedOver[0] : undefined;

  // From the subcontractor's acceptance on, movements are the subcontractor's.
  let abroad = false;
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of records) {
    const code = statusId(row);
    const status = clean(row.status, 120);
    const description = clean(row.description, 200) || status;
    if (!description) throw new SchemaError(PROVIDER, 'Next Level returned a movement without its description');
    abroad ||= SUBCONTRACTOR.test(description) || SUBCONTRACTOR.test(status);
    const stage = nextLevelStage(code || null, description);
    // An unknown id's wording still decides whether its place can be an address.
    const location = place(row.place, code, stage ?? classifyWording(description).stage);
    const event: CarrierEvent = {
      ...scanClock(row.date, abroad),
      description,
      ...(location ? { location } : {}),
      ...(code ? { provider_code: code } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
    };
    const key = JSON.stringify(event);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(event);
  }
  // Subcontractor clocks are not instants, so the reply's order stands, newest first.
  events.reverse();
  const newest = events[0]!;
  const stage = events.find((event) => event.stage)?.stage as Stage | undefined;
  const delivered = stage === 'delivered' ? events.find((event) => event.stage === 'delivered') : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    ...(delivered?.time ? { delivered_at: delivered.time } : {}),
    ...(delivery ? { delivery_tracking_number: delivery } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
