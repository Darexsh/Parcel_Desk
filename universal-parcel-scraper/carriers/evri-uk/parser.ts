import { DateTime } from 'luxon';
import { IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';

// Evri's rail codes. A parcel's `trackingListV2` lists the rail it is on;
// a customer return runs 0, 2, 4. A parcel sent to a ParcelShop or locker
// waits on 4_SHOP or 4_LOCKER, which Evri's page calls awaiting collection,
// and 5_SHOP is its collection.
const STAGES = new Map<string, Stage>([
  ['0', 'registered'], ['1', 'registered'], ['2', 'in_transit'], ['3', 'in_transit'], ['4', 'returned'],
  ['4_COURIER', 'out_for_delivery'], ['5_COURIER', 'delivered'],
  ['4_SHOP', 'ready_for_pickup'], ['4_LOCKER', 'ready_for_pickup'], ['5_SHOP', 'delivered'],
]);

// Tracking points that their rail code files too broadly: a drop-off or
// collection is the acceptance, and a courier's failed visit stays on the
// out-for-delivery rail. The collection rails are never refined: a
// ParcelShop arrival there is the parcel waiting for its recipient.
const POINTS = new Map<string, Stage>([
  ['ACCEPTED_BY_HERMES', 'accepted'], ['ARRIVED_PARCELSHOP', 'accepted'], ['COLLECTED_BY_EVRI', 'accepted'],
  ['QUADIENT_LOCKER_DROPOFF', 'accepted'], ['PROCESSING_RETURN', 'returned'],
  ['COURIER_REATTEMPT_CUSTOMER_NOT_AVAILABLE', 'failed_attempt'], ['REDELIVER_WORKDAY_COURIER', 'failed_attempt'],
]);

function stageOf(stageCode: string, pointCode: string): Stage | undefined {
  const rail = STAGES.get(stageCode);
  if (!rail) return undefined;
  if (rail === 'ready_for_pickup' || stageCode === '5_SHOP') return rail;
  if (rail === 'out_for_delivery' && pointCode.startsWith('NOT_DELIVERED_')) return 'failed_attempt';
  return POINTS.get(pointCode) ?? rail;
}

/** A scan's provider code: its rail, a slash, then its tracking point (`4_SHOP/ARRIVED_PARCELSHOP`). */
function scanCode(stageCode: string, pointCode: string): string {
  return `${stageCode}/${pointCode}`;
}

/** The stage a scan's provider code gives it, as the parser stages the scan; undefined for a code without its rail. */
export function evriUkCodeStage(code: string): Stage | undefined {
  const slash = code.indexOf('/');
  return slash > 0 ? stageOf(code.slice(0, slash), code.slice(slash + 1)) : undefined;
}

const ZONE = 'Europe/London';

/** The wording of every delivery: Evri's own can name the recipient or a safe place. */
export const EVRI_UK_DELIVERED = 'Delivered';

export function normalizeEvriUkNumber(raw: string): string {
  const number = raw.toUpperCase().replace(/[\s-]/g, '');
  if (!/^[A-Z0-9]{16}$/.test(number)) throw new InvalidInputError('Evri UK', 'Evri UK requires a 16-character parcel barcode');
  return number;
}

export function evriUkTrackingUrl(raw: string): string {
  return `https://www.evri.com/track/parcel/${normalizeEvriUkNumber(raw)}/details`;
}

function scanTime(raw: unknown) {
  const text = cleanScalar(raw, 64);
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-](?:(?:0\d|1[0-3]):?[0-5]\d|14:?00))$/i.test(text)
    ? explicitOffsetTime(text) : null;
}

/** The window a scan announces, on the British clock its wording uses. */
function deliveryWindow(eta: unknown): string | null {
  if (!isRecord(eta)) return null;
  const start = scanTime(eta.start);
  const end = scanTime(eta.end);
  if (!start || !end || end.timestamp < start.timestamp) return null;
  const first = DateTime.fromMillis(start.timestamp, { zone: ZONE }).toFormat('yyyy-MM-dd HH:mm');
  const last = DateTime.fromMillis(end.timestamp, { zone: ZONE }).toFormat('yyyy-MM-dd HH:mm');
  return `${first}–${first.slice(0, 10) === last.slice(0, 10) ? last.slice(11) : last}`;
}

/**
 * The account Evri names as the sender. A consumer-to-consumer parcel can name
 * a private person, and a customer return names the retailer it goes back to.
 */
function senderName(parcel: Record<string, unknown>): string | null {
  if (parcel.c2cClient !== false || parcel.returnParcel !== false || !isRecord(parcel.sender)) return null;
  return cleanScalar(parcel.sender.displayName, 120) || null;
}

