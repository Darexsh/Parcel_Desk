import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { mongolInfinityPostStage } from './status.js';

export const PROVIDER = 'Mongol Infinity Post';
// Each row carries the whole order and the graph of next statuses, about
// seven kilobytes; a long history stays well under this.
export const MONGOL_INFINITY_POST_MAX_BYTES = 4 * 1024 * 1024;

// An order id, seven digits as the home page's example; a parcel's barcode,
// two letters, eight digits and MN; or a number the page sends to its customs
// lookup, which it does for any number holding YC.
const ORDER = /^\d{7}$/;
const BARCODE = /^[A-Z]{2}\d{8}MN$/;
const CUSTOMS = /^(?=[A-Z\d]*YC)(?=[A-Z]*\d)[A-Z\d]{8,30}$/;
// The statuses whose branch the page leaves out: the parcel is with the courier or back.
const AWAY = new Set(['EM3', 'EMH', 'EMI', 'EM']);
// A run of eight or more digits, with spaces, brackets, dots or hyphens
// between them, as Mongolian phone numbers are written.
const PHONE = /(?<![A-Z\d])\+?\d(?:[\s().-]{0,2}\d){7,}(?![A-Z\d])/gi;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A number for Mongol Infinity Post's tracker, in capitals; anything else is not one it issues. */
export function normalizeMongolInfinityPostNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!ORDER.test(number) && !BARCODE.test(number) && !CUSTOMS.test(number)) {
    throw new InvalidInputError(PROVIDER, 'Mongol Infinity Post numbers are seven-digit order ids, barcodes such as RR00000000MN or customs numbers holding YC');
  }
  return number;
}

/** Whether the home page sends the number to its customs lookup rather than its search. */
export function isMongolInfinityPostCustomsNumber(number: string): boolean {
  return number.includes('YC');
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Mongol Infinity Post returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A scan's time: the reply's own UTC stamps, to the millisecond. */
function instant(value: unknown): { iso: string; timestamp: number } {
  const parsed = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) ? explicitOffsetTime(value) : null;
  if (!parsed) throw new SchemaError(PROVIDER, 'Mongol Infinity Post returned an invalid scan time');
  return parsed;
}

interface Scan {
  at: number;
  event: CarrierEvent;
}

