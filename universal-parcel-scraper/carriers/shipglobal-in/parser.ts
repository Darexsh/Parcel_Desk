import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { returnedTrackingNumber } from '../../core/detection/returned.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, countryCode, explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { shipGlobalStage } from './status.js';

export const PROVIDER = 'ShipGlobal India';
export const SHIPGLOBAL_MAX_BYTES = 512 * 1024;
const NUMBER = /^SG3\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{7}$/;
// The guest API writes seconds on some legs and minutes on others, without a zone.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2})[ T]([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(\.\d{1,3})?)?(Z|[+-](?:0\d|1[0-4]):[0-5]\d)?$/;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
const NAMED_RECEIVER = /\s*[,;:.\-–]?\s*\b(?:(?:received|collected|signed|delivered)(?:\s+for)?\s+by|(?:recipient|consignee|sender)\s*(?:name)?\s*[:=])[\s\S]*$/i;
const CONTACT = /\s*\bfor delivery issues\b[\s\S]*$/i;
const CAPABILITY = /https?:\/\/|mailto:|tel:|\S+@\S+|\b(?:OTP|PIN)\s*[:=]?\s*\d|(?<![A-Z\d])\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/i;

export function normalizeShipGlobalNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'ShipGlobal cannot look up this tracking number');
  return number;
}

function invalid(message: string): never {
  throw new SchemaError(PROVIDER, message);
}

function text(row: Record<string, unknown>, field: string, limit = 500): string {
  const value = row[field];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') invalid('ShipGlobal returned an invalid text field');
  return clean(value, limit);
}

/** Keep the scan, leaving out named recipients, support contacts and capability links. */
export function shipGlobalWording(raw: string): string {
  const wording = raw.replace(CONTACT, '').replace(NAMED_RECEIVER, '');
  const privateAt = wording.search(CAPABILITY);
  return clean(privateAt < 0 ? wording : wording.slice(0, privateAt), 500).replace(/[\s|;,]+$/, '');
}

function clockOf(value: unknown): Pick<CarrierEvent, 'time' | 'local_time'> {
  if (value === null || value === undefined || value === '') return {};
  if (typeof value !== 'string' || value.length > 64) invalid('ShipGlobal returned an invalid scan time');
  const match = CLOCK.exec(value);
  if (!match || !calendarDay(Number(match[1]), Number(match[2]), Number(match[3]))) invalid('ShipGlobal returned an invalid scan time');
  const wall = value.replace(' ', 'T');
  if (!match[8]) return { local_time: wall };
  if (match[8].slice(1, 3) === '14' && match[8].slice(-2) !== '00') invalid('ShipGlobal returned an invalid scan offset');
  const instant = explicitOffsetTime(wall);
  return instant ? { time: wall } : invalid('ShipGlobal returned an invalid scan time');
}

function eventOf(row: unknown): CarrierEvent {
  if (!isRecord(row)) invalid('ShipGlobal returned an invalid scan');
  const description = shipGlobalWording(text(row, 'awbHistoryComment', 2_000));
  if (!description) invalid('ShipGlobal returned a scan without its activity');
  const place = text(row, 'awbHistoryLocation', 300);
  const location = place === '-' || CAPABILITY.test(place) ? '' : place;
  const type = text(row, 'type', 40);
  const code = text(row, 'awbEventCode', 40);
  // awbHistoryCode is a shared zero placeholder on unrelated partner and domestic scans.
  const providerCode = type === 'bag' && /^SGE_\d{3}$/.test(code) ? code : '';
  const staged = shipGlobalStage(providerCode, description);
  return {
    ...clockOf(row.awbHistoryDatetime), description,
    ...(location ? { location } : {}),
    ...(providerCode ? { provider_code: providerCode } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/**
 * One identity-bound guest reply. All domestic, flight and partner rows are read;
 * names, postal addresses, account data and handoff URLs are never projected.
 * The site's foreign scans have no stated zone, so their clocks remain local.
 */
export function parseShipGlobal(payload: unknown, raw: string): CarrierResult {
  const number = normalizeShipGlobalNumber(raw);
  if (!isRecord(payload) || typeof payload.message !== 'string' || !Array.isArray(payload.errors)) {
    invalid('ShipGlobal returned an invalid envelope');
  }
  if (payload.errors.length) throw new IndeterminateError(PROVIDER, 'ShipGlobal did not complete the lookup');
  if (payload.message === 'OrderId not found') {
    if (!Array.isArray(payload.data) || payload.data.length) invalid('ShipGlobal returned a shipment under its not-found notice');
    throw new NotFoundError(PROVIDER);
  }
  if (payload.message !== 'Success') throw new IndeterminateError(PROVIDER, 'ShipGlobal did not complete the lookup');
  const data = payload.data;
  if (!isRecord(data) || !isRecord(data.awbInfo) || !Array.isArray(data.trackingInfo)) invalid('ShipGlobal returned an invalid shipment');
  const info = data.awbInfo;
  if (typeof info.awbNumber !== 'string' || !returnedTrackingNumber(info.awbNumber)) invalid('ShipGlobal returned a shipment without its number');
  if (returnedTrackingNumber(info.awbNumber) !== number) throw new IndeterminateError(PROVIDER, 'ShipGlobal answered for another shipment');
  if (data.trackingInfo.length > MAX_ROWS) invalid('ShipGlobal returned an oversized history');
  const summary = shipGlobalWording(text(info, 'awbStatus'));
  const seen = new Set<string>();
  const events = data.trackingInfo.map(eventOf).filter((event) => {
    const key = JSON.stringify(event);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // An echoed number and a summary do not establish dated tracking activity.
  if (!events.some((event) => event.time || event.local_time)) throw new NoHistoryError(PROVIDER);
  if (listsNewestFirst(events) === false) events.reverse();

  // A generic delivery after the same history began returning the parcel is delivery of the return.
  let returning = false;
  for (const event of [...events].reverse()) {
    if (event.stage === 'returned') returning = true;
    else if (returning && event.stage === 'delivered') Object.assign(event, { stage: 'returned', stage_source: 'carrier_map' });
  }
  const newest = events[0]!;
  const dated = events.find((event) => event.time || event.local_time)!;
  const staged = events.find((event) => event.stage);
  const summaryStage = staged ? null : shipGlobalStage('', summary);
  const stage = (staged?.stage ?? summaryStage?.stage) as Stage | undefined;
  const source = staged?.stage_source ?? summaryStage?.source;
  const country = countryCode(text(info, 'awbDestination', 100));
  const partner = returnedTrackingNumber(info.partnerLastMileAwb);
  const delivery = stage === 'delivered' ? events.find((event) => event.stage === 'delivered' && event.time) : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source } : {}),
    last_status_text: newest.description!,
    last_update: dated.time ?? null,
    ...(dated.local_time ? { last_update_local: dated.local_time } : {}),
    expected_delivery: null,
    ...(delivery?.time ? { delivered_at: delivery.time } : {}),
    ...(country ? { destination_country: country } : {}),
    ...(partner !== number && /^[A-Z0-9]{4,40}$/.test(partner) ? { delivery_tracking_number: partner } : {}),
    ...(events.length > MAX_EVENTS || events.some((event) => !event.time && !event.local_time) ? { history_truncated: true } : {}),
    events: events.slice(0, MAX_EVENTS),
  };
}