/** The redacted anonymous feed contains scans; ownership fields are unnecessary. */
export function parseEvriUk(payload: unknown, raw: string, expectedUrn?: string): CarrierResult {
  const number = normalizeEvriUkNumber(raw);
  if (!isRecord(payload) || !Array.isArray(payload.results) || !Array.isArray(payload.failures)) {
    throw new SchemaError('Evri UK', 'Evri UK returned invalid parcel history');
  }
  if (payload.failures.length || payload.results.length === 0) throw new IndeterminateError('Evri UK', 'Evri UK could not confirm parcel history');
  if (payload.results.length !== 1 || !isRecord(payload.results[0])) throw new SchemaError('Evri UK', 'Evri UK returned ambiguous parcel history');
  const parcel = payload.results[0];
  const identifiers = parcel.parcelIdentifiers;
  if (!Array.isArray(identifiers) || identifiers.length > 50
    || !identifiers.every(id => isRecord(id) && typeof id.type === 'string' && typeof id.value === 'string')) {
    throw new SchemaError('Evri UK', 'Evri UK did not return the requested parcel');
  }
  const barcodes = identifiers.filter(id => isRecord(id) && id.type === 'BARCODE');
  if (!barcodes.length || barcodes.some(id => !isRecord(id) || id.value !== number)
    || (expectedUrn !== undefined && parcel.uniqueId !== expectedUrn)) {
    throw new SchemaError('Evri UK', 'Evri UK did not return the requested parcel');
  }
  if (!Array.isArray(parcel.trackingEvents) || parcel.trackingEvents.length > 500) throw new SchemaError('Evri UK', 'Evri UK returned invalid tracking events');
  if (!parcel.trackingEvents.length) throw new IndeterminateError('Evri UK', 'Evri UK returned no parcel activity');
  const events: CarrierEvent[] = [];
  const windows = new Map<CarrierEvent, string>();
  const seen = new Set<string>();
  for (const rawEvent of parcel.trackingEvents) {
    if (!isRecord(rawEvent) || !isRecord(rawEvent.trackingPoint) || !isRecord(rawEvent.trackingStage)) {
      throw new SchemaError('Evri UK', 'Evri UK returned invalid tracking events');
    }
    const description = cleanScalar(rawEvent.trackingPoint.description);
    const code = cleanScalar(rawEvent.trackingPoint.trackingPointCode, 64);
    const stageCode = cleanScalar(rawEvent.trackingStage.trackingStageCode, 64);
    if (!description || !code || !stageCode) throw new SchemaError('Evri UK', 'Evri UK returned invalid tracking events');
    const stage = stageOf(stageCode, code);
    const privateDeliveryProse = /\b(?:delivered (?:to|by)|signed (?:for )?by)\b/i.test(description);
    const time = scanTime(rawEvent.dateTime);
    const clock = cleanScalar(rawEvent.dateTime, 64);
    const event: CarrierEvent = {
      ...(time ? { time: time.iso } : clock ? { provider_time_text: clock } : {}),
      description: stage === 'delivered' ? EVRI_UK_DELIVERED : privateDeliveryProse ? 'Delivery update' : description,
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
      provider_code: scanCode(stageCode, code),
      provider_stage_code: stageCode,
    };
    const identity = JSON.stringify([time?.iso ?? clock, code, description]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    events.push(event);
    const window = stage === 'out_for_delivery' ? deliveryWindow(rawEvent.eta) : null;
    if (window) windows.set(event, window);
  }
  if (!events.some(event => event.time)) throw new IndeterminateError('Evri UK', 'Evri UK returned no dated parcel activity');
  if (events.every(event => event.time)) events.sort((a, b) => Date.parse(b.time!) - Date.parse(a.time!));
  const newest = events[0]!;
  const stage = newest.stage as Stage | undefined;
  const sender = senderName(parcel);
  const service = isRecord(parcel.service) ? clean(parcel.service.serviceType, 80) : '';
  return {
    status: stage ? languageStageStatus(stage) : 'unknown', ...(stage ? { current_stage: stage } : {}),
    last_status_text: newest.description ?? null, last_update: newest.time ?? null,
    // Only the newest scan's window is current: a later scan replaces or withdraws it.
    expected_delivery: windows.get(newest) ?? null,
    ...(stage === 'delivered' && newest.time ? { delivered_at: newest.time } : {}),
    ...(sender ? { sender_name: sender } : {}),
    ...(service ? { service_name: service } : {}),
    events: events.slice(0, 100),
    tracking_url: evriUkTrackingUrl(number), tracking_source: 'structured-web-response',
  };
}
