import { IndeterminateError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { epochMillisTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { isSheinPackageNumber } from '../../core/detection/shein.js';
import { ecoscootingRequestNumber, isEcoscootingLabel } from './number.js';
import { ecoscootingStatus } from './status.js';

const DELIVERED = 'Your shipment has been delivered successfully';
const COLLECTED = ['PUDO Sign Success', ['Your shipment has been collected by consignee at the parcelshop']] as const;
/** Status name and descriptions that confirm each completion code. */
const COMPLETION_LABELS = new Map<string, readonly [string, readonly string[]]>([
  // GTMS scans come in their own wording or in the last-mile one.
  ['GTMS_SIGNED', ['Delivery Success', ['Parcel has been delivered successfully', DELIVERED]]],
  ['LM_SIGN_SUCCESS', ['Delivery Success', [DELIVERED]]],
  ['GTMS_PUDO_SIGNED', COLLECTED],
  ['PUDO_SIGN_SUCCESS', COLLECTED],
]);
/** Deliveries that are a collection at the pickup point, in either code family. */
const COLLECTION_CODES = new Set(['GTMS_PUDO_SIGNED', 'PUDO_SIGN_SUCCESS']);
/** Scans that place the parcel at a pickup point, in either code family. */
const PICKUP_POINT_CODES = new Set(['GTMS_PUDO_INBOUND', 'GTMS_STA_SIGNED', 'GTMS_PUDO_SIGNED', 'GTMS_PUDO_OVERDUE',
  'PUDO_INBOUND', 'PUDO_DELIVERY', 'PUDO_SIGN_SUCCESS', 'PUDO_OVERDUE']);

export function normalizeEcoscootingNumber(raw: string): string {
  return ecoscootingRequestNumber(raw);
}

export function parseEcoscooting(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeEcoscootingNumber(rawNumber);
  if (!isRecord(payload)) throw new SchemaError('Ecoscooting');
  // The same query error is returned for absent and unavailable orders. It
  // neither identifies a parcel nor proves that Ecoscooting does not know it.
  if (payload.success !== 'true') throw new IndeterminateError('Ecoscooting', 'Ecoscooting could not complete the tracking query',
    payload.errorMsg === 'query logisticOrder by mailNo error' ? { reason: 'portal_not_found' } : {});
  if (!isRecord(payload.packageParam)) throw new SchemaError('Ecoscooting', 'Ecoscooting returned a different parcel');
  // A SHEIN package number is the shop's order: the listing names it beside
  // Ecoscooting's own label, 18 digits in Spain or a `CN` reference in
  // Portugal, which the parcel then goes by.
  const listed = payload.packageParam;
  const label = isSheinPackageNumber(number) && listed.outOrderId === number && typeof listed.trackingNumber === 'string'
    && isEcoscootingLabel(listed.trackingNumber) ? listed.trackingNumber : number;
  if (listed.trackingNumber !== label) throw new SchemaError('Ecoscooting', 'Ecoscooting returned a different parcel');
  if (!Array.isArray(payload.statuses) || payload.statuses.length > 500 || !payload.statuses.every(isRecord)) throw new SchemaError('Ecoscooting');
  // A parcel announced to Ecoscooting but not yet handed over is listed without scans.
  if (!payload.statuses.length) throw new NoHistoryError('Ecoscooting', 'Ecoscooting lists the parcel without scans');
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  for (const row of payload.statuses) {
    const code = clean(row.actionCode, 64);
    const description = clean(row.description, 500) || clean(row.statusName, 500);
    if (!code || !description) throw new SchemaError('Ecoscooting', 'Ecoscooting returned an incomplete scan');
    if (['trackingNumber', 'mailNo'].some(key => row[key] != null && row[key] !== number && row[key] !== label)) throw new SchemaError('Ecoscooting', 'Ecoscooting returned a scan for a different parcel');
    if (row.opTimestamp != null && (typeof row.opTimestamp !== 'string' || !/^\d{13}$/.test(row.opTimestamp))) throw new SchemaError('Ecoscooting', 'Ecoscooting returned an invalid millisecond timestamp');
    const time = row.opTimestamp == null ? null : epochMillisTime(row.opTimestamp);
    if (row.opTimestamp != null && !time) throw new SchemaError('Ecoscooting', 'Ecoscooting returned an invalid scan timestamp');
    const display = clean(row.datetime, 64);
    const mapped = ecoscootingStatus(code, description);
    // Either code family may come with or without completion flags. A delivery
    // or a collection needs its exact code and both affirmative labels, and
    // flags, when present, must both affirm it.
    const labels = COMPLETION_LABELS.get(code);
    const flagsAgree = (!Object.hasOwn(row, 'statusGroup') && !Object.hasOwn(row, 'status'))
      || (row.statusGroup === 'delivered' && row.status === 'finish');
    const completed = !!labels && row.statusName === labels[0] && labels[1].includes(description) && flagsAgree;
    if (mapped?.stage === 'delivered' && !completed) throw new IndeterminateError('Ecoscooting', 'Ecoscooting returned inconsistent delivery evidence');
    const event: CarrierEvent = { ...(time ? { time: time.iso } : display ? { provider_time_text: display } : {}), description, provider_code: code, ...(mapped ? { stage: mapped.stage } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  // The last-mile station lists its exception or failed attempt first and the
  // return it decides at the same second: the parcel goes back, so the return leads.
  const returning = events.findIndex(event => event.stage === 'returned');
  if (returning > 0 && events[0]!.time && events.slice(0, returning + 1).every(event => event.time === events[0]!.time
    && (event.stage === 'exception' || event.stage === 'failed_attempt' || event.stage === 'returned'))) {
    events.unshift(...events.splice(returning, 1));
  }
  const latest = events[0]!;
  const current = ecoscootingStatus(String(latest.provider_code), latest.description);
  const dims = isRecord(payload.packageParam.dimWeight) ? payload.packageParam.dimWeight : {};
  const grams = typeof dims.weight === 'string' && /^\d+(?:\.\d+)?$/.test(dims.weight) ? Number(dims.weight) : Number.NaN;
  return { status: current?.status ?? 'unknown', ...(current ? { current_stage: current.stage } : {}),
    last_status_text: latest.description, last_update: latest.time ?? null, expected_delivery: null,
    ...(current?.stage === 'delivered' && latest.time ? { delivered_at: latest.time } : {}),
    ...(dims.weightUnit === 'g' && Number.isFinite(grams) && grams > 0 ? { weight_kg: grams / 1000 } : {}),
    ...pickupPoint(payload.popStationParam, events, current?.stage), events: events.slice(0, 100) };
}

// A shop's name and address, once a scan places the parcel there. It stays
// after collection so the parcel still says where it was collected, but a
// delivery by the courier, at the door, has none, and neither has a parcel on
// its way back to the sender, which no longer waits there. The pickup PIN, the
// shop's phone and the station id are never read.
function pickupPoint(station: unknown, events: CarrierEvent[], stage: string | undefined): { pickup_point?: string } {
  if (!isRecord(station) || stage === 'returned' || !events.some(event => PICKUP_POINT_CODES.has(String(event.provider_code)))) return {};
  if (stage === 'delivered' && !COLLECTION_CODES.has(String(events[0]?.provider_code))) return {};
  // The address joins its parts with commas and spells an empty one "NaN".
  const address = clean(station.detailAddress, 300).split(',').map(part => part.trim())
    .filter(part => part && !/^(?:NaN|null|undefined)$/i.test(part)).join(', ');
  const lines = [...new Set([clean(station.stationName, 160), address].filter(Boolean))];
  return lines.length ? { pickup_point: lines.join('\n') } : {};
}
