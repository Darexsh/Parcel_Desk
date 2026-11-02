import { returnedTrackingNumber } from '../../core/detection/returned.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult, CarrierStatus } from '../../core/result/index.js';
import type { Stage } from '../../core/status/index.js';
import { explicitOffsetTime, zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';

const PROVIDER = 'Nova Poshta';
const STAGES: Readonly<Record<string, Stage>> = {
  '1': 'registered', '2': 'exception', '4': 'in_transit', '41': 'in_transit', '5': 'in_transit', '6': 'in_transit',
  '7': 'ready_for_pickup', '8': 'ready_for_pickup', '9': 'delivered', '10': 'delivered', '11': 'delivered',
  '14': 'in_transit', '101': 'out_for_delivery', '102': 'exception', '103': 'exception', '104': 'in_transit',
  '105': 'exception', '106': 'delivered', '108': 'exception',
};
const MOVEMENT_STAGES: Readonly<Record<string, Stage>> = {
  ...STAGES, '4': 'accepted', '80': 'in_transit', '81': 'in_transit',
  '112': 'in_transit', '115': 'customs', '119': 'customs', '120': 'in_transit', '121': 'in_transit', '122': 'in_transit',
  '199': 'customs',
};
/** A movement code's stage, unless its event names a return. */
export function movementStage(code: string): Stage | undefined {
  return Object.hasOwn(MOVEMENT_STAGES, code) ? MOVEMENT_STAGES[code] : undefined;
}
// Code 9 also closes a return at the sending branch, and code 102 opens it.
const EVENT_STAGES: Readonly<Record<string, Stage>> = { OrderCargoReturn: 'returned', ShipmentReturnReceived: 'returned' };
// Arrival at, and collection from, the branch or locker the recipient chose.
const PICKUP_EVENTS = new Set(['ArrivalRecipientWarehouse', 'ArrivalRecipientPostomat', 'ReceivedWarehouse']);
// Partners abroad that deliver Nova Poshta exports under their own number.
const PARTNERS: Readonly<Record<string, string>> = { UPS: 'ups', PylonLogisticsUPS: 'ups', PylonLogisticsGofoExpress: 'gofo' };
const DELIVERY_REFERENCES = new Set(['NPU', 'NPU_Redirecting']);
function movementTime(value: unknown): string | undefined {
  const text = clean(value, 64);
  // Luxon normalizes impossible offsets; those must remain unresolved.
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/.test(text)
    ? explicitOffsetTime(text)?.iso : undefined;
}
function statusOf(stage: string | undefined): CarrierStatus {
  return stage === 'delivered' ? 'delivered' : stage === 'out_for_delivery' ? 'out_for_delivery'
    : ['returned', 'exception', 'failed_attempt'].includes(stage ?? '') ? 'exception'
      : ['registered', 'pending'].includes(stage ?? '') ? 'pending' : stage ? 'in_transit' : 'unknown';
}
// Domestic families named by the official tracking client's router.
const WAYBILL = /^(?:1\d{13}|(?:20[4678]|590|595)\d{11}|(?:21|51)\d{12})$/;
// Nova Post's international shipments as novapost.com's tracker routes them to the same
// movement feed: SH or TN, two letters for the country and ten digits, at times after RS.
const INTERNATIONAL = /^(?:RS)?(?:SH|TN)[A-Z]{2}\d{10}$/;
export function normalizeNovaPoshtaNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!WAYBILL.test(number) && !INTERNATIONAL.test(number)) {
    throw new InvalidInputError(PROVIDER, 'Nova Poshta requires a Ukrainian waybill or a Nova Post international number');
  }
  return number;
}
/** Whether a number is a Ukrainian waybill, the only kind the older status API knows. */
export function isNovaPoshtaWaybill(number: string): boolean {
  return WAYBILL.test(number);
}
function receiptTime(value: unknown): string | undefined {
  const text = clean(value, 64);
  const format = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text) ? 'yyyy-MM-dd HH:mm:ss'
    : /^\d{2}-\d{2}-\d{4} \d{2}:\d{2}:\d{2}$/.test(text) ? 'dd-MM-yyyy HH:mm:ss' : null;
  return format ? zonedTime(text, format, 'Europe/Kyiv')?.iso : undefined;
}
export function parseNovaPoshta(payload: unknown, raw: string): CarrierResult {
  const number = normalizeNovaPoshtaNumber(raw);
  // It answers "not found" for any international number, so its answer says nothing about one.
  if (!isNovaPoshtaWaybill(number)) throw new IndeterminateError(PROVIDER, 'Nova Poshta status summaries cover Ukrainian waybills only');
  if (!isRecord(payload) || !Array.isArray(payload.errors) || !Array.isArray(payload.data)) throw new SchemaError(PROVIDER);
  if (payload.success === false || payload.errors.length) throw new IndeterminateError(PROVIDER, 'Nova Poshta could not return shipment details');
  if (payload.success !== true || payload.data.length !== 1 || !isRecord(payload.data[0])) throw new SchemaError(PROVIDER);
  const item = payload.data[0];
  if (typeof item.Number !== 'string' || normalizeTrackingNumber(item.Number) !== number) throw new SchemaError(PROVIDER, 'Nova Poshta returned a different shipment');
  const code = clean(item.StatusCode, 32), description = clean(item.Status, 1000);
  if (!code || !description) throw new SchemaError(PROVIDER, 'Nova Poshta returned no status');
  if (code === '3') throw new NotFoundError(PROVIDER);
  const stage = STAGES[code];
  const status: CarrierStatus = stage === 'delivered' ? 'delivered' : stage === 'out_for_delivery' ? 'out_for_delivery'
    : stage === 'exception' ? 'exception' : stage === 'registered' ? 'pending' : stage ? 'in_transit' : 'unknown';
  // DateCreated is booking, TrackingUpdateDate is metadata refresh. Neither is
  // an instant for the current status. RecipientDateTime explicitly records receipt.
  const delivered = stage === 'delivered' ? receiptTime(item.RecipientDateTime) : undefined;
  return { status, ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: description, last_update: delivered ?? null, ...(delivered ? { delivered_at: delivered } : {}),
    timezone: 'Europe/Kyiv', summary_only: true, events: [] };
}

