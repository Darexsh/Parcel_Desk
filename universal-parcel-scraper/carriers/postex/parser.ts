import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { postexStage } from './status.js';

export const PROVIDER = 'PostEx';
// A long history is a few kilobytes.
export const POSTEX_MAX_BYTES = 256 * 1024;
// PostEx's numbers, and the former Call Courier consignments its tracker
// knows, are fourteen digits.
const NUMBER = /^\d{14}$/;
const CODE = /^\d{4}$/;
const CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})$/;
// The codes the tracking page lists; it leaves the others out of the history.
const SHOWN = new Set(['0001', '0002', '0003', '0004', '0005', '0006', '0007', '0008', '0013', '0031', '0032', '0033', '0035',
  '0037', '0038', '0039', '0040', '0045']);
// The merchant's warehouse, where an order waits until PostEx picks it up:
// "At SAMPLE STORE Warehouse". The merchant's name is not kept.
const AT_MERCHANT = '0001';
const MERCHANT_WAREHOUSE = /^At\s/i;
const MERCHANT_WORDING = 'At Merchant\'s Warehouse';
// PostEx's station code on warehouse and hub scans, as "Received at LHE Warehouse".
const STATION = /^(?:Received at ([A-Z]{3}) Warehouse|Arrived at Transit Hub ([A-Z]{3}))$/;
// A run of nine or more digits, with spaces, brackets, dots or hyphens
// between them, as phone numbers are written.
const PHONE = /(?<![A-Z\d])\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A PostEx tracking number: fourteen digits. */
export function normalizePostexNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'PostEx tracking numbers are fourteen digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `PostEx returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A scan's wording, without the merchant's name or a phone number. */
export function postexWording(code: string, wording: string): string {
  if (code === AT_MERCHANT && MERCHANT_WAREHOUSE.test(wording)) return MERCHANT_WORDING;
  return clean(wording.replace(PHONE, '').replace(/\s+([,;:.)])/g, '$1')).replace(/[\s,;:\-–]+$/, '');
}

interface Scan { key: string; at: number; event: CarrierEvent }

/** A scan as the page lists it: its wording, the station it names and its clock. */
function readScan(row: Record<string, unknown>): Scan | null {
  const code = text(row, 'transactionStatusMessageCode', 8);
  if (!CODE.test(code)) throw new SchemaError(PROVIDER, 'PostEx returned a scan without its code');
  if (!SHOWN.has(code)) return null;
  const description = postexWording(code, text(row, 'transactionStatusMessage'));
  if (!description) throw new SchemaError(PROVIDER, 'PostEx returned a scan without wording');
  // `modifiedDatetime` carries the offset of PostEx's clock, Pakistan's.
  const stamp = text(row, 'modifiedDatetime', 40);
  const clock = CLOCK.test(stamp) ? explicitOffsetTime(stamp) : null;
  if (!clock) throw new SchemaError(PROVIDER, 'PostEx returned an invalid scan time');
  const station = STATION.exec(description);
  const location = station?.[1] ?? station?.[2];
  const staged = postexStage(code, description);
  const event: CarrierEvent = {
    time: clock.iso,
    description,
    ...(location ? { location } : {}),
    provider_code: code,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([clock.timestamp, code, description]), at: clock.timestamp, event };
}

/**
 * The tracking service's own error, which the page's server passes on with
 * HTTP 200 when it cannot reach the lookup: `{"status":401,"error":"Unauthorized",…}`.
 */
function serviceError(payload: Record<string, unknown>): never {
  const status = payload.status;
  if (status === 429) throw new RateLimitedError(PROVIDER, undefined, 'PostEx refused the lookup as too frequent');
  if (typeof status === 'number' && status >= 500) throw new IndeterminateError(PROVIDER, 'PostEx could not complete the lookup');
  if (typeof status === 'number') throw new SchemaError(PROVIDER, 'PostEx refused the tracking page\'s lookup');
  // The page's server's own failure, as `{"error":"Failed to fetch tracking information"}`.
  throw new IndeterminateError(PROVIDER, 'PostEx did not complete the lookup');
}

/**
 * The reply of the tracking page's `/api/tracking-order` for one number:
 * `{"statusCode":"200","dist":{…}}`, the shipment under `dist` with its
 * scans newest first. A number PostEx does not know comes back without
 * `dist`, which the page reports as not found. The shipment must name the
 * number asked. The customer's name and the order date are not read.
 */
export function parsePostex(payload: unknown, raw: string): CarrierResult {
  const number = normalizePostexNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'PostEx returned an invalid envelope');
  if (payload.statusCode === undefined && (payload.error !== undefined || payload.status !== undefined)) serviceError(payload);
  if (typeof payload.statusCode !== 'string') throw new SchemaError(PROVIDER, 'PostEx returned an invalid envelope');
  if (!/^20\d$/.test(payload.statusCode)) throw new IndeterminateError(PROVIDER, 'PostEx did not complete the lookup');
  const shipment = payload.dist;
  if (shipment === undefined || shipment === null) throw new NotFoundError(PROVIDER);
  if (!isRecord(shipment) || typeof shipment.trackingNumber !== 'string') {
    throw new SchemaError(PROVIDER, 'PostEx returned a shipment without its number');
  }
  if (clean(shipment.trackingNumber, 64) !== number) throw new IndeterminateError(PROVIDER, 'PostEx answered for another shipment');
  const rows = shipment.transactionStatusHistory ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'PostEx returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'PostEx returned an oversized history');

  const seen = new Set<string>();
  const scans: Scan[] = [];
  rows.forEach((row) => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'PostEx returned an invalid scan');
    const scan = readScan(row);
    if (!scan || seen.has(scan.key)) return;
    seen.add(scan.key);
    scans.push(scan);
  });
  // Former Call Courier consignments are known without a history.
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first; equal clocks keep the reply's order, which is newest first.
  if (listsNewestFirst(scans.map(({ event }) => event)) === false) scans.reverse();
  const events = scans.sort((a, b) => b.at - a.at).map((scan) => scan.event);

  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: null,
    ...(stage === 'delivered' ? { delivered_at: current!.time! } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
