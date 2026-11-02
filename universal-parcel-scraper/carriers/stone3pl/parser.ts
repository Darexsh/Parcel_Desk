import { carrierIdFromName } from '../../core/catalog/hints.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, countryCode } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { stone3plScanStage } from './status.js';

export const PROVIDER = 'Stone3PL';
const NUMBER = /^(?=.*\d)[A-Z0-9]{4,40}$/;
const CLOCK = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/;
const PHONE = /(?<![A-Z\d])(?!\d{4}-\d{2}-\d{2}(?!\d))\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
const RECEIVER = /\s*[,;:.\-–]?\s*\b(?:signed(?: for)? by|signatory|received by)\b[\s\S]*$/i;

export function normalizeStone3plNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Stone3PL needs one alphanumeric tracking number');
  return number;
}

function text(row: Record<string, unknown>, key: string, maxLength = 1000): string {
  const value = row[key];
  if (value == null) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Stone3PL returned an invalid ${key}`);
  return clean(value, maxLength);
}

function identity(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (value == null || value === '') return '';
  // Never truncate identity: a longer number with the same prefix is a different parcel.
  if (typeof value !== 'string' || value.length > 64) throw new SchemaError(PROVIDER, `Stone3PL returned an invalid ${key}`);
  const number = normalizeTrackingNumber(value);
  if (!NUMBER.test(number)) throw new SchemaError(PROVIDER, `Stone3PL returned an invalid ${key}`);
  return number;
}

export function stone3plWording(value: string): string {
  return clean(value.replace(RECEIVER, '').replace(PHONE, '').replace(/\s+([,;:.])/g, '$1'))
    .replace(/^[\s,;:\-–]+|[\s,;:\-–]+$/g, '');
}

function wallClock(value: string): string {
  const match = CLOCK.exec(value);
  const date = match ? calendarDay(Number(match[1]), Number(match[2]), Number(match[3])) : null;
  if (!date || Number(match![4]) > 23 || Number(match![5]) > 59 || Number(match![6]) > 59) {
    throw new SchemaError(PROVIDER, 'Stone3PL returned an invalid scan time');
  }
  return `${date}T${match![4]!}:${match![5]!}:${match![6]!}`;
}

function code(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d{1,3}$/.test(value)) return Number(value);
  throw new SchemaError(PROVIDER, 'Stone3PL returned an invalid status code');
}

/** The public page's display buckets differ from its raw status codes. */
function displayStatus(row: Record<string, unknown>): number | undefined {
  const front = code(row.front_status);
  if (front !== undefined) return front;
  const raw = code(row.status);
  if (raw === 0 || raw === 1) return raw;
  if (raw === 2 || raw === 25) return 2;
  if (raw === 4) return 3;
  if (raw !== undefined && [3, 5, 6, 7, 8].includes(raw)) return 4;
  return undefined;
}

function scanRows(value: unknown, destination: boolean): unknown[] {
  if (Array.isArray(value)) {
    if (value.length > 500) throw new SchemaError(PROVIDER, 'Stone3PL returned an oversized history');
    return value;
  }
  // PHP can return a milestone object rather than the destination scan array.
  // A time alone is no scan; the tracking page does not render these objects.
  if (destination && isRecord(value) && Object.keys(value).length <= 500
    && Object.keys(value).every(key => /^-?\d+$/.test(key))) {
    return Object.values(value).filter(row => !(isRecord(row)
      && Object.keys(row).length === 1 && typeof row.t_time === 'string'));
  }
  throw new SchemaError(PROVIDER, 'Stone3PL returned an invalid scan history');
}

function scans(value: unknown, destination: boolean): CarrierEvent[] {
  const events: CarrierEvent[] = [];
  for (const raw of scanRows(value, destination)) {
    if (!isRecord(raw)) throw new SchemaError(PROVIDER, 'Stone3PL returned an invalid scan');
    const timestamp = text(raw, 't_time', 80);
    const wording = text(raw, 'text', 2000);
    if (!timestamp || !wording) throw new SchemaError(PROVIDER, 'Stone3PL returned an incomplete scan');
    const local = wallClock(timestamp);
    const description = stone3plWording(wording);
    const providerCode = code(raw.status);
    if (!description) continue;
    const staged = stone3plScanStage(description);
    events.push({ local_time: local, description,
      ...(providerCode === undefined ? {} : { provider_code: String(providerCode) }),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) });
  }
  // Retain each stream's order; its wall clocks can belong to several countries.
  if (events.length > 1 && String(events[0]!.local_time) < String(events.at(-1)!.local_time)) events.reverse();
  return events;
}

export function parseStone3pl(payload: unknown, raw: string): CarrierResult {
  const number = normalizeStone3plNumber(raw);
  if (!isRecord(payload) || code(payload.code) === undefined) throw new SchemaError(PROVIDER, 'Stone3PL returned an invalid envelope');
  if (code(payload.code) !== 0) throw new IndeterminateError(PROVIDER, 'Stone3PL did not complete the lookup');
  const data = payload.data;
  if (!isRecord(data) || !Array.isArray(data.all_data) || data.all_data.length > 40) {
    throw new SchemaError(PROVIDER, 'Stone3PL returned an invalid shipment list');
  }
  const matches = data.all_data.filter(row => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Stone3PL returned an invalid shipment');
    const main = identity(row, 'number');
    if (!main) throw new SchemaError(PROVIDER, 'Stone3PL returned a shipment without its number');
    return [main, identity(row, 'true_track_number'), identity(row, 'tracking_number')].includes(number);
  });
  if (matches.length !== 1) throw new IndeterminateError(PROVIDER, 'Stone3PL did not return one matching shipment');
  const shipment = matches[0] as Record<string, unknown>;
  const origin = scans(shipment.track_info, false);
  const destination = scans(shipment.track_last, true);
  const seen = new Set<string>();
  // The website presents destination history first, then the origin's history.
  const events = [...destination, ...origin].filter(event => {
    const key = JSON.stringify([event.local_time, event.description]);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  const display = displayStatus(shipment);
  if (display === 0) {
    if (events.length) throw new IndeterminateError(PROVIDER, 'Stone3PL returned conflicting shipment information');
    throw new NotFoundError(PROVIDER);
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  const staged = events.find(event => event.stage);
  // The overall transit bucket also covers electronic pre-advice. Prefer its actual scans.
  const headline: Stage | undefined = display === 2 ? 'ready_for_pickup' : display === 3 ? 'delivered'
    : display === 4 ? 'exception' : undefined;
  const stage = headline ?? (staged?.stage as Stage | undefined) ?? (display === 1 ? 'in_transit' : undefined);
  const source = headline ? 'carrier_map' : staged?.stage_source ?? 'carrier_map';
  const newest = events[0]!;
  const partnerNumber = identity(shipment, 'true_track_number') || identity(shipment, 'tracking_number');
  const partnerName = text(shipment, 'carrier_name_en', 200) || text(shipment, 'carrier_name', 200)
    || text(shipment, 'shipping_flat_name_en', 200);
  const partner = partnerName ? carrierIdFromName(partnerName) : undefined;
  const country = countryCode(text(shipment, 'destination_country', 100));
  const from = countryCode(text(shipment, 'departure_country_code', 100));
  const service = text(shipment, 'shipping_method', 80);
  const canonical = identity(shipment, 'number');
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source } : {}),
    last_status_text: stone3plWording(text(shipment, 'track_desc', 2000)) || newest.description!,
    last_update: null, last_update_local: newest.local_time, expected_delivery: null,
    ...(headline && !events.some(event => event.stage === headline) ? { summary_only: true } : {}),
    ...(country ? { destination_country: country } : {}),
    ...(from ? { origin_country: from } : {}),
    ...(service ? { service_name: service } : {}),
    ...(canonical !== number ? { canonical_tracking_number: canonical } : {}),
    ...(partnerNumber && partnerNumber !== canonical ? { delivery_tracking_number: partnerNumber } : {}),
    ...(partner && partner !== 'stone3pl' && partner !== 'unknown' ? { delivery_carrier: partner } : {}),
    events,
  };
}
