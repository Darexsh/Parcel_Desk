import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { twoGoStage } from './status.js';

export const PROVIDER = '2GO Express';
// A long history is under two kilobytes.
export const TWO_GO_MAX_BYTES = 256 * 1024;
// eTrace CN and document numbers, a capital letter, seven digits and a capital
// letter, and the AA air waybills of the system before it.
const NUMBER = /^(?:[A-Z]\d{7}[A-Z]|AA\d{7})$/;
// The number a redirect names, which the page opens as it comes.
const SHIPMENT = /^[A-Z0-9]{4,40}$/;
// A wall clock to the second, sometimes with microseconds; the reply gives no zone.
const CLOCK = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})?$/;
// The tracker's word for a shipment without attachments.
const NO_ATTACHMENT = /^NO_ATTACHMENT$/i;
// Who took the parcel, after a delivery's wording, as 2GO's earlier tracker wrote it.
const RECEIVER = /^(.*?\bdeliver[\s\S]*?)\s*[,;:.\-–]?\s*\b(?:received|signed)\s+by\b[\s\S]*$/i;
// A run of nine or more digits, with the separators phone numbers are written with.
const PHONE = /(?<![A-Z\d])\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
// The hub an arrival scan names.
const ARRIVAL = /^Parcel has arrived at (.+)$/i;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A 2GO Express number in capitals; anything else is not one 2GO issues. */
export function normalizeTwoGoNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, '2GO Express numbers are a letter, seven digits and a letter, or AA and seven digits');
  return number;
}

/**
 * The shipment a redirect names. The tracker answers a reference it holds as
 * an attachment of a shipment with `{redirect, trackingNumber}`, and the page
 * then opens that shipment's own number. Null for any other reply.
 */
export function twoGoRedirect(payload: unknown): string | null {
  if (!isRecord(payload) || !payload.redirect) return null;
  const target = typeof payload.trackingNumber === 'string' ? normalizeTrackingNumber(clean(payload.trackingNumber, 64)) : '';
  if (!SHIPMENT.test(target)) throw new SchemaError(PROVIDER, '2GO Express redirected to an invalid number');
  return target;
}

/** Whether a reply is the tracker's own answer for a number it holds neither as a shipment nor as an attachment. */
export function isTwoGoNotFound(payload: unknown): boolean {
  return isRecord(payload) && typeof payload.error === 'string' && /\bnot found\b/i.test(payload.error);
}

/** A scan's wording, without who took the parcel or phone numbers. */
export function twoGoWording(status: string): string {
  return clean(clean(status, 500).replace(RECEIVER, '$1').replace(PHONE, ''), 300).replace(/[\s,;:\-–]+$/, '');
}

/** A scan's clock: an instant only when the reply gives its offset, else the wall clock to the second. */
function scanClock(value: unknown): { wall: string; time?: string; local_time?: string } {
  const match = typeof value === 'string' ? CLOCK.exec(value.trim()) : null;
  const wall = match ? `${match[1]}T${match[2]}` : '';
  // Parsing in UTC checks the calendar digits only; Luxon rolls 24:00 over, so only a clock that reads back unchanged is kept.
  const parsed = DateTime.fromISO(wall, { zone: 'UTC' });
  if (!match || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== wall) {
    throw new SchemaError(PROVIDER, '2GO Express returned an invalid scan time');
  }
  if (!match[3]) return { wall, local_time: wall };
  const instant = DateTime.fromISO(`${wall}${match[3]}`, { setZone: true });
  if (!instant.isValid) throw new SchemaError(PROVIDER, '2GO Express returned an invalid scan time');
  return { wall, time: instant.toISO({ suppressMilliseconds: true }) };
}

interface Scan { wall: string; index: number; event: CarrierEvent }

function projectRow(row: unknown, shipment: string, index: number): Scan {
  if (!isRecord(row) || typeof row.trackingNumber !== 'string' || typeof row.status !== 'string') {
    throw new SchemaError(PROVIDER, '2GO Express returned an invalid scan');
  }
  if (normalizeTrackingNumber(clean(row.trackingNumber, 64)) !== shipment) throw new IndeterminateError(PROVIDER, '2GO Express answered for another shipment');
  const description = twoGoWording(row.status);
  if (!description) throw new SchemaError(PROVIDER, '2GO Express returned a scan without wording');
  const { wall, ...clock } = scanClock(row.timestamp);
  const location = clean(ARRIVAL.exec(description)?.[1], 120);
  const staged = twoGoStage(description);
  return { wall, index, event: {
    ...clock, ...(location ? { location } : {}), description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  } };
}

/** The references the tracker lists over the history, each whole and normalized. */
function attachments(payload: Record<string, unknown>): string[] {
  const value = payload.attachment;
  if (value === undefined || value === null) return [];
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, '2GO Express returned invalid attachments');
  const text = clean(value, 2_000);
  if (!text || NO_ATTACHMENT.test(text)) return [];
  return text.split('/').map((part) => normalizeTrackingNumber(clean(part, 64))).filter(Boolean);
}

/**
 * The reply of the tracker's `/tracking/{number}` for one shipment: its
 * scans oldest first, each naming the shipment, and the references attached
 * to it. `requested` is the number asked for; when the tracker redirected it
 * to `shipment`, the shipment must list it whole among its attachments.
 */
export function parseTwoGo(payload: unknown, requested: string, shipment = requested): CarrierResult {
  const number = normalizeTrackingNumber(requested);
  const own = normalizeTrackingNumber(shipment);
  if (isTwoGoNotFound(payload)) throw new NotFoundError(PROVIDER);
  // The page reads a bare list of scans as well as the envelope.
  const rows = Array.isArray(payload) ? payload : isRecord(payload) ? payload.history : undefined;
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, '2GO Express returned a reply without a history');
  if (own !== number && !(isRecord(payload) && attachments(payload).includes(number))) {
    throw new IndeterminateError(PROVIDER, '2GO Express redirected to a shipment that does not list the number');
  }
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, '2GO Express returned an oversized history');

  const seen = new Set<string>();
  const scans: Scan[] = [];
  rows.forEach((row, index) => {
    const scan = projectRow(row, own, index);
    const key = JSON.stringify([scan.wall, scan.event.description]);
    if (seen.has(key)) return;
    seen.add(key);
    scans.push(scan);
  });
  if (!scans.length) throw new NoHistoryError(PROVIDER);

  // Newest first by wall clock; scans of the same second take the later row first.
  const events = scans.sort((left, right) => right.wall.localeCompare(left.wall) || right.index - left.index).map(({ event }) => event);
  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const deliveredAt = stage === 'delivered' ? current!.time : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.time ? {} : { last_update_local: newest.local_time }),
    expected_delivery: null,
    ...(deliveredAt ? { delivered_at: deliveredAt } : {}),
    ...(own !== number ? { canonical_tracking_number: own } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