/** The result for one parcel's scans, newest first; duplicates are kept once. */
function result(scans: readonly Scan[], extra: Partial<CarrierResult> = {}): CarrierResult {
  const seen = new Set<string>();
  const unique = scans.filter(({ event }) => {
    const key = JSON.stringify([event.time, event.provider_code, event.description, event.location]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!unique.length) throw new NoHistoryError(PROVIDER);
  if (listsNewestFirst(unique.map(({ event }) => event)) === false) unique.reverse();
  const events = unique.sort((left, right) => right.at - left.at).map(({ event }) => event);
  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: null,
    ...(stage === 'delivered' ? { delivered_at: current!.time! } : {}),
    ...extra,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}

/** A row's identity: its barcode in capitals and its order id. */
function identity(source: Record<string, unknown>): { barcode: string; order: string } {
  const barcode = text(source, 'barcode', 64);
  const order = source.orderId;
  let id = '';
  if (typeof order === 'number' && Number.isSafeInteger(order) && order >= 0) id = String(order);
  else if (typeof order === 'string' && /^\d{1,15}$/.test(order)) id = order;
  else if (order !== null && order !== undefined) throw new SchemaError(PROVIDER, 'Mongol Infinity Post returned an invalid order id');
  return { barcode: barcode ? normalizeTrackingNumber(barcode).toUpperCase() : '', order: id };
}

/**
 * A row of the search as the page shows it: the status's name, with the
 * reason a failed delivery gives, and the place. The branch is part of the
 * place unless the page leaves it out.
 */
function projectRow(source: Record<string, unknown>): Scan {
  const status = source.shipmentStatus;
  if (!isRecord(status)) throw new SchemaError(PROVIDER, 'Mongol Infinity Post returned a scan without its status');
  const code = cleanScalar(status.cd, 40);
  const name = text(status, 'name') || text(status, 'enName');
  if (!name) throw new SchemaError(PROVIDER, 'Mongol Infinity Post returned a scan without wording');
  const reason = text(source, 'reason', 300).replace(PHONE, '').replace(/\s+/g, ' ').replace(/^[\s,;:.\-–]+|[\s,;:\-–]+$/g, '');
  const description = reason ? `${name}: ${reason}` : name;
  // The page dates a row by its scan, else by its stamp.
  const at = instant(source.scanDate ?? source.timestamp);
  const branch = AWAY.has(code.toUpperCase()) ? '' : text(source, 'branchEnName', 120) || text(source, 'branchMnName', 120);
  const town = text(source, 'nameEn', 120) || text(source, 'nameMn', 120);
  const country = text(source, 'countryEnName', 80) || text(source, 'countryName', 80);
  const location = [branch, town, country].filter(Boolean).join(', ');
  const staged = mongolInfinityPostStage(code, name);
  return { at: at.timestamp, event: {
    time: at.iso,
    ...(location ? { location } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  } };
}

/**
 * The reply of the home page's search, `core_api/api/order/history?q=`: the
 * search's hits, each one scan of a parcel with the whole order around it.
 * No hit is the page's own not-found answer. The search can hit other
 * parcels, so a row counts only when its barcode is the number asked, or its
 * order id for a seven-digit number; an order id that names several barcodes
 * is several parcels. Names, phones, addresses, coordinates, couriers, staff,
 * signatures and contents in the rows are never read.
 */
export function parseMongolInfinityPostHistory(payload: unknown, raw: string): CarrierResult {
  const number = normalizeMongolInfinityPostNumber(raw);
  const hits = isRecord(payload) && isRecord(payload.result) ? payload.result.hits : undefined;
  if (!Array.isArray(hits)) throw new SchemaError(PROVIDER, 'Mongol Infinity Post returned an invalid envelope');
  if (hits.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Mongol Infinity Post returned an oversized history');
  if (!hits.length) throw new NotFoundError(PROVIDER);
  const own = hits.flatMap((hit) => {
    if (!isRecord(hit) || !isRecord(hit._source)) throw new SchemaError(PROVIDER, 'Mongol Infinity Post returned an invalid hit');
    const { barcode, order } = identity(hit._source);
    return barcode === number || (ORDER.test(number) && order === number) ? [{ source: hit._source, barcode }] : [];
  });
  if (!own.length) throw new IndeterminateError(PROVIDER, 'Mongol Infinity Post answered for another parcel');
  const barcodes = new Set(own.map(({ barcode }) => barcode).filter(Boolean));
  if (barcodes.size > 1) throw new IndeterminateError(PROVIDER, 'Mongol Infinity Post lists several parcels under the order', { reason: 'several_parcels' });
  const [barcode] = barcodes;
  return result(own.map(({ source }) => projectRow(source)), barcode && barcode !== number ? { canonical_tracking_number: barcode } : {});
}

/** A customs status's wording, without the code the reply repeats in brackets. */
function customsWording(description: string, code: string): string {
  const suffix = ` (${code})`;
  return code && description.toUpperCase().endsWith(suffix.toUpperCase()) ? description.slice(0, -suffix.length).trim() : description;
}

/**
 * The reply of the customs lookup the home page makes for a number holding
 * YC, `order_api/api/customs/admin/status/item/{number}`: the item and its
 * customs statuses, oldest first. The item must name the number asked. Its
 * mail, order, bag and bill-of-lading references are not kept.
 */
export function parseMongolInfinityPostCustoms(payload: unknown, raw: string): CarrierResult {
  const number = normalizeMongolInfinityPostNumber(raw);
  const item = isRecord(payload) && isRecord(payload.result) ? payload.result.item : undefined;
  if (!isRecord(item) || typeof item.TRACKING_NUMBER !== 'string') throw new SchemaError(PROVIDER, 'Mongol Infinity Post returned a customs item without its number');
  if (item.TRACKING_NUMBER.length > 64 || normalizeTrackingNumber(item.TRACKING_NUMBER).toUpperCase() !== number) {
    throw new IndeterminateError(PROVIDER, 'Mongol Infinity Post answered for another item');
  }
  const rows = item.STATUS_LIST ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Mongol Infinity Post returned invalid customs statuses');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Mongol Infinity Post returned an oversized history');
  return result(rows.map((row): Scan => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Mongol Infinity Post returned an invalid customs status');
    const code = cleanScalar(row.STATUS_CD, 60);
    const description = customsWording(text(row, 'STATUS_DESC'), code);
    if (!description) throw new SchemaError(PROVIDER, 'Mongol Infinity Post returned a customs status without wording');
    const at = instant(row.CREATED_DATE);
    const staged = mongolInfinityPostStage(code, description);
    return { at: at.timestamp, event: {
      time: at.iso,
      description,
      ...(code ? { provider_code: code } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } };
  }));
}

/**
 * The customs lookup's HTTP 404: its own answer for an item it does not
 * know names the number. Any other 404 is a moved route.
 */
export function parseMongolInfinityPostCustomsRefusal(payload: unknown, raw: string): never {
  const number = normalizeMongolInfinityPostNumber(raw);
  const message = isRecord(payload) && payload.status === 'error' && typeof payload.message === 'string' ? clean(payload.message, 300) : '';
  if (message.toLowerCase() === `item with tracking_number ${number.toLowerCase()} not found`) throw new NotFoundError(PROVIDER);
  throw new TransportError(PROVIDER, 'Mongol Infinity Post customs lookup is unavailable', { status: 404 });
}
