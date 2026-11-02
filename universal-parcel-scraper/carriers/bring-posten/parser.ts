import { DateTime } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { calendarDay, explicitOffsetTime } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { bringStatus, bringWording } from './status.js';

/**
 * A parcel or consignment number, or an S10, Norwegian or from abroad. The
 * tracker also takes a parcel's SSCC with its 00 application identifier and
 * answers for the 18-digit parcel number, which is what gets asked.
 */
export function normalizeBringNumber(raw: string): string {
  const typed = normalizeTrackingNumber(raw);
  const number = /^00\d{18}$/.test(typed) ? typed.slice(2) : typed;
  if (!/^\d{17,18}$/.test(number) && !(/^[A-Z]{2}\d{9}[A-Z]{2}$/.test(number) && isValidS10TrackingNumber(number))) {
    throw new InvalidInputError('Bring', 'Bring requires a parcel or consignment tracking number');
  }
  return number;
}

function clock(value: unknown): Pick<CarrierEvent, 'time'> & { local_time?: string; provider_time_text?: string } {
  if (value != null && typeof value !== 'string') throw new SchemaError('Bring', 'Invalid event clock');
  const raw = clean(value, 64);
  const base = '^\\d{4}-\\d{2}-\\d{2}T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d{1,9})?';
  if (new RegExp(`${base}(?:Z|[+-](?:0\\d|1[0-3]):?[0-5]\\d|[+-]14:?00)$`).test(raw)) {
    const time = explicitOffsetTime(raw);
    if (time) return { time: time.iso };
  }
  if (new RegExp(`${base}$`).test(raw)) {
    const wall = DateTime.fromISO(raw, { zone: 'UTC' });
    if (wall.isValid) return { local_time: wall.toISO({ includeOffset: false }) };
  }
  return raw ? { provider_time_text: raw } : {};
}

/** Change and notification notices can sit above the scan the portal summarizes. */
const NOTICES = new Set(['DELIVERY_CHANGED', 'NOTIFICATION_SENT']);
const SUMMARY_KEYS = ['status', 'dateIso', 'lmEventCode', 'city'];

/**
 * The one piece the number names: the single piece of a consignment, or the
 * piece whose own number was asked within a larger one. A consignment number
 * names no piece of a larger consignment.
 */
function selectParcel(consignment: Record<string, unknown>, pieces: unknown[], number: string): unknown {
  if (!isRecord(consignment.domain) || typeof consignment.domain.isMultiParcel !== 'boolean') {
    throw new IndeterminateError('Bring', 'No complete single-piece consignment');
  }
  if (consignment.numberOfConsignmentItems === 1 && pieces.length === 1 && !consignment.domain.isMultiParcel) return pieces[0];
  // Mail from abroad is its own consignment: the reply counts no items and names the piece by the same number.
  if (consignment.numberOfConsignmentItems === 0 && pieces.length === 1 && !consignment.domain.isMultiParcel
    && consignment.consignmentId === number && isRecord(pieces[0]) && pieces[0].packageNumber === number) return pieces[0];
  const named = pieces.filter(piece => isRecord(piece) && piece.packageNumber === number);
  if (consignment.consignmentId === number || named.length !== 1 || pieces.length < 2
    || consignment.numberOfConsignmentItems !== pieces.length) throw new IndeterminateError('Bring', 'No complete single-piece consignment');
  return named[0];
}

function text(value: unknown, max: number): string { return typeof value === 'string' ? clean(value, max) : ''; }

/** The day the portal estimates, once it says the estimate is available. */
function estimatedDay(domain: Record<string, unknown>): string | null {
  const eta = domain.eta;
  if (!isRecord(eta) || eta.status !== 'AVAILABLE' || typeof eta.dateOfEstimatedDeliveryIso !== 'string') return null;
  const day = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(eta.dateOfEstimatedDeliveryIso);
  return day ? calendarDay(Number(day[1]), Number(day[2]), Number(day[3])) : null;
}

/**
 * Whether the parcel was collected at the pickup point the portal names: the
 * delivery, and the movement before it that made the parcel ready for pickup,
 * were scanned at that point's unit. Notices prove no movement.
 */
function collectedAt(rows: Record<string, unknown>[], pickupUnit: unknown): boolean {
  const unit = cleanScalar(pickupUnit, 32);
  const moves = rows.filter(row => bringStatus(String(row.status), text(row.lmCauseCode, 8)));
  const index = moves.findIndex(row => row.status !== 'DELIVERED');
  return Boolean(unit) && index > 0 && moves[index]!.status === 'READY_FOR_PICKUP'
    && moves.slice(0, index + 1).every(row => cleanScalar(row.unitId, 32) === unit);
}

