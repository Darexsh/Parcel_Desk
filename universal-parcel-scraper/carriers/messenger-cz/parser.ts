import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { lastMovement } from '../../core/result/pickup.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { EXPLICIT_OFFSET_PATTERN, firstOccurrence } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { messengerMappedStage, messengerStage, messengerState } from './status.js';

export const PROVIDER = 'Messenger';
// A long history is a few kilobytes; the reply also carries the courier's live position.
export const MESSENGER_MAX_BYTES = 512 * 1024;

const PRAGUE = 'Europe/Prague';
const BRATISLAVA = 'Europe/Bratislava';
const MAX_ROWS = 500;
// The tracking page's own check, eight or fifteen characters; a number holds a digit.
const NUMBER = /^(?=[A-Z]*\d)(?:[A-Z\d]{8}|[A-Z\d]{15})$/;
// A wall clock without an offset, "2026-09-15T10:20:00".
const WALL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?$/;
// Epoch milliseconds between 2000 and 2100.
const EPOCH_MIN = 946_684_800_000;
const EPOCH_MAX = 4_102_444_800_000;
// A scan in Messenger's Slovak network, by the text the tracker gives it.
const SLOVAKIA = /bratislav|slovensk|slovak/i;
const BRACKETS = /\s*[([][^)\]]*[)\]]/g;
// A run of nine or more digits, with spaces, brackets, dots or hyphens between them, as phone numbers are written.
const PHONE = /(?<![\p{L}\d])\+?\d(?:[\s().-]{0,2}\d){8,}(?![\p{L}\d])/gu;

/** A number for Messenger's tracker, in capitals as the page sends it; anything else is not one it issues. */
export function normalizeMessengerNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Messenger numbers are eight or fifteen letters and digits');
  return number;
}

/**
 * A clock of the reply. Epoch milliseconds and a clock with an offset are
 * instants; a clock without one is read in the scan's zone.
 */
function clockOf(value: unknown, zone: string): DateTime | null {
  const raw = typeof value === 'number' ? value : clean(value, 40);
  const millis = typeof raw === 'number' ? raw : /^\d{12,13}$/.test(raw) ? Number(raw) : Number.NaN;
  if (Number.isSafeInteger(millis)) return millis > EPOCH_MIN && millis < EPOCH_MAX ? DateTime.fromMillis(millis, { zone }) : null;
  if (typeof raw !== 'string' || !raw) return null;
  if (EXPLICIT_OFFSET_PATTERN.test(raw)) {
    const instant = DateTime.fromISO(raw, { setZone: true });
    return instant.isValid ? instant : null;
  }
  if (!WALL.test(raw)) return null;
  // Parsing in UTC checks the calendar digits; Luxon would roll 24:00 or 30 February over.
  const digits = raw.slice(0, 16);
  if (DateTime.fromISO(raw, { zone: 'UTC' }).toFormat("yyyy-MM-dd'T'HH:mm") !== digits) return null;
  return firstOccurrence(DateTime.fromISO(raw, { zone }));
}

const iso = (time: DateTime) => time.toISO({ suppressMilliseconds: true })!;
const isoOf = (time: DateTime | null) => (time ? iso(time) : undefined);

/**
 * A scan's wording. A documented state keeps its name only: what follows it
 * names who took or handed over the parcel. Other text loses bracketed
 * details and phone numbers.
 */
export function messengerWording(note: string): string {
  const state = messengerState(note);
  if (state) return state.name;
  return clean(note.replace(BRACKETS, '').replace(PHONE, '')).replace(/\s+([,;:.])/g, '$1').replace(/^[\s,;:.\-–]+|[\s,;:\-–]+$/g, '');
}

interface Scan { event: CarrierEvent; at: number }

function scanOf(row: unknown): Scan {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Messenger returned an invalid scan');
  if (typeof row.note !== 'string') throw new SchemaError(PROVIDER, 'Messenger returned a scan without its text');
  const note = clean(row.note, 300);
  const description = messengerWording(note);
  if (!description) throw new SchemaError(PROVIDER, 'Messenger returned a scan without wording');
  // Slovakia's clocks match Czechia's; the zone only says where the scan was.
  const time = clockOf(row.date, SLOVAKIA.test(note) ? BRATISLAVA : PRAGUE);
  if (!time) throw new SchemaError(PROVIDER, 'Messenger returned an invalid scan time');
  const staged = messengerStage(description);
  return {
    at: time.toMillis(),
    event: { time: iso(time), description, ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) },
  };
}

/** The scans newest first; a reply listed oldest first is turned round before sorting, so equal clocks keep their order. */
function newestFirst(scans: Scan[]): CarrierEvent[] {
  const ordered = scans.length > 1 && scans[0]!.at < scans.at(-1)!.at ? [...scans].reverse() : scans;
  return [...ordered].sort((left, right) => right.at - left.at).map(({ event }) => event);
}

