import { DateTime } from 'luxon';
import type { Stage } from '../../generated/catalog.js';
import { dpdParcelNumber } from '../../core/detection/dpd.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { classifyWording, languageStageStatus } from '../../core/status/index.js';
import { explicitOffsetTime, isoTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { dpdUkWording, withoutDriverName } from './wording.js';

export const PROVIDER = 'DPD UK';

export function normalizeDpdUkNumber(raw: string): string {
  const number = dpdParcelNumber(normalizeTrackingNumber(raw));
  if (!number) throw new InvalidInputError(PROVIDER, 'DPD UK requires a fourteen-digit parcel number, with or without its check character');
  return number;
}

// The public client displays spaced digits followed by the printed check
// character, which is a digit for about one parcel in four.
function parcelNumber(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const match = /^(\d{14})[0-9A-Z]?$/.exec(value.replace(/\s/g, '').toUpperCase());
  return match?.[1] ?? null;
}

/** Resolve one exact parcel, keeping its issued code opaque and lookup-local. */
export function parseDpdUkReference(payload: unknown, number: string): string {
  if (!isRecord(payload) || !Array.isArray(payload.data) || payload.data.length > 100) throw new SchemaError(PROVIDER);
  if (!payload.data.length) throw new IndeterminateError(PROVIDER, 'DPD UK returned no matching parcel');
  if (payload.data.length !== 1 || !isRecord(payload.data[0]) || parcelNumber(payload.data[0].parcelNumber) !== number) {
    throw new SchemaError(PROVIDER, 'DPD UK returned a different or ambiguous parcel');
  }
  const code = payload.data[0].parcelCode;
  if (typeof code !== 'string' || !/^[A-Za-z0-9*_-]{1,128}$/.test(code)) throw new SchemaError(PROVIDER, 'DPD UK returned an invalid parcel handle');
  return code;
}

export function isDpdUkReferenceAbsent(payload: unknown): boolean {
  return isRecord(payload) && !Object.hasOwn(payload, 'data') && isRecord(payload.error)
    && payload.error.statusCode === 404 && payload.error.error === 'Not Found'
    && payload.error.message === 'Your reference number could not be found';
}

export function validateDpdUkParcel(payload: unknown, number: string, code: string): Record<string, unknown> {
  if (!isRecord(payload) || !isRecord(payload.data) || parcelNumber(payload.data.parcelNumber) !== number
    || payload.data.parcelCode !== code) throw new SchemaError(PROVIDER, 'DPD UK returned a different parcel');
  return payload.data;
}

// DPD UK's own wording, and its partners' on parcels they deliver abroad.
// Delivery notices and safe-place instructions stay without a stage.
const VERIFIED_WORDING: Readonly<Record<string, Stage>> = {
  'your parcel has been delivered': 'delivered',
  'the parcel has been delivered': 'delivered',
  'your parcel is waiting for you at home (left in safe place)': 'delivered',
  'your parcel will be with you today': 'out_for_delivery',
  'the parcel is on the vehicle for delivery': 'out_for_delivery',
  'your parcel is at our depot': 'in_transit',
  'your parcel has arrived at our depot': 'in_transit',
  'your parcel is at our depot ready for delivery': 'in_transit',
  "your parcel has left our sortation facility and is on it's onwards journey": 'in_transit',
  'the parcel has arrived at the delivery depot': 'in_transit',
  'the parcel is in transit to its final destination': 'in_transit',
  'the parcel is undergoing customs clearance': 'customs',
  'duties and taxes paid': 'customs',
  'the parcel has now cleared customs': 'in_transit',
  "we have your parcel and it's on its way to our depot": 'in_transit',
  "we have your parcel and it's on its way to you": 'in_transit',
  'we have x-rayed your parcel as part of our normal security procedures': 'in_transit',
  "we've received your order details, but have not yet received your parcel": 'registered',
  "we've received your order details, and we're expecting your parcel shortly": 'registered',
  'your parcel has been dropped off at a dpd pickup shop': 'accepted',
};

// A parcel its sender hands in at a Pickup shop: the order record of a label that waits for it, and
// the drop-off. The account that booked such a label did not send it; on a return or donation label
// it is the recipient.
const HANDED_IN = new Set([
  "we've received your order details, and we're expecting your parcel shortly",
  'your parcel has been dropped off at a dpd pickup shop',
]);

// A round that missed the recipient, with the day of the next one.
const MISSED = /^we missed you\. your driver won't be back today but we'll be back [a-z]{3} \d{1,2} [a-z]+ with your parcel$/;

/**
 * A scan's or the current summary's stage. The summary appends the time of its scan, and the
 * round's notice the hour it gives for the delivery.
 */
export function classifyDpdUkWording(description: string) {
  const wording = dpdUkWording(withoutDriverName(description));
  // A sender's cancellation goes on to name the sender to contact.
  const stage = Object.hasOwn(VERIFIED_WORDING, wording) ? VERIFIED_WORDING[wording]
    : /^your delivery has been cancelled\b/.test(wording) ? 'exception' : MISSED.test(wording) ? 'failed_attempt' : undefined;
  return stage ? { stage, source: 'carrier_map' } : classifyWording(description);
}

function publicDescription(value: unknown): string {
  const text = withoutDriverName(clean(value, 1000));
  // A sender return is a shipment stage, rather than a recipient's identity.
  if (/\bdelivered (?:back )?to (?:the )?(?:sender|shipper)\b/i.test(text)) return text;
  return text.replace(/(\bdelivered)\s+(?:to\s+.+|and\s+signed\s+(?:for\s+)?by\s+.+|signed\s+(?:for\s+)?by\s+.+)$/i, '$1');
}

/**
 * DPD's group tracking service gives the scans of DPD's own network with
 * London's offset, at the wall clocks this feed shows. The sender's data
 * record, under the account's display name or `Sender`, comes from the same
 * UK system. Partner networks abroad and Pickup shops may keep another clock.
 */
function onUkClock(recorder: string, sender: string): boolean {
  return recorder === 'DPD' || recorder === 'Sender' || (sender !== '' && recorder === sender);
}

/** A UK wall clock's instant, unless the clocks skip it when summer time starts. */
function ukTime(local: string): string | undefined {
  const placed = isoTime(local, 'Europe/London');
  return placed?.iso.startsWith(local) ? placed.iso : undefined;
}

function clockFields(clock: string, uk: boolean): Partial<Pick<CarrierEvent, 'time' | 'local_time' | 'provider_time_text'>> {
  const shape = /^(\d{4}-\d{2}-\d{2})[ T]((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)(Z|[+-]\d{2}:?\d{2})?$/.exec(clock);
  if (!shape) return { provider_time_text: clock };
  const iso = `${shape[1]}T${shape[2]}${shape[3] ?? ''}`;
  if (!DateTime.fromISO(iso, { zone: 'UTC', setZone: true }).isValid) return { provider_time_text: clock };
  if (!shape[3]) {
    const local = `${shape[1]}T${shape[2]}`;
    const time = uk ? ukTime(local) : undefined;
    return time ? { time } : { local_time: local };
  }
  const offset = /[+-](\d{2}):?(\d{2})$/.exec(iso);
  if (offset && (Number(offset[1]) > 14 || Number(offset[2]) > 59 || (Number(offset[1]) === 14 && Number(offset[2]) !== 0))) {
    return { provider_time_text: clock };
  }
  const instant = explicitOffsetTime(iso);
  return instant ? { time: instant.iso } : { provider_time_text: clock };
}

/** Events have no identity field; the adapter reads them under the exact validated detail handle. */
export function parseDpdUkHistory(detailPayload: unknown, historyPayload: unknown, raw: string, code: string): CarrierResult {
  const number = normalizeDpdUkNumber(raw);
  const detail = validateDpdUkParcel(detailPayload, number, code);
  if (!isRecord(historyPayload) || !Array.isArray(historyPayload.data) || historyPayload.data.length > 1000) throw new SchemaError(PROVIDER);
  if (!historyPayload.data.length) throw new IndeterminateError(PROVIDER, 'DPD UK returned no parcel history');
  // The account that booked the parcel: the shop whose name the page shows.
  const sender = isRecord(detail.shipperDetails) ? clean(detail.shipperDetails.customerDisplayName, 120) : '';
  // The official page renders these rows newest first. Do not reorder uncertain clocks.
  const events: CarrierEvent[] = historyPayload.data.map(row => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER);
    if ((row.parcelNumber !== undefined && parcelNumber(row.parcelNumber) !== number)
      || (row.parcelCode !== undefined && row.parcelCode !== code)) throw new SchemaError(PROVIDER, 'DPD UK returned a different scan identity');
    const description = publicDescription(row.eventText);
    const clock = clean(row.eventDate, 64);
    if (!description || !clock || typeof row.eventDate !== 'string' || row.eventDate.length > 64) throw new SchemaError(PROVIDER, 'DPD UK returned an incomplete scan');
    const classification = classifyDpdUkWording(description);
    // `eventLocation` names the network or the sender that recorded the scan, not a place.
    return { description, ...clockFields(clock, onUkClock(clean(row.eventLocation, 120), sender)),
      ...(classification.source !== 'none' ? { stage: classification.stage, stage_source: classification.source } : {}) };
  });
  const seen = new Set<string>();
  const retained = events.filter(event => {
    const key = JSON.stringify(event);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0, 100);
  const latest = retained[0]!;
  // A parcel handed in by its sender names none: null drops the account an earlier check named.
  const handedIn = events.some(event => HANDED_IN.has(dpdUkWording(event.description!)));
  const summary = publicDescription(detail.trackingStatusCurrent);
  const summaryClassification = classifyDpdUkWording(summary);
  const current = summary ? summaryClassification : classifyDpdUkWording(latest.description!);
  return { status: current.source !== 'none' ? languageStageStatus(current.stage) : 'unknown',
    ...(current.source !== 'none' ? { current_stage: current.stage, current_stage_source: current.source } : {}),
    last_status_text: summary || latest.description, last_update: latest.time ?? null,
    ...(latest.local_time ? { last_update_local: latest.local_time } : {}),
    ...(handedIn ? { sender_name: null } : sender ? { sender_name: sender } : {}),
    ...(current.stage === 'delivered' && latest.stage === 'delivered' && latest.time ? { delivered_at: latest.time } : {}), events: retained };
}