export function parseBring(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeBringNumber(rawNumber);
  if (!isRecord(payload)) throw new SchemaError('Bring');
  if (payload.error != null || payload.errorState != null) throw new IndeterminateError('Bring', 'Consumer tracking returned no bound history');
  const consignment = payload.consignmentWithDomainAsync;
  if (!isRecord(consignment) || !Array.isArray(consignment.packageSet)) throw new SchemaError('Bring');
  if (!consignment.packageSet.length) throw new IndeterminateError('Bring', 'No complete single-piece consignment');
  const parcel = selectParcel(consignment, consignment.packageSet, number);
  if (!isRecord(parcel) || typeof parcel.brand !== 'string' || !['POSTEN', 'BRING'].includes(parcel.brand)
    || typeof consignment.consignmentId !== 'string' || typeof parcel.packageNumber !== 'string'
    || (consignment.consignmentId !== number && parcel.packageNumber !== number)) throw new SchemaError('Bring', 'Different consignment or parcel');
  if (!isRecord(parcel.domain) || !isRecord(parcel.domain.latestSignificantEvent)
    || !Array.isArray(parcel.eventSet) || parcel.eventSet.length > 500) throw new SchemaError('Bring');
  const summary = parcel.domain.latestSignificantEvent;
  const significant = parcel.eventSet.filter((row): row is Record<string, unknown> => isRecord(row) && row.insignificant === false);
  const selected = [significant[0], significant.find(row => !NOTICES.has(String(row.status)))];
  if (summary.insignificant !== false
    || !selected.some(row => row && SUMMARY_KEYS.every(key => summary[key] === row[key]))) {
    throw new IndeterminateError('Bring', 'Latest significant scan does not match the public summary');
  }
  // The website's simplified EN_ROUTE also covers dispatches and exceptions.
  // A terminal summary must still agree with the exact terminal event code.
  const simple = parcel.domain.currentStatus;
  const terminal = summary.status === 'DELIVERED' ? 'DELIVERED' : summary.status === 'DELIVERED_SENDER' ? 'DELIVERED_RETURN' : null;
  if (typeof simple !== 'string' || (terminal && simple !== terminal)
    || (!terminal && ['DELIVERED', 'DELIVERED_RETURN'].includes(simple))) throw new IndeterminateError('Bring', 'Inconsistent terminal summary');
  const events: CarrierEvent[] = [];
  for (const row of parcel.eventSet) {
    if (!isRecord(row) || typeof row.status !== 'string' || !/^[A-Z0-9_]{1,64}$/.test(row.status)
      || typeof row.insignificant !== 'boolean' || (row.city != null && typeof row.city !== 'string')) throw new SchemaError('Bring', 'Invalid parcel scan');
    const cause = text(row.lmCauseCode, 8);
    const mapped = bringStatus(row.status, cause);
    events.push({ ...clock(row.dateIso), provider_code: row.status, description: bringWording(row.status, cause),
      location: clean(row.city, 200), ...(mapped ? { stage: mapped.stage } : {}) });
  }
  const currentCause = text(summary.lmCauseCode, 8);
  const current = bringStatus(String(summary.status), currentCause);
  const currentClock = clock(summary.dateIso);
  let returning = false;
  for (const event of [...events].reverse()) {
    if (event.provider_code === 'RETURN' || event.provider_code === 'DELIVERED_SENDER') returning = true;
    if (returning) event.provider_leg = 'return';
  }
  const seen = new Set<string>();
  const unique = events.filter(event => { const key = JSON.stringify(event); if (seen.has(key)) return false; seen.add(key); return true; });
  const weight = parcel.weightInKgs;
  const dimensions = [parcel.lengthInCm, parcel.widthInCm, parcel.heightInCm];
  // The portal names the sender, usually the shop; registered letters carry none.
  const sender = text(consignment.senderName, 200) || text(parcel.senderName, 200);
  const pickupInfo = isRecord(parcel.domain.deliveryType) && isRecord(parcel.domain.deliveryType.pickupPointInfo)
    ? parcel.domain.deliveryType.pickupPointInfo : {};
  const atPickupPoint = current?.stage === 'ready_for_pickup'
    || (current?.stage === 'delivered' && collectedAt(parcel.eventSet.filter(isRecord), parcel.expectedPickupUnitId));
  const pickup = atPickupPoint ? text(parcel.expectedPickupUnitName, 200) || text(pickupInfo.expectedPickupUnitName, 200) : '';
  const country = isRecord(consignment.recipientAddress) ? consignment.recipientAddress.countryCode : undefined;
  const service = text(parcel.productName, 80);
  const active = current && ['pending', 'in_transit', 'out_for_delivery'].includes(current.status) && current.stage !== 'ready_for_pickup';
  return { status: current?.status ?? 'unknown', ...(current ? { current_stage: current.stage } : {}),
    last_status_text: bringWording(String(summary.status), currentCause), last_update: currentClock.time ?? null,
    last_update_local: currentClock.local_time ?? null, expected_delivery: active ? estimatedDay(parcel.domain) : null,
    ...(current?.status === 'delivered' && currentClock.time ? { delivered_at: currentClock.time } : {}),
    ...(sender ? { sender_name: sender } : {}), ...(pickup ? { pickup_point: pickup } : {}), ...(service ? { service_name: service } : {}),
    ...(typeof country === 'string' && /^[A-Z]{2}$/.test(country) ? { destination_country: country } : {}),
    ...(normalizeTrackingNumber(rawNumber) !== number ? { canonical_tracking_number: number } : {}),
    ...(typeof weight === 'number' && Number.isFinite(weight) && weight > 0 && weight <= 100_000 ? { weight_kg: weight } : {}),
    ...(dimensions.every(value => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 100_000)
      ? { dimensions_text: `${dimensions.join(' × ')} cm` } : {}), events: unique.slice(0, 100) };
}