/** The pickup point or AlzaBox the page names: its name, then its street and town. */
function pickupPoint(details: unknown): string {
  if (!isRecord(details)) return '';
  const name = clean(details.name, 120);
  if (!name) return '';
  const label = details.isAlzabox === true && !/^alza\s*box\b/i.test(name) ? `AlzaBox ${name}` : name;
  const street = [clean(details.street, 120), cleanScalar(details.houseNumber, 20)].filter(Boolean).join(' ');
  return [label, street, clean(details.city, 80)].filter(Boolean).join('\n');
}

/** The delivery window the page shows for a parcel on its way, when both ends read. */
function deliveryWindow(data: Record<string, unknown>): Pick<CarrierResult, 'expected_delivery' | 'expected_delivery_from'> {
  const to = clockOf(data.deliveryTo, PRAGUE);
  if (!to) return { expected_delivery: null };
  const from = clockOf(data.deliveryFrom, PRAGUE);
  return { expected_delivery: iso(to), ...(from && from < to ? { expected_delivery_from: iso(from) } : {}) };
}

/**
 * The reply of `GET /MessengerWeb/tracking/REST/trackingStatus/{number}`, the
 * lookup the tracking page makes: one consignment with its summary and its
 * scans. The tracker answers HTTP 204 for a number it does not know, which the
 * adapter reads; `null` is the same answer. The consignment must name the
 * whole number asked.
 */
export function parseMessenger(payload: unknown, raw: string): CarrierResult {
  const number = normalizeMessengerNumber(raw);
  if (payload === null) throw new NotFoundError(PROVIDER);
  if (Array.isArray(payload)) throw new IndeterminateError(PROVIDER, 'Messenger returned several consignments for the number');
  if (!isRecord(payload) || typeof payload.trackingCode !== 'string') throw new SchemaError(PROVIDER, 'Messenger returned a consignment without its number');
  // The page follows the number the reply gives; a lookup only counts for the number asked.
  if (normalizeTrackingNumber(clean(payload.trackingCode, 64)) !== number) throw new IndeterminateError(PROVIDER, 'Messenger answered for another consignment');
  const rows = payload.trackingEvents ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Messenger returned a consignment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Messenger returned an oversized history');
  if (payload.state !== null && payload.state !== undefined && typeof payload.state !== 'string') {
    throw new SchemaError(PROVIDER, 'Messenger returned an invalid state');
  }

  const seen = new Set<string>();
  const scans: Scan[] = [];
  for (const row of rows) {
    const scan = scanOf(row);
    // A scan the reply lists twice is kept once.
    const key = JSON.stringify([scan.at, scan.event.description]);
    if (seen.has(key)) continue;
    seen.add(key);
    scans.push(scan);
  }
  const events = newestFirst(scans);

  // The state the page heads the history with, without the "()" of an empty detail.
  const state = messengerState(clean(String(payload.state ?? '').replace('()', '')));
  const summary = state ? messengerMappedStage(state.name) : undefined;
  if (!events.length && !state) throw new NoHistoryError(PROVIDER);
  const current = events.find((event) => event.stage);
  const scanned = current?.stage as Stage | undefined;
  // The state settles a delivery or a return the scans have not reached, and stages a history without one.
  const settles = summary && (!scanned || ((summary === 'delivered' || summary === 'returned') && scanned !== 'delivered' && scanned !== 'returned'));
  const stage = settles ? summary : scanned;
  const source = settles && summary !== scanned ? 'carrier_map' : current?.stage_source;
  const newest = events[0];
  const updated = newest ? newest.time! : isoOf(clockOf(payload.eventDate, PRAGUE));

  const delivery = stage === 'delivered' ? events.find((event) => event.stage === 'delivered') : undefined;
  const deliveredAt = stage === 'delivered' ? delivery?.time ?? isoOf(clockOf(payload.delivered, PRAGUE)) : undefined;
  // A delivered parcel was collected from the point when it was last made ready for pickup there.
  const collected = delivery !== undefined && lastMovement(events.slice(events.indexOf(delivery) + 1)) === 'ready_for_pickup';
  const point = stage === 'ready_for_pickup' || collected ? pickupPoint(payload.deliveryPointDetails) : '';
  const service = clean(payload.productName, 80);
  const settled = stage === 'delivered' || stage === 'returned';
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: newest?.description ?? state!.name,
    last_update: updated ?? null,
    ...(settled ? { expected_delivery: null } : deliveryWindow(payload)),
    ...(deliveredAt ? { delivered_at: deliveredAt } : {}),
    ...(point ? { pickup_point: point } : {}),
    ...(service ? { service_name: service } : {}),
    ...(events.length ? {} : { summary_only: true }),
    events,
  };
}
