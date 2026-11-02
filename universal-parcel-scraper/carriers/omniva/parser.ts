import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { lastMovement } from '../../core/result/pickup.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { isOmnivaNotice, omnivaEventStage, omnivaState, RETURN_CANCELLED, RETURN_STARTS } from './status.js';

export const PROVIDER = 'Omniva';
// A long history is a few tens of kilobytes.
export const OMNIVA_MAX_BYTES = 512_000;

const MAX_ROWS = 500;
const MAX_EVENTS = 100;
const CODE = /^[A-Z][A-Z0-9_]{1,79}$/;

/**
 * Omniva tracks UPU S10 items, its own and those from other posts, and its
 * parcel ids: JJEE and seventeen digits, or JJEE, three letters and eleven
 * digits. Its Lithuanian tracker also answered ZA and eight digits.
 */
export function normalizeOmnivaNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (/^JJEE(?:\d{17}|[A-Z]{3}\d{11})$/.test(number) || /^ZA\d{8}$/.test(number) || isValidS10TrackingNumber(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Omniva tracks S10 item codes and its JJEE parcel ids');
}

// Omniva's own and its partners' sites, by their service point type. Other
// types are a sender's or recipient's address or a home letterbox.
const PLACES = new Set(['PARCEL_MACHINE', 'POST_OFFICE', 'POST_STATION', 'PICK_UP_POINT', 'PARTNER_PICK_UP_POINT', 'PARCEL_BOX',
  'DISTRIBUTION_POINT', 'LOGISTIC_CENTER', 'WORKSTATION', 'IMPC', 'WAREHOUSE', 'SUPPORT_POINT']);
// The sites a recipient collects an item from.
const PICKUP = new Set(['PARCEL_MACHINE', 'POST_OFFICE', 'POST_STATION', 'PICK_UP_POINT', 'PARTNER_PICK_UP_POINT', 'PARCEL_BOX']);

interface Place { readonly name: string; readonly type: string }

/** A site's English name, else its own, as the trackers show it. Postcodes are left out. */
function placeOf(value: unknown): Place | null {
  if (!isRecord(value)) return null;
  const type = clean(value.servicePointTypeCode, 64);
  if (!PLACES.has(type)) return null;
  const english = isRecord(value.translations) && isRecord(value.translations.en) ? clean(value.translations.en.name, 160) : '';
  const name = english || clean(value.locationName, 160);
  // A sorting workstation can carry an internal code, such as IPS_GENERAL, for a name.
  return name && !/^[A-Z0-9]+(?:_[A-Z0-9]+)+$/.test(name) ? { name, type } : null;
}

interface Scan { readonly event: CarrierEvent; readonly at: number; readonly code: string; readonly place: Place | null; readonly index: number }

// The UPU event Omniva writes for the sending post once a cross-border item
// waits for collection, without a site and worded for a post office, and
// Omniva's own scans of an item arriving at the site it is collected from.
const UPU_AWAITING = 'TRT_SHIPMENT_EDH';
const AWAITING = new Set(['TRT_SHIPMENT_STORED_IN_PM', 'TRT_SHIPMENT_ARRIVED_TO_FINAL_PO']);
// It followed Omniva's own scan by a tenth of a second; within minutes it still repeats it.
const UPU_COPY_MS = 15 * 60_000;

/**
 * The tracking service's reply for one number: its scans in no set order,
 * each with an event code, English wording and a UTC clock, and the item's
 * state. A number it does not know comes back as an empty object.
 */
export function parseOmniva(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeOmnivaNumber(rawNumber);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Omniva did not return a shipment');
  if (!Object.keys(payload).length) throw new NotFoundError(PROVIDER);
  if (typeof payload.shipmentBarcode !== 'string' || payload.shipmentBarcode.trim().toUpperCase() !== number) {
    throw new SchemaError(PROVIDER, 'Omniva answered for a different shipment');
  }
  const rows = payload.events ?? [];
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Omniva returned an invalid shipment history');
  const stateCode = clean(payload.currentStateCode, 80);
  if (stateCode && !CODE.test(stateCode)) throw new SchemaError(PROVIDER, 'Omniva returned an invalid shipment state');

  const read: Scan[] = [];
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Omniva returned an invalid scan');
    const code = clean(row.eventCode, 80);
    const at = explicitOffsetTime(row.eventDate);
    if (!CODE.test(code) || !at) throw new SchemaError(PROVIDER, 'Omniva returned a scan without a code or clock');
    const place = placeOf(row.location);
    const event: CarrierEvent = { time: at.iso, description: clean(row.eventName, 300) || code, provider_code: code,
      ...(place ? { location: place.name } : {}) };
    const identity = JSON.stringify(event);
    if (seen.has(identity)) return;
    seen.add(identity);
    read.push({ event, at: at.timestamp, code, place, index });
  });
  // Omniva's own scan of the site stands for the UPU event that repeats it.
  const scans = read.filter(scan => scan.code !== UPU_AWAITING || scan.place || !read.some(own =>
    AWAITING.has(own.code) && own.place && Math.abs(scan.at - own.at) <= UPU_COPY_MS));
  // Newest first; scans at the same instant follow the reply's order, reversed.
  scans.sort((left, right) => right.at - left.at || right.index - left.index);

  // Oldest first: a notice keeps the stage of the scan before it, and a
  // delivery on a return reaches the sender. The reply flags a return even
  // when its history no longer holds the scan that started it.
  const returnFlag = payload.returningShipment === true;
  let returning = returnFlag && !scans.some(scan => RETURN_STARTS.has(scan.code));
  let previous: Stage | undefined;
  for (const scan of [...scans].reverse()) {
    if (RETURN_STARTS.has(scan.code)) returning = true;
    else if (scan.code === RETURN_CANCELLED) returning = false;
    if (isOmnivaNotice(scan.code)) {
      if (previous) Object.assign(scan.event, { stage: previous, stage_source: 'none' });
      continue;
    }
    const mapped = omnivaEventStage(scan.code);
    const stage = mapped === 'delivered' && returning ? 'returned' : mapped;
    if (stage) Object.assign(scan.event, { stage, stage_source: 'carrier_map' });
    previous = stage;
  }
  const events = scans.map(scan => scan.event);

  const state = stateCode ? omnivaState(stateCode) : undefined;
  // The trackers headline the state. A delivered state on a return is the sender's collection.
  const stateStage = state?.stage === 'delivered' && returnFlag ? 'returned' : state?.stage;
  const decider = scans.find(scan => !isOmnivaNotice(scan.code)) ?? scans[0];
  if (!decider && !stateCode) throw new IndeterminateError(PROVIDER, 'Omniva returned a shipment without a state or scans');
  const stage = (decider?.event.stage as Stage | undefined) ?? stateStage;
  const fromState = Boolean(stage) && !decider?.event.stage;

  // The site an item waits at is its pickup point; a delivered item was
  // collected there when it was delivered at one, or waited there last. The
  // recipient's chosen site stands in while the scan names none. A return's
  // site is the sender's.
  const deliveryPlace = placeOf(payload.deliveryLocation);
  let point = '';
  if (!returning && !returnFlag) {
    if (stage === 'ready_for_pickup') {
      point = (decider?.place && PICKUP.has(decider.place.type) ? decider.place : deliveryPlace && PICKUP.has(deliveryPlace.type) ? deliveryPlace : null)?.name ?? '';
    } else if (stage === 'delivered' && decider) {
      const earlier = scans.slice(scans.indexOf(decider) + 1);
      const waited = lastMovement(earlier.map(scan => scan.event)) === 'ready_for_pickup'
        ? earlier.find(scan => scan.event.stage === 'ready_for_pickup' && !isOmnivaNotice(scan.code))?.place : null;
      point = [decider.place, waited].find(place => place && PICKUP.has(place.type))?.name ?? '';
    }
  }
  const destination = isRecord(payload.deliveryLocation) ? countryCode(payload.deliveryLocation.countryCode) : null;
  const delivered = stage === 'delivered' && decider?.event.stage === 'delivered' ? decider.event.time : undefined;
  // An old item's history keeps only its delivery.
  const trimmed = events.length > 0 && events.every(event => event.stage === 'delivered' || event.stage === 'returned');

  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: fromState ? 'carrier_map' : decider!.event.stage_source } : {}),
    last_status_text: decider?.event.description ?? state?.wording ?? stateCode,
    ...(events.length ? {} : { provider_code: stateCode, summary_only: true }),
    last_update: events[0]?.time ?? null,
    expected_delivery: null,
    ...(delivered ? { delivered_at: delivered } : {}),
    ...(point ? { pickup_point: point } : {}),
    ...(destination ? { destination_country: destination } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS || trimmed ? { history_truncated: true } : {}),
  };
}
