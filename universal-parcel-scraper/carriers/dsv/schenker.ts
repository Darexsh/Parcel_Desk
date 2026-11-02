import { DateTime } from 'luxon';
import { isValidSscc } from '../../core/detection/index.js';
import { returnedTrackingNumber } from '../../core/detection/returned.js';
import { IndeterminateError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { normalizeDsvNumber, PROVIDER } from './parser.js';
import { dsvStage } from './status.js';

const MAX_SHIPMENTS = 100;
const MAX_ROWS = 1000;
const MAX_EVENTS = 100;
const MAX_PACKAGES = 1000;
// "LandStt:<STT>:<data sources>:LAND", the id the tracker's own detail request takes.
const LAND_ID = /^[A-Za-z]{2,30}:[A-Z0-9]{3,40}:[A-Z]{2,10}(?:,[A-Z]{2,10}){0,5}:LAND$/;
// A former DB Schenker road STT: three letters and seven or eight digits, or five letters and nine digits.
const STT = /^(?:[A-Z]{3}\d{7,8}|[A-Z]{5}\d{9})$/;
const CODE = /^[A-Z0-9]{2,10}$/;
const CLOCK = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?$/;
// Postcodes and street numbers in a place name.
const DIGITS = /\S*\d{3,}\S*/g;

/**
 * How the former DB Schenker tracker is asked for a number: an STT straight
 * by its details, a package's SSCC through the search, any other number not
 * at all.
 */
export function dsvSchenkerRoute(number: string): 'stt' | 'sscc' | null {
  if (STT.test(number)) return 'stt';
  return isValidSscc(/^\d{18}$/.test(number) ? `00${number}` : number) ? 'sscc' : null;
}

/** The details id of a road STT, without the data sources the tracker adds itself. */
export function dsvSchenkerSttId(number: string): string {
  return `LandStt:${number}:LAND`;
}

/** The reply's id is the one asked for, or a road id of the same kind for an id asked without its data sources. */
function answersId(asked: string, replied: unknown): boolean {
  if (typeof replied !== 'string' || replied === asked) return true;
  const [type, , sources] = asked.split(':');
  return sources === 'LAND' && LAND_ID.test(replied) && replied.startsWith(`${type}:`);
}

/**
 * The former DB Schenker tracker's search: the shipments whose STT, package,
 * waybill or a reference matches the number. Only a road shipment is read,
 * and only its id; whether the number is the shipment's own is settled by
 * its details.
 */
export function pickDsvSchenkerShipment(payload: unknown, rawNumber: string): string {
  const number = normalizeDsvNumber(rawNumber);
  if (!isRecord(payload) || !Array.isArray(payload.result) || payload.result.length > MAX_SHIPMENTS
    || !payload.result.every(isRecord)) {
    throw new SchemaError(PROVIDER, 'DSV\'s former DB Schenker tracker did not return a shipment list');
  }
  const entries = payload.result as Record<string, unknown>[];
  if (!entries.length) notFound();
  const own = entries.filter(entry => returnedTrackingNumber(entry.stt) === number);
  const entry = own.length === 1 ? own[0]! : entries.length === 1 ? entries[0]! : null;
  if (!entry) throw new IndeterminateError(PROVIDER, 'DSV\'s former DB Schenker tracker found several shipments for the number', { reason: 'several_parcels' });
  if (entry.transportMode !== 'LAND') {
    throw new IndeterminateError(PROVIDER, 'DSV\'s former DB Schenker tracker found an air or ocean shipment, which the adapter does not read');
  }
  if (typeof entry.id !== 'string' || !LAND_ID.test(entry.id)) throw new SchemaError(PROVIDER, 'DSV\'s former DB Schenker tracker returned a shipment without its id');
  return entry.id;
}

/** Neither of DSV's public trackers knows the number. */
export function notFound(): never {
  throw new IndeterminateError(PROVIDER, 'Neither of DSV\'s public trackers knows the number', { reason: 'portal_not_found' });
}

/**
 * The ids the shipment carries itself: its STT, the STT it was booked under
 * and its packages' SSCCs, with or without the 00 that precedes an SSCC in
 * its barcode. Waybills and the parties' references are not among them.
 */
function ownIds(payload: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  const references = isRecord(payload.references) ? payload.references : {};
  for (const value of [payload.sttNumber, references.originalStt]) {
    const id = returnedTrackingNumber(value);
    if (id) ids.add(id);
  }
  const packages = Array.isArray(payload.packages) ? payload.packages.slice(0, MAX_PACKAGES) : [];
  for (const entry of packages) {
    const id = isRecord(entry) ? returnedTrackingNumber(entry.id, true) : '';
    if (!id) continue;
    ids.add(id);
    if (/^\d{18}$/.test(id)) ids.add(`00${id}`);
  }
  return ids;
}

/** The row's clock as the page prints it: the wall clock as written, whatever offset follows it. */
function clockOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const match = typeof value === 'string' ? CLOCK.exec(value.trim()) : null;
  if (!match) throw new SchemaError(PROVIDER, 'DSV\'s former DB Schenker tracker returned an invalid date');
  // UTC only checks the calendar fields. No offset is assigned: some rows label a local clock Z.
  const parsed = DateTime.fromFormat(`${match[1]} ${match[2]}`, 'yyyy-MM-dd HH:mm:ss', { zone: 'UTC' });
  if (!parsed.isValid) throw new SchemaError(PROVIDER, 'DSV\'s former DB Schenker tracker returned an invalid date');
  return parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

/** "Place, CC": the terminal's or the stop's town and its country, without postcodes. */
function locationOf(value: unknown): string {
  if (!isRecord(value)) return '';
  const place = clean(clean(value.name, 120).replace(DIGITS, ' ')).replace(/^[\s,/-]+|[\s,/-]+$/g, '');
  const country = clean(value.countryCode, 2).toUpperCase();
  return [place, /^[A-Z]{2}$/.test(country) ? country : ''].filter(Boolean).join(', ');
}

/** The reasons the page prints beside a row, such as why a delivery failed. */
function reasonsOf(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new SchemaError(PROVIDER, 'DSV\'s former DB Schenker tracker returned invalid reasons');
  return value.slice(0, 10).map(reason => isRecord(reason) ? clean(reason.description, 200) || cleanScalar(reason.code, 10) : '')
    .filter(Boolean);
}

/** The day of the agreed delivery, else of the estimated one. */
function estimateOf(value: unknown): string | null {
  if (!isRecord(value)) return null;
  for (const date of [value.agreed, value.estimated]) {
    const clock = date === null || date === undefined ? null : clockOf(date);
    if (clock) return clock.slice(0, 10);
  }
  return null;
}

interface Scan {
  readonly event: CarrierEvent;
  readonly index: number;
}

/**
 * A road shipment's details from the former DB Schenker tracker. The number
 * must be one of the shipment's own ids. The history is the shipment's status
 * rows: a code, English wording, a wall clock, a place and the reasons the
 * page shows. The parties, their references, addresses and goods, the
 * recipient's name on a delivery and the packages' own rows are not read.
 */
export function parseDsvSchenkerShipment(payload: unknown, rawNumber: string, id: string): CarrierResult {
  const number = normalizeDsvNumber(rawNumber);
  if (!isRecord(payload) || !Array.isArray(payload.events) || typeof payload.sttNumber !== 'string'
    || !(Array.isArray(payload.packages) || payload.packages === null || payload.packages === undefined)) {
    throw new SchemaError(PROVIDER, 'DSV\'s former DB Schenker tracker did not return the shipment');
  }
  if (!answersId(id, payload.shipmentId)) {
    throw new SchemaError(PROVIDER, 'DSV\'s former DB Schenker tracker returned another shipment');
  }
  if (!ownIds(payload).has(number)) {
    throw new IndeterminateError(PROVIDER, 'The number matched only a reference of a former DB Schenker shipment', { reason: 'reference_only' });
  }
  if (payload.events.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'DSV\'s former DB Schenker tracker returned an unexpectedly long history');
  const scans: Scan[] = [];
  const seen = new Set<string>();
  payload.events.forEach((row: unknown, index) => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'DSV\'s former DB Schenker tracker returned an invalid history row');
    const code = cleanScalar(row.code, 40).toUpperCase();
    if (!CODE.test(code)) throw new SchemaError(PROVIDER, 'DSV\'s former DB Schenker tracker returned a row without a code');
    const time = clockOf(row.date);
    if (!time) return;
    const wording = clean(row.comment, 300) || code;
    const reasons = reasonsOf(row.reasons);
    const description = reasons.length ? `${wording}: ${reasons.join(', ')}` : wording;
    const location = locationOf(row.location);
    const event: CarrierEvent = { local_time: time, description, provider_code: code, ...(location ? { location } : {}) };
    const classified = dsvStage(code, wording);
    if (classified) Object.assign(event, { stage: classified.stage, stage_source: classified.source });
    const identity = JSON.stringify(event);
    if (seen.has(identity)) return;
    seen.add(identity);
    scans.push({ event, index });
  });
  if (!scans.length) throw new IndeterminateError(PROVIDER, 'DSV\'s former DB Schenker tracker returned the shipment without a history', { reason: 'no_history' });
  // Newest first. The reply runs oldest first, so rows at the same clock keep its order reversed.
  scans.sort((left, right) => {
    const a = left.event.local_time as string;
    const b = right.event.local_time as string;
    return b > a ? 1 : b < a ? -1 : right.index - left.index;
  });
  const events = scans.map(scan => scan.event);
  const latest = events[0]!;
  const stage = latest.stage as Stage | undefined;
  const expected = stage === 'delivered' ? null : estimateOf(payload.deliveryDate);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: latest.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: null,
    last_update_local: latest.local_time,
    expected_delivery: expected,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
