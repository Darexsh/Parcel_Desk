import { DateTime, FixedOffsetZone } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { lionParcelMappedStage, lionParcelStage } from './status.js';

export const PROVIDER = 'Lion Parcel';
// A long history is under twenty kilobytes.
export const LION_PARCEL_MAX_BYTES = 512 * 1024;
// `lion-parcel-1`'s layout: the STT, two digits, LP and thirteen digits.
const NUMBER = /^\d{2}LP\d{13}$/;
// The tracker takes fifty numbers at a time.
const MAX_SHIPMENTS = 50;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
// The scanning site's zone, which the page shows each scan's moment in.
const SITE_ZONE = /^GMT([+-])(\d{1,2}):(\d{2})$/;
// A Lion Parcel facility's city, after its three-letter code: "CGK - JAKARTA".
const FACILITY = /^[A-Z]{3}\s+-\s+(\S[\s\S]*)$/;
// A run of nine or more digits, with spaces, brackets, dots or hyphens
// between them, as phone numbers are written; a date stays.
const PHONE = /(?<![A-Z\d])(?!\d{4}-\d{2}-\d{2}(?!\d))\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
// Words that follow "kurir" in Lion Parcel's own sentences, where no name stands.
const CLAUSE = String.raw`(?:dalam|telah|sedang|akan|sudah|karena|untuk|ke|di|dan|pada|yang)\b`;
// The courier's name after "kurir", up to the next sentence or clause.
const COURIER = new RegExp(String.raw`(\bkurir)\s+(?!${CLAUSE})[\s\S]+?(?=\.\s+Pastikan\b|\s+${CLAUSE}|\.?\s*$)`, 'gi');
// Who took a delivered parcel, and their relation to the recipient.
const RECEIVER = /(\bditerima)\s+oleh\b[\s\S]*$/i;

/** A Lion Parcel STT, in capitals; anything else is not one Lion Parcel issues. */
export function normalizeLionParcelNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Lion Parcel numbers are two digits, LP and thirteen digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Lion Parcel returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A flag the reply must give as a boolean. */
function flag(row: Record<string, unknown>, key: string): boolean {
  const value = row[key];
  if (value === null || value === undefined) return false;
  if (typeof value !== 'boolean') throw new SchemaError(PROVIDER, `Lion Parcel returned an invalid ${key}`);
  return value;
}

/** A number the reply names, in the form it is compared in. */
function identity(row: Record<string, unknown>, key: string): string {
  return normalizeTrackingNumber(text(row, key, 64)).toUpperCase();
}

/**
 * A scan's wording without the courier's name, the person who took the parcel
 * and phone numbers: "Paketmu diantar ke alamat penerima oleh kurir …",
 * "Kurir … dalam perjalanan", "… & diterima oleh … (YBS)".
 */
export function lionParcelWording(description: string): string {
  return clean(description.replace(RECEIVER, '$1').replace(COURIER, '$1').replace(PHONE, '').replace(/\s+([,.;:])/g, '$1'))
    .replace(/^[\s,;:]+|[\s,;:\-–]+$/g, '');
}

/**
 * A scan's moment. `status_date` is an instant with its offset, and `GMT`
 * names the scanning site's zone, which the page shows the moment in: the
 * scan is returned at that offset. Scans before the parcel reaches Lion
 * Parcel name no zone and keep the reply's own offset.
 */
function scanTime(row: Record<string, unknown>): { iso: string; timestamp: number } {
  const raw = text(row, 'status_date', 40);
  const parsed = STAMP.test(raw) ? explicitOffsetTime(raw) : null;
  if (!parsed) throw new SchemaError(PROVIDER, 'Lion Parcel returned an invalid scan time');
  const zone = SITE_ZONE.exec(text(row, 'GMT', 16));
  if (!zone) return parsed;
  const minutes = (Number(zone[2]) * 60 + Number(zone[3])) * (zone[1] === '-' ? -1 : 1);
  if (Number(zone[3]) >= 60 || minutes < -12 * 60 || minutes > 14 * 60) return parsed;
  const iso = DateTime.fromMillis(parsed.timestamp, { zone: FixedOffsetZone.instance(minutes) }).toISO({ suppressMilliseconds: true });
  return iso ? { iso, timestamp: parsed.timestamp } : parsed;
}

function projectRow(row: Record<string, unknown>): { key: string; timestamp: number; event: CarrierEvent } | null {
  const code = text(row, 'status', 40).toUpperCase();
  const description = lionParcelWording(text(row, 'description', 500)) || text(row, 'status_label', 120);
  const { iso, timestamp } = scanTime(row);
  if (!description) return null;
  // Only a facility's city: the scans before the agent name the sender's district.
  const location = clean(FACILITY.exec(text(row, 'location', 120))?.[1], 80);
  const staged = lionParcelStage(code, description);
  const event: CarrierEvent = {
    time: iso,
    description,
    ...(location ? { location } : {}),
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([timestamp, code, description, location]), timestamp, event };
}

