import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord, type JsonObject } from '../../core/types.js';
import { classifyLbcScan, RELEASED } from './status.js';

// Domestic waybills have twelve digits; LBC's tracking also answers for ten-,
// eleven- and fourteen-digit numbers.
export function normalizeLbcNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!/^(?:\d{10,12}|\d{14})$/.test(number)) throw new InvalidInputError('lbc-express', 'LBC requires a tracking number of 10 to 12 or 14 digits');
  return number;
}

/** A release names the representative who took the parcel: keep the milestone, never the name. */
export function withoutRepresentative(text: string): string {
  return /^Released to authorized representative\b/i.test(text) ? RELEASED : /^Released to\b/i.test(text) ? 'Release update' : text;
}

/** One scan of LBC's `LBCTrackAndTrace` result, which the app's SOAP reply and the website's JSON copy of it both carry. */
export interface LbcScan {
  code: string;
  wording: string;
  day: string;
  time: string;
  town: string;
  province: string;
}

function invalidScan(): never { throw new SchemaError('lbc-express', 'LBC returned an invalid shipment scan'); }

function scanClock(day: string, time: string): string | null {
  if (!time) return null;
  if (!/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(day) || !/^\d{1,2}:\d{2}:\d{2} [AP]M$/.test(time)) invalidScan();
  const parsed = DateTime.fromFormat(`${day} ${time}`, 'M/d/yyyy h:mm:ss a', { locale: 'en', zone: 'UTC' });
  if (!parsed.isValid) invalidScan();
  // UTC only validates calendar digits; the provider gives no offset.
  return parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

/** The history of a result that names the requested shipment, from its oldest-first scans. */
export function lbcHistory(scans: readonly LbcScan[]): CarrierResult {
  if (!scans.length) throw new IndeterminateError('lbc-express', 'LBC returned no shipment scans');
  if (scans.length > 500) throw new SchemaError('lbc-express', 'LBC returned too many shipment scans');
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  for (const scan of scans) {
    const { code, wording, day, time } = scan;
    const description = code === '1' ? 'Delivered' : /^Delivered to\b/i.test(wording) ? 'Delivery update' : withoutRepresentative(wording);
    const mapped = classifyLbcScan(code, description);
    const local = scanClock(day, time);
    // The town and province of the scanning branch. A forwarding scan carries its
    // destination's instead, so it gets none.
    const forwarding = code === '8820' || /^Shipment is en route to\b|\bon its way to\b/i.test(wording);
    const location = forwarding ? '' : [scan.town, scan.province].filter(Boolean).join(', ');
    const event: CarrierEvent = { description, ...(location ? { location } : {}), provider_code: code,
      provider_time_text: `${day}${time ? ` ${time}` : ''}`,
      ...(local ? { local_time: local } : {}), ...(mapped ? { stage: mapped.stage, stage_source: 'carrier_map' } : {}) };
    // Branch, remarks, coordinates, internal wording and recipient/sender fields are not projected.
    const identity = JSON.stringify(event);
    if (seen.has(identity)) continue;
    seen.add(identity);
    events.push(event);
  }
  // LBC supplies oldest-first scans; valid local clocks can sort them.
  events.reverse();
  if (events.every(event => typeof event.local_time === 'string')) {
    events.sort((a, b) => String(b.local_time).localeCompare(String(a.local_time)));
  }
  const current = events[0]!;
  const mapped = classifyLbcScan(String(current.provider_code), current.description!);
  return { status: mapped?.status ?? 'unknown', ...(mapped ? { current_stage: mapped.stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: current.description, last_update: null, ...(current.local_time ? { last_update_local: current.local_time } : {}),
    timezone: 'Asia/Manila', events: events.slice(0, 100) };
}

function invalidJson(): never { throw new SchemaError('lbc-express', 'LBC returned invalid tracking JSON'); }

function object(value: unknown): JsonObject {
  return isRecord(value) ? value : invalidJson();
}

// The website copies each XML element: text becomes a string, an empty element
// an empty array or object, and a repeated one an array.
function empty(value: unknown): boolean {
  return Array.isArray(value) ? value.length === 0 : isRecord(value) && Object.keys(value).length === 0;
}

function elements(value: unknown): JsonObject[] {
  if (value === undefined || empty(value)) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.every(isRecord) ? list : invalidJson();
}

function scalar(node: JsonObject, name: string, required = true, max = 1000): string {
  const value = node[name];
  if (value !== undefined && !empty(value) && typeof value !== 'string') invalidJson();
  const text = typeof value === 'string' ? clean(value, max) : '';
  if (required && !text) invalidJson();
  return text;
}

/**
 * The website's `track_package` reply: the app service's result copied into
 * JSON. It holds recipient and sender details, which are never read.
 */
export function parseLbcWebsite(payload: unknown, raw: string): CarrierResult {
  const number = normalizeLbcNumber(raw);
  const reply = object(payload);
  if (typeof reply.success !== 'boolean') invalidJson();
  // WordPress's error answer: the page could not read the tracking service.
  if (!reply.success) throw new TransportError('lbc-express', 'LBC tracking page returned an error');
  const body = object(object(reply.data).Body);
  if (body.Fault !== undefined) throw new IndeterminateError('lbc-express', 'LBC returned a tracking service fault');
  const status = object(object(object(body.LBCTrackAndTraceResponse).LBCTrackAndTraceResult).TrackingStatus);
  // Remittances and unbound service errors do not establish parcel absence.
  if (scalar(status, 'StatusCode', true, 16) !== '0001') throw new IndeterminateError('lbc-express', 'LBC returned no confirmed parcel history');
  const details = elements(object(status.TrackingDetails).TrackingDetails);
  if (details.length !== 1) invalidJson();
  if (scalar(details[0]!, 'TrackingNo', true, 40) !== number) throw new SchemaError('lbc-express', 'LBC returned a different shipment');
  const history = empty(status.TrackingHistory) ? [] : elements(object(status.TrackingHistory).TrackingHistory);
  return lbcHistory(history.map(row => ({
    code: scalar(row, 'StatusId', true, 32), wording: scalar(row, 'StatusandLocation'),
    day: scalar(row, 'DatePosted', true, 64), time: scalar(row, 'DatePostedTime', false, 64),
    town: scalar(row, 'CityName', false, 120), province: scalar(row, 'ProvinceName', false, 120),
  })));
}
