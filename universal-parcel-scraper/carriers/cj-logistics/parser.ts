import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { cjStage } from './status.js';

export const PROVIDER = 'CJ Logistics';
// A scan is about half a kilobyte; a long history is a few dozen of them.
export const CJ_SCANS_MAX_BYTES = 1024 * 1024;
export const CJ_WAYBILL_MAX_BYTES = 64 * 1024;
// The tracker's own check: ten or twelve digits.
const NUMBER = /^\d{10}(?:\d{2})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^\d{2}:\d{2}:\d{2}$/;
// Every scan is made at a branch or terminal of CJ's Korean network.
const ZONE = 'Asia/Seoul';
const MAX_ROWS = 2_000;
const MAX_EVENTS = 100;
// Scans that leave a delivery standing when a courier records them after it.
const BEFORE_DELIVERY = new Set<Stage>(['accepted', 'in_transit', 'out_for_delivery']);

/** A number for CJ Logistics' tracker; anything but ten or twelve digits is not a waybill it issues. */
export function normalizeCjNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'CJ Logistics waybills are ten or twelve digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `CJ Logistics returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** The reply's envelope: `resultCode` 200 and its `data`. */
function envelope(payload: unknown): unknown {
  if (!isRecord(payload) || !Object.hasOwn(payload, 'data') || !['number', 'string'].includes(typeof payload.resultCode)) {
    throw new SchemaError(PROVIDER, 'CJ Logistics returned an invalid envelope');
  }
  if (String(payload.resultCode) !== '200') throw new IndeterminateError(PROVIDER, 'CJ Logistics did not complete the lookup');
  return payload.data;
}

// The courier's name and mobile number in brackets, as in "(배송담당 : …)",
// "(담당사원 : …)" or "(배송예정:…)", and the same clause without them.
const STAFF = /\(\s*(?:배송담당|담당사원|배송예정|담당자?|인수자)\s*:[^)]*\)?|(?:배송담당|담당사원|배송예정|인수자)\s*:.*$/g;
// A Korean phone number, mobile or landline.
const PHONE = /(?<!\d)0\d{1,2}[\s.)-]{0,2}\d{3,4}[\s.-]?\d{4}(?!\d)/g;

/**
 * A scan's wording: its name, then the tracker's detail line, as
 * "배송출발: 고객님의 상품을 배송할 예정입니다.(11~13시)". The detail loses
 * the courier's name and phone number, and a delivery time slot stays.
 */
export function cjWording(name: string, detail: string): string {
  const line = clean(detail.replace(STAFF, '').replace(PHONE, ''))
    .replace(/\(\s*\)/g, '').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();
  const scan = clean(name);
  if (!line) return scan;
  if (!scan || line.startsWith(scan)) return line;
  return `${scan}: ${line}`;
}

/** A branch's name. A direct route's label names its driver in brackets, which is dropped. */
export function cjBranch(name: string): string {
  return clean(name).replace(/(직영)\s*\([^)]*\)$/, '$1');
}

/** A scan's instant: the branch's Korean wall clock, to the second. */
function scanTime(row: Record<string, unknown>): { iso: string; timestamp: number } {
  const date = text(row, 'workDt', 16);
  const clock = text(row, 'workHms', 16);
  const parsed = DATE.test(date) && CLOCK.test(clock) ? zonedTime(`${date} ${clock}`, 'yyyy-MM-dd HH:mm:ss', ZONE) : null;
  // Only a clock that reads back unchanged is kept: Luxon would roll 24:00 over to the next day.
  if (!parsed || parsed.iso.slice(0, 19) !== `${date}T${clock}`) throw new SchemaError(PROVIDER, 'CJ Logistics returned an invalid scan time');
  return parsed;
}

function projectRow(row: Record<string, unknown>, number: string): { key: string; timestamp: number; event: CarrierEvent } {
  if (typeof row.wblNo !== 'string') throw new SchemaError(PROVIDER, 'CJ Logistics returned a scan without its waybill');
  if (normalizeTrackingNumber(row.wblNo) !== number) throw new IndeterminateError(PROVIDER, 'CJ Logistics answered for another shipment');
  const code = text(row, 'crgStDcd', 16).toUpperCase();
  const description = cjWording(text(row, 'crgStDnm', 60), text(row, 'crgStDcdVal'));
  if (!description) throw new SchemaError(PROVIDER, 'CJ Logistics returned a scan without wording');
  const { iso, timestamp } = scanTime(row);
  const location = cjBranch(text(row, 'branNm', 120));
  const staged = cjStage(code, description);
  const event: CarrierEvent = {
    time: iso,
    ...(location ? { location } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([iso, code, description, location]), timestamp, event };
}

/**
 * The reply of the tracker's `selectTrackingDetailList.do`: every scan of the
 * waybill, oldest first, each naming the waybill. Null when it lists none,
 * which says nothing until the waybill's own record is read.
 */
export function parseCjScans(payload: unknown, raw: string): CarrierResult | null {
  const number = normalizeCjNumber(raw);
  const data = envelope(payload);
  if (!isRecord(data) || !Array.isArray(data.svcOutList)) throw new SchemaError(PROVIDER, 'CJ Logistics returned an invalid scan list');
  const rows: unknown[] = data.svcOutList;
  if (!rows.length) return null;
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'CJ Logistics returned an oversized history');

  const seen = new Set<string>();
  const scans: { timestamp: number; index: number; event: CarrierEvent }[] = [];
  rows.forEach((row, index) => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'CJ Logistics returned an invalid scan');
    const scan = projectRow(row, number);
    if (seen.has(scan.key)) return;
    seen.add(scan.key);
    scans.push({ timestamp: scan.timestamp, index, event: scan.event });
  });
  // Newest first; on equal clocks, the later row first.
  scans.sort((left, right) => right.timestamp - left.timestamp || right.index - left.index);
  const events = scans.map(({ event }) => event);

  const staged = events.filter((event) => event.stage);
  const delivery = staged.find((event) => event.stage === 'delivered');
  // A courier can scan the parcel out for delivery after recording its delivery.
  const current = delivery && BEFORE_DELIVERY.has(staged[0]!.stage as Stage) ? delivery : staged[0] ?? events[0]!;
  const stage = current.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current.stage_source ?? 'carrier_map' } : {}),
    last_status_text: current.description!,
    last_update: current.time!,
    expected_delivery: null,
    ...(stage === 'delivered' ? { delivered_at: current.time! } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}

/**
 * The reply of the tracker's `selectTrackingWaybil.do`, read for a number
 * without scans. Its `data` is null for a waybill CJ Logistics does not know,
 * which the tracker reports as an invalid waybill; a record of the number is a
 * waybill registered before its first scan.
 */
export function readCjWaybill(payload: unknown, raw: string): never {
  const number = normalizeCjNumber(raw);
  const data = envelope(payload);
  if (data === null) throw new NotFoundError(PROVIDER);
  if (!isRecord(data) || typeof data.wblNo !== 'string') throw new SchemaError(PROVIDER, 'CJ Logistics returned a waybill without its number');
  if (normalizeTrackingNumber(data.wblNo) !== number) throw new IndeterminateError(PROVIDER, 'CJ Logistics answered for another shipment');
  throw new NoHistoryError(PROVIDER);
}