/** A calendar day the reply gives, if it is one. */
function calendarDay(value: string | undefined): string | null {
  return value && DAY.test(value) && DateTime.fromISO(value, { zone: 'UTC' }).isValid ? value : null;
}

/**
 * The delivery window, "first day - last day", for a parcel still on its way.
 * A window that ended before the newest scan's day is stale.
 */
function estimate(shipment: Record<string, unknown>, stage: Stage | undefined, newest: CarrierEvent | undefined)
  : Pick<CarrierResult, 'expected_delivery' | 'expected_delivery_from'> {
  if (stage === 'delivered' || stage === 'returned' || stage === 'exception') return { expected_delivery: null };
  const [from, to] = text(shipment, 'estimation_date', 40).split(' - ').map((part) => calendarDay(part.trim()));
  if (!from || !to || from > to || (newest?.time && to < newest.time.slice(0, 10))) return { expected_delivery: null };
  return { expected_delivery: to, ...(from < to ? { expected_delivery_from: from } : {}) };
}

/** The shipment's own stage: its summary code, or a cancellation the reply flags. */
function summaryStage(shipment: Record<string, unknown>, code: string): Stage | undefined {
  const cancelled = flag(shipment, 'is_cnx');
  return lionParcelMappedStage(code) ?? (cancelled ? 'exception' : undefined);
}

function ownShipment(payload: unknown, number: string): Record<string, unknown> {
  if (!isRecord(payload) || !Array.isArray(payload.data)) throw new SchemaError(PROVIDER, 'Lion Parcel returned an invalid envelope');
  const shipments = payload.data;
  if (shipments.length > MAX_SHIPMENTS) throw new SchemaError(PROVIDER, 'Lion Parcel returned an oversized shipment list');
  for (const shipment of shipments) {
    if (!isRecord(shipment) || typeof shipment.q !== 'string') throw new SchemaError(PROVIDER, 'Lion Parcel returned a shipment without its query');
  }
  const rows = shipments as Record<string, unknown>[];
  const own = rows.filter((shipment) => identity(shipment, 'stt_id') === number);
  if (own.length > 1) throw new IndeterminateError(PROVIDER, 'Lion Parcel answered with several shipments for the number');
  if (own.length === 1) {
    if (!flag(own[0]!, 'is_exist')) throw new IndeterminateError(PROVIDER, 'Lion Parcel did not complete the lookup');
    return own[0]!;
  }
  // The page shows "Hasil pencarian tidak ditemukan" for an entry that echoes the number and found nothing.
  const asked = rows.filter((shipment) => identity(shipment, 'q') === number);
  if (asked.length && asked.every((shipment) => !flag(shipment, 'is_exist') && !text(shipment, 'stt_id', 64))) throw new NotFoundError(PROVIDER);
  throw new IndeterminateError(PROVIDER, asked.length ? 'Lion Parcel answered for another shipment' : 'Lion Parcel did not answer for the number');
}

/**
 * The reply of the tracking page's `/api/tracking` for one number. It has one
 * entry per number asked; an unknown number's entry echoes it with nothing
 * found. The tracker also finds a shipment by its booking code, so an entry
 * counts only when its own STT is the number asked. The sender's and the
 * recipient's districts, payment flags and delivery photos are never read.
 */
export function parseLionParcel(payload: unknown, raw: string): CarrierResult {
  const number = normalizeLionParcelNumber(raw);
  const shipment = ownShipment(payload, number);
  const rows = shipment.histories ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Lion Parcel returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Lion Parcel returned an oversized history');

  const seen = new Set<string>();
  const scans: { timestamp: number; event: CarrierEvent }[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Lion Parcel returned an invalid scan');
    const scan = projectRow(row);
    if (!scan || seen.has(scan.key)) continue;
    seen.add(scan.key);
    scans.push(scan);
  }
  // Newest first, as the page sorts them by moment; scans at the same moment
  // keep the reply's order, which lists them oldest first.
  const events = scans.reverse().sort((a, b) => b.timestamp - a.timestamp).map((scan) => scan.event);

  const code = text(shipment, 'current_status', 40).toUpperCase();
  const summary = summaryStage(shipment, code);
  const service = text(shipment, 'product_type', 40);
  const facts = service ? { service_name: service } : {};
  if (!events.length) {
    // Older parcels keep their summary after their scans are gone.
    if (!summary) throw new NoHistoryError(PROVIDER);
    return { status: languageStageStatus(summary), current_stage: summary, current_stage_source: 'carrier_map',
      last_status_text: null, ...(code ? { provider_code: code } : {}), last_update: null, expected_delivery: null,
      ...facts, summary_only: true, events: [] };
  }

  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  const stage = summary ?? scanned?.stage as Stage | undefined;
  const source = summary && summary !== scanned?.stage ? 'carrier_map' : scanned?.stage_source;
  const delivered = stage === 'delivered' ? events.find((event) => event.stage === 'delivered') : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    ...estimate(shipment, stage, newest),
    ...(delivered ? { delivered_at: delivered.time! } : {}),
    ...facts,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
