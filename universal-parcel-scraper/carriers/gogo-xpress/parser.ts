import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean, textFromHtml } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { normalizeGogoXpressNumber } from './number.js';
import { GOGO_XPRESS_CLAIMS, gogoXpressStage, gogoXpressSummaryStage } from './status.js';

export { normalizeGogoXpressNumber };

export const PROVIDER = 'GoGo Xpress';
// A long history is about five kilobytes.
export const GOGO_XPRESS_MAX_BYTES = 256 * 1024;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
// A clock to the second, sometimes with microseconds, and its offset: "2026-03-02 09:15:00+08".
const CLOCK = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}(?::?\d{2})?)$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
// The scans whose remark can name who took or refused the parcel.
const HANDOVER = new Set(['delivered', 'failed_delivery', 'returned', 'failed_return']);
// A delivery partner's status relayed as its staff typed it, which can name the person met.
const RELAY = /^posted status\b/i;
// The pickup hub's own receipt, "Received by PASIG HUB", names a place.
const HUB_RECEIPT = /^received by [a-z0-9][a-z0-9 .'()-]*\b(?:hub|center|centre|warehouse)$/i;
// Who took, signed for or reported something, and the rest of the line.
const PERSON = /\s*[,;:.\-–/]?\s*\b(?:(?:received|signed|accepted|claimed)\s+by|as\s?per)\b[\s\S]*$/i;
// A run of nine or more digits, with the separators phone numbers are written with.
const PHONE = /(?<![A-Z\d])\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** Whether a reply is the tracker's own answer for a number it does not know. */
export function isGogoXpressNotFound(payload: unknown): boolean {
  return isRecord(payload) && isRecord(payload.error) && typeof payload.error.detail === 'string'
    && /^order not found$/i.test(payload.error.detail.trim());
}

/** An optional string field as it came; anything but a string is a changed reply. */
function raw(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `GoGo Xpress returned an invalid ${key}`);
  return value.slice(0, 2_000);
}

/**
 * A scan's remark as the page shows it, without the people and phone numbers
 * in it. The page shows `masked_remarks` in place of the remark when a scan
 * has one. A delivery, failed delivery or return without one names who took
 * or refused the parcel, and a partner's relayed status is free text, so
 * neither is kept.
 */
export function gogoXpressRemark(code: string, remarks: string, masked = ''): string {
  if (!masked.trim() && HANDOVER.has(code)) return '';
  const line = textFromHtml((masked.trim() ? masked : remarks).replace(/\s*<br\s*\/?>\s*/gi, '. '), 500).replace(/([.!?])\.+/g, '$1');
  if (!line || RELAY.test(line)) return '';
  const own = HUB_RECEIPT.test(line) ? line : line.replace(PERSON, '');
  return clean(own.replace(PHONE, '')).replace(/^[\s,;:.\-–/]+|[\s,;:\-–/]+$/g, '');
}

/** The status name, then the remark when it adds something, as "In transit: For transfer to delivery area". */
function wording(name: string, remark: string): string {
  if (!remark) return name;
  if (!name) return remark;
  const label = name.toLowerCase();
  const line = remark.toLowerCase();
  if (line === label) return name;
  return line.startsWith(label) ? remark : `${name}: ${remark}`;
}

/** A scan's instant: the reply gives each clock with its offset, +08 for Manila. */
function scanTime(value: unknown): { time: string; millis: number } {
  const match = typeof value === 'string' ? CLOCK.exec(value.trim()) : null;
  const wall = match ? `${match[1]}T${match[2]}` : '';
  // Parsing in UTC checks the calendar digits only; Luxon rolls 24:00 over, so only a clock that reads back unchanged is kept.
  const parsed = DateTime.fromISO(wall, { zone: 'UTC' });
  if (!match || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== wall) {
    throw new SchemaError(PROVIDER, 'GoGo Xpress returned an invalid scan time');
  }
  const instant = DateTime.fromISO(`${wall}${match[3]}`, { setZone: true });
  if (!instant.isValid) throw new SchemaError(PROVIDER, 'GoGo Xpress returned an invalid scan time');
  return { time: instant.toISO({ suppressMilliseconds: true }), millis: instant.toMillis() };
}

/** The hub that scanned the parcel, which the reply names in lower case. */
function hub(row: Record<string, unknown>): string {
  const hubs = row.hubs;
  if (hubs === null || hubs === undefined) return '';
  if (!isRecord(hubs)) throw new SchemaError(PROVIDER, 'GoGo Xpress returned invalid hubs');
  return clean(raw(hubs, 'origin'), 120);
}