/** The current public site's movement feed, including carrier-bound rerouting. */
export function parseNovaPoshtaHistory(payload: unknown, raw: string): CarrierResult {
  const number = normalizeNovaPoshtaNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER);
  if (isRecord(payload.errors)) throw new IndeterminateError(PROVIDER, 'Nova Poshta could not return movement history');
  if (typeof payload.number !== 'string' || normalizeTrackingNumber(payload.number) !== number) {
    throw new SchemaError(PROVIDER, 'Nova Poshta returned a different shipment');
  }
  if (!Array.isArray(payload.tracking) || payload.tracking.length > 1000) throw new SchemaError(PROVIDER);
  const parcelNumbers = new Set([number]);
  if (payload.parcels !== undefined) {
    if (!Array.isArray(payload.parcels) || payload.parcels.length > 1000) throw new SchemaError(PROVIDER);
    for (const parcel of payload.parcels) {
      if (!isRecord(parcel) || typeof parcel.number !== 'string' || !parcel.number.trim() || parcel.number.length > 64) throw new SchemaError(PROVIDER);
      parcelNumbers.add(normalizeTrackingNumber(parcel.number));
    }
  }
  // The website lists redirected waybills separately from return and payment
  // references. Only a declared delivery reference may extend this history.
  for (const field of ['alternativeNumbersGW', 'alternativeNumbersGWNew']) {
    const references = payload[field];
    if (references === undefined) continue;
    if (!Array.isArray(references) || references.length > 100) throw new SchemaError(PROVIDER);
    for (const reference of references) {
      if (!isRecord(reference) || typeof reference.name !== 'string' || typeof reference.number !== 'string'
        || !reference.number.trim() || reference.number.length > 64) throw new SchemaError(PROVIDER);
      if (DELIVERY_REFERENCES.has(reference.name)) parcelNumbers.add(normalizeTrackingNumber(reference.number));
    }
  }
  let current: CarrierEvent | undefined;
  const points = new Map<CarrierEvent, string>();
  const events: CarrierEvent[] = payload.tracking.flatMap(row => {
    if (!isRecord(row) || typeof row.parcel_number !== 'string' || !parcelNumbers.has(normalizeTrackingNumber(row.parcel_number))) {
      throw new SchemaError(PROVIDER, 'Nova Poshta returned mixed shipment history');
    }
    if (typeof row.event_status !== 'string' || !['passed', 'now', 'future'].includes(row.event_status)) throw new SchemaError(PROVIDER, 'Nova Poshta returned an invalid movement state');
    // A dated future rail point is a plan, not a completed scan.
    if (row.event_status === 'future') return [];
    const description = clean(row.event_name, 1000), code = clean(row.code, 32);
    if (!description || !code) throw new SchemaError(PROVIDER, 'Nova Poshta returned an empty movement');
    const timeText = clean(row.date, 64), time = movementTime(timeText);
    const name = clean(row.event, 64);
    const stage = EVENT_STAGES[name] ?? movementStage(code);
    const location = clean(row.settlement_name, 200);
    const event: CarrierEvent = { description, provider_code: code, ...(time ? { time } : timeText ? { provider_time_text: timeText } : {}),
      ...(location ? { location } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    const division = clean(row.division_name, 200);
    if (PICKUP_EVENTS.has(name) && division) points.set(event, location ? `${division}\n${location}` : division);
    if (row.event_status === 'now') {
      if (current) throw new IndeterminateError(PROVIDER, 'Nova Poshta returned multiple current movements');
      current = event;
    }
    return [event];
  });
  if (!events.length) throw new IndeterminateError(PROVIDER, 'Nova Poshta returned no completed movement history');
  // The official tracker reverses its oldest-first path for display. Preserve
  // that order when any clock cannot be resolved.
  events.reverse();
  if (events.every(event => event.time)) events.sort((a, b) => Date.parse(b.time!) - Date.parse(a.time!));
  const unique = events.filter((event, index) => events.findIndex(other => JSON.stringify(other) === JSON.stringify(event)) === index);
  const latest = current ?? unique[0]!;
  const status = statusOf(latest.stage);
  // The schedule is the arrival at the recipient's branch or door; it has
  // passed once the parcel waits there, is collected or goes back.
  const settled = ['ready_for_pickup', 'delivered', 'returned'].includes(latest.stage ?? '');
  const expected = settled ? undefined : movementTime(payload.scheduled_delivery_date);
  const weight = typeof payload.total_weight === 'number' && Number.isFinite(payload.total_weight) && payload.total_weight > 0 ? payload.total_weight : undefined;
  const pickupPoint = latest.stage === 'ready_for_pickup' || latest.stage === 'delivered' ? points.get(latest) : undefined;
  // A return names the sender's country as the recipient's.
  const destination = isRecord(payload.recipient) && !unique.some(event => event.stage === 'returned')
    ? clean(payload.recipient.country_code, 8).toUpperCase() : '';
  const partner = partnerOf(payload);
  return { status, ...(latest.stage ? { current_stage: latest.stage, current_stage_source: latest.stage_source } : {}),
    last_status_text: latest.description, last_update: latest.time ?? null,
    ...(status === 'delivered' && latest.time ? { delivered_at: latest.time } : {}),
    ...(expected ? { expected_delivery: expected } : {}), ...(weight ? { weight_kg: weight } : {}),
    ...(dimensionsOf(payload.parcels) ?? {}), ...(pickupPoint ? { pickup_point: pickupPoint } : {}),
    ...(/^[A-Z]{2}$/.test(destination) ? { destination_country: destination } : {}), ...(partner ?? {}),
    timezone: 'Europe/Kyiv', events: unique.slice(0, 100) };
}
/** A single parcel's declared size; a multi-piece waybill has no one size. */
function dimensionsOf(parcels: unknown): { dimensions_text: string } | undefined {
  if (!Array.isArray(parcels) || parcels.length !== 1 || !isRecord(parcels[0])) return undefined;
  const sides = [parcels[0].length, parcels[0].width, parcels[0].height];
  return sides.every(side => typeof side === 'number' && Number.isFinite(side) && side > 0 && side < 10_000)
    ? { dimensions_text: `${sides.join(' × ')} cm` } : undefined;
}
function partnerOf(payload: Record<string, unknown>): { delivery_carrier: string; delivery_tracking_number: string } | undefined {
  for (const field of ['alternativeNumbersGWNew', 'alternativeNumbersGW']) {
    const references = payload[field];
    if (!Array.isArray(references)) continue;
    for (const reference of references) {
      if (!isRecord(reference) || typeof reference.name !== 'string' || !Object.hasOwn(PARTNERS, reference.name)) continue;
      const number = returnedTrackingNumber(reference.number);
      if (/^[A-Z0-9]{8,40}$/.test(number)) return { delivery_carrier: PARTNERS[reference.name]!, delivery_tracking_number: number };
    }
  }
  return undefined;
}
