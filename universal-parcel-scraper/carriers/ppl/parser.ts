import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { pplStage } from './status.js';

export const PPL = 'PPL';
const NOT_FOUND = 'service.TrackAndTrace.ShipmentNotFound';
const MAX_SCANS = 500;
const SETTLED: ReadonlySet<Stage> = new Set(['delivered', 'returned', 'ready_for_pickup']);

export function normalizePplNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!/^\d{11}$/.test(number)) throw new InvalidInputError(PPL, 'PPL requires an eleven-digit parcel number');
  return number;
}

/**
 * The tracking service's HTTP 400 problem reply. Only its shipment-not-found
 * detail, for the requested number when it names one, means PPL does not know
 * the parcel; any other rejection proves nothing.
 */
export function parsePplRejection(payload: unknown, rawNumber: string): never {
  const number = normalizePplNumber(rawNumber);
  if (!isRecord(payload)) throw new SchemaError(PPL, 'PPL returned an invalid error reply');
  if (payload.instance != null && payload.instance !== `/TrackAndTrace/${number}`) {
    throw new SchemaError(PPL, 'PPL answered for another parcel');
  }
  if (payload.detail === NOT_FOUND) throw new NotFoundError(PPL);
  throw new IndeterminateError(PPL, 'PPL rejected the tracking request');
}

interface Scan {
  event: CarrierEvent;
  timestamp: number | null;
  stage?: Stage;
}

function scan(row: unknown): Scan {
  if (!isRecord(row)) throw new SchemaError(PPL, 'PPL returned an invalid scan');
  const code = clean(row.code, 100);
  const description = clean(row.eventText, 500);
  if (!code || !description) throw new SchemaError(PPL, 'PPL returned a scan without its code or wording');
  // Scan clocks carry an explicit offset; one without stays unresolved text.
  const time = explicitOffsetTime(row.eventDate);
  const text = time ? '' : clean(row.eventDate, 64);
  const stage = pplStage(code);
  return { timestamp: time?.timestamp ?? null, ...(stage ? { stage } : {}), event: {
    description, provider_code: code, ...(time ? { time: time.iso } : text ? { provider_time_text: text } : {}),
    ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
  } };
}

/** The expected delivery day, only while the portal itself shows one and the parcel is still on its way. */
function estimatedDay(payload: Record<string, unknown>, stage: Stage | undefined, latest: CarrierEvent): string | null {
  if (payload.showDeliveryDate !== true || !stage || SETTLED.has(stage)) return null;
  const estimate = explicitOffsetTime(payload.expectedDeliveryDate);
  if (!estimate) return null;
  const day = estimate.iso.slice(0, 10);
  return typeof latest.time === 'string' && day < latest.time.slice(0, 10) ? null : day;
}

/**
 * The partner abroad that delivers the parcel, from the link to its tracker the reply gives. The
 * link must carry the partner's number, and its host and path must name one catalog carrier.
 */
function partnerHandoff(payload: Record<string, unknown>, number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const reference = normalizeTrackingNumber(clean(payload.externalShipmentId, 64)).toUpperCase();
  const link = clean(payload.partnerUrl, 500);
  if (!/^[A-Z0-9]{4,40}$/.test(reference) || reference === number || !link.toUpperCase().includes(reference)) return {};
  const partner = carrierIdFromPartner('', link);
  return partner && partner !== 'ppl' ? { delivery_carrier: partner, delivery_tracking_number: reference } : {};
}

export function parsePpl(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizePplNumber(rawNumber);
  if (!isRecord(payload)) throw new SchemaError(PPL);
  if (typeof payload.shipmentId !== 'string' || payload.shipmentId.trim() !== number) {
    throw new SchemaError(PPL, 'PPL returned a different parcel');
  }
  const rows = payload.events;
  if (!Array.isArray(rows) || rows.length > MAX_SCANS) throw new SchemaError(PPL, 'PPL returned an invalid scan list');
  if (!rows.length) throw new IndeterminateError(PPL, 'PPL returned no parcel history');
  // The service lists scans oldest first. Newest first, by instant when every
  // scan has one; otherwise in the service's order.
  const parsed = rows.map(scan).reverse();
  if (parsed.every(item => item.timestamp !== null)) parsed.sort((left, right) => right.timestamp! - left.timestamp!);
  const seen = new Set<string>();
  const scans = parsed.filter(item => {
    const key = JSON.stringify(item.event);
    return seen.has(key) ? false : (seen.add(key), true);
  });
  const events = scans.map(item => item.event);
  const latest = events[0]!;
  // Payment steps and codes the map does not know leave the last milestone in place.
  const staged = scans.filter(item => item.stage);
  const newest = staged[0]?.stage;
  // From a return scan on, the parcel travels back and cannot be delivered
  // again: a later delivery hands it to its sender.
  const stage: Stage | undefined = newest && staged.some(item => item.stage === 'returned') ? 'returned' : newest;
  const delivery = stage === 'delivered' ? staged.findIndex(item => item.stage === 'delivered') : -1;
  // A ParcelShop or ParcelBox holds the parcel, or held it until the delivery
  // that followed: the recipient collected it there. Its name only.
  const held = stage === 'ready_for_pickup' || (delivery >= 0 && staged[delivery + 1]?.stage === 'ready_for_pickup');
  const point = held && isRecord(payload.accessPoint) ? clean(payload.accessPoint.name, 160) : '';
  const deliveredAt = delivery >= 0 ? staged[delivery]!.event.time : undefined;
  const weight = payload.weight;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: latest.description ?? null,
    last_update: latest.time ?? null,
    expected_delivery: estimatedDay(payload, stage, latest),
    ...(typeof deliveredAt === 'string' ? { delivered_at: deliveredAt } : {}),
    ...(typeof weight === 'number' && Number.isFinite(weight) && weight > 0 && weight < 10_000 ? { weight_kg: weight } : {}),
    ...(point ? { pickup_point: point } : {}),
    ...partnerHandoff(payload, number),
    ...(events.length > 100 ? { history_truncated: true } : {}),
    events: events.slice(0, 100),
  };
}