interface Scan { millis: number; index: number; event: CarrierEvent }

function projectRow(row: unknown, index: number): Scan | null {
  if (!isRecord(row) || typeof row.status !== 'string') throw new SchemaError(PROVIDER, 'GoGo Xpress returned an invalid scan');
  const code = clean(row.status, 64).toLowerCase();
  if (!CODE.test(code)) throw new SchemaError(PROVIDER, 'GoGo Xpress returned an invalid status code');
  if (GOGO_XPRESS_CLAIMS.has(code)) return null;
  const name = clean(raw(row, 'status_name'), 120);
  const description = wording(name, gogoXpressRemark(code, raw(row, 'remarks'), raw(row, 'masked_remarks')))
    || `${code[0]!.toUpperCase()}${code.slice(1).replace(/_/g, ' ')}`;
  // `status_updated_at` is when the scan happened, as the page shows it;
  // `created_at` is when GoGo Xpress recorded it, hours later for a partner's scans.
  const { time, millis } = scanTime(row.status_updated_at ?? row.created_at);
  const location = hub(row);
  const staged = gogoXpressStage(code, name);
  return { millis, index, event: {
    time, ...(location ? { location } : {}), description, provider_code: code,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  } };
}

/** The delivery estimate the page shows, "Thu, Jun 26, 2025", as a calendar day. */
function estimate(shipment: Record<string, unknown>): string | null {
  const value = clean(raw(shipment, 'estimated_delivery_date'), 40);
  if (!value) return null;
  const day = DAY.test(value) ? DateTime.fromISO(value, { zone: 'UTC' })
    : DateTime.fromFormat(value, 'EEE, MMM d, yyyy', { locale: 'en-US', zone: 'UTC' });
  return day.isValid ? day.toISODate() : null;
}

/**
 * The reply of the tracker's `/v1/track/{number}` for one shipment: its
 * attributes, its status code and its scans, grouped by phase and oldest first
 * within each. The shipment must name the number asked.
 */
export function parseGogoXpress(payload: unknown, requested: string): CarrierResult {
  const number = normalizeGogoXpressNumber(requested);
  if (isGogoXpressNotFound(payload)) throw new NotFoundError(PROVIDER);
  if (!isRecord(payload) || !isRecord(payload.data) || !isRecord(payload.data.attributes)) {
    throw new SchemaError(PROVIDER, 'GoGo Xpress returned an invalid envelope');
  }
  const shipment = payload.data.attributes;
  if (typeof shipment.tracking_number !== 'string') throw new SchemaError(PROVIDER, 'GoGo Xpress returned a shipment without its number');
  if (normalizeTrackingNumber(clean(shipment.tracking_number, 64)) !== normalizeTrackingNumber(number)) {
    throw new IndeterminateError(PROVIDER, 'GoGo Xpress answered for another shipment');
  }
  const groups = shipment.events ?? {};
  if (!isRecord(groups)) throw new SchemaError(PROVIDER, 'GoGo Xpress returned a shipment with invalid scans');
  const rows: unknown[] = [];
  for (const group of Object.values(groups)) {
    if (group === null) continue;
    if (!Array.isArray(group)) throw new SchemaError(PROVIDER, 'GoGo Xpress returned a shipment with invalid scans');
    rows.push(...(group as unknown[]));
  }
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'GoGo Xpress returned an oversized history');

  const seen = new Set<string>();
  const scans: Scan[] = [];
  rows.forEach((row, index) => {
    const scan = projectRow(row, index);
    if (!scan) return;
    const key = JSON.stringify([scan.event.time, scan.event.provider_code, scan.event.description]);
    if (seen.has(key)) return;
    seen.add(key);
    scans.push(scan);
  });
  if (!scans.length) throw new NoHistoryError(PROVIDER);

  // Newest first; scans of the same second take the later row first.
  const events = scans.sort((left, right) => right.millis - left.millis || right.index - left.index).map(({ event }) => event);
  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const summary = gogoXpressSummaryStage(clean(raw(shipment, 'status'), 64));
  const stage = (summary ?? current?.stage) as Stage | undefined;
  const source = summary && summary !== current?.stage ? 'carrier_map' : current?.stage_source;
  const delivered = stage === 'delivered' ? events.find((event) => event.stage === 'delivered')?.time : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    // A shipment that ended or failed has no delivery to expect.
    expected_delivery: summary ? null : estimate(shipment),
    ...(delivered ? { delivered_at: delivered } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
