import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { calendarDay, canadaProvinceTimeZone, countryCode, firstOccurrence, usStateTimeZone } from '../../core/time/index.js';
import { cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { abfStage, abfWordingStage } from './status.js';

export const PROVIDER = 'ABF Freight';
// A shipment's reply is a few kilobytes; one found by a reference as well is a few more.
export const ABF_MAX_BYTES = 256 * 1024;

// ABF issues nine-digit PRO numbers.
const NUMBER = /^\d{9}$/;
// A clock as the service sends it: a wall time, with or without an offset.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})?$/;
const CENTRAL = 'America/Chicago';
// States whose ABF service centers can keep different clocks. A center's
// offset from Central tells them apart.
const SPLIT_STATE_ZONES: Readonly<Record<string, readonly string[]>> = {
  AK: ['America/Anchorage', 'America/Adak'],
  FL: ['America/New_York', 'America/Chicago'],
  ID: ['America/Boise', 'America/Los_Angeles'],
  IN: ['America/Indiana/Indianapolis', 'America/Chicago'],
  KS: ['America/Chicago', 'America/Denver'],
  KY: ['America/New_York', 'America/Chicago'],
  MI: ['America/Detroit', 'America/Menominee'],
  ND: ['America/Chicago', 'America/Denver'],
  NE: ['America/Chicago', 'America/Denver'],
  NV: ['America/Los_Angeles', 'America/Denver'],
  OR: ['America/Los_Angeles', 'America/Boise'],
  SD: ['America/Chicago', 'America/Denver'],
  TN: ['America/Chicago', 'America/New_York'],
  TX: ['America/Chicago', 'America/Denver'],
};
// The progress rail's steps the page shows as done or under way.
const REACHED = new Set(['complete', 'inProgress']);
// The pickup kinds the page shows with a date it happened on.
const PICKUPS: Readonly<Record<string, string>> = { pickedUp: 'Picked Up', pickupStopCompleted: 'Pickup Stop Completed' };
// The pickup kinds of a shipment still to be picked up.
const PICKUP_PENDING = new Set(['pickupScheduled', 'pickupEta']);
// The delivery date kinds the page shows as still to come.
const ESTIMATES = new Set(['projected', 'appointment']);
// ArcBest's household moving service, which its page sends to upack.com.
const UPACK = 'UpackResidential';
const POUNDS_TO_KG = 0.453_592_37;
const MAX_ITEMS = 50;
const MAX_STEPS = 20;

/** An ABF PRO number; anything else is a number ArcBest's tracker is not asked for. */
export function normalizeAbfNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'ABF Freight PRO numbers are nine digits');
  return number;
}

function invalid(message = 'ABF Freight returned an unexpected reply'): never {
  throw new SchemaError(PROVIDER, message);
}

/** An optional record: absent is empty, anything but an object is a changed reply. */
function record(row: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = row[key];
  if (value === null || value === undefined) return {};
  if (!isRecord(value)) invalid(`ABF Freight returned an invalid ${key}`);
  return value;
}

/** An optional text field; an object, array or other value is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' && typeof value !== 'number') invalid(`ABF Freight returned an invalid ${key}`);
  return cleanScalar(value, maxLength);
}

/**
 * A clock's wall time. The service labels every clock with Central time's
 * offset, whatever the place keeps: a delivery it words as 9:45 AM MDT comes
 * as 09:45-05:00. The offset is dropped; midnight is a clock the page hides,
 * so only the day counts.
 */
function wallOf(value: string): { wall: string; day: string; dateOnly: boolean } | null {
  const match = CLOCK.exec(value);
  if (!match) return null;
  const [, year, month, date, hour, minute, second] = match;
  const day = calendarDay(Number(year), Number(month), Number(date));
  // Luxon accepts hour 24, so the clock's fields are checked here.
  if (!day || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
  return { wall: `${day}T${hour}:${minute}:${second}`, day, dateOnly: hour === '00' && minute === '00' && second === '00' };
}

interface ServiceCenter {
  readonly place: string;
  readonly country: string | null;
  readonly zones: readonly string[];
  /** The center's clock, in hours from Central time's, when the reply gives it. */
  readonly fromCentral: number | null;
}

/**
 * The service center at one end: its town, state or province and country, and
 * its offset from Central. Its street, postcode, position and contacts are never read.
 */
function centerOf(centers: Record<string, unknown>, role: string): ServiceCenter | null {
  const center = record(centers, role);
  const address = record(center, 'physicalAddress');
  const city = text(address, 'city', 80);
  const state = text(address, 'stateProvince', 8).toUpperCase();
  const country = countryCode(text(address, 'country', 40) || undefined);
  const offset = center.utcOffset;
  if (offset !== null && offset !== undefined && (typeof offset !== 'number' || !Number.isFinite(offset) || Math.abs(offset) > 12)) {
    invalid('ABF Freight returned an invalid service center offset');
  }
  // A part holding a digit could be a street or a postcode, so it is left out.
  const parts = [city, state, country && country !== 'US' ? country : ''].filter((part) => part && !/\d/.test(part));
  const zone = country === 'US' ? usStateTimeZone(state) : country === 'CA' ? canadaProvinceTimeZone(state) : null;
  const zones = country === 'US' && Object.hasOwn(SPLIT_STATE_ZONES, state) ? SPLIT_STATE_ZONES[state]! : zone ? [zone] : [];
  if (!parts.length && !zones.length) return null;
  return { place: city && !/\d/.test(city) ? parts.join(', ') : '', country, zones,
    fromCentral: typeof offset === 'number' ? offset : null };
}

/** A zone's offset from UTC, in minutes, at a wall time there. */
function offsetAt(wall: string, zone: string): number {
  return firstOccurrence(DateTime.fromISO(wall, { zone })).offset;
}

/** The center's zone at a wall time: the one candidate whose offset from Central's is the center's. */
function zoneAt(center: ServiceCenter | null, wall: string): string | null {
  if (!center?.zones.length) return null;
  const { zones, fromCentral } = center;
  if (fromCentral === null) return zones.length === 1 ? zones[0]! : null;
  const central = offsetAt(wall, CENTRAL);
  const matching = zones.filter((zone) => offsetAt(wall, zone) - central === fromCentral * 60);
  return matching.length === 1 ? matching[0]! : null;
}

function instantIn(wall: string, zone: string): string {
  return firstOccurrence(DateTime.fromISO(wall, { zone })).toISO({ suppressMilliseconds: true }) ?? invalid('ABF Freight returned an invalid clock');
}

type Clock = { time: string } | { local_time: string };

/**
 * A delivery's clock is the delivering service center's, as ABF's own wording
 * of it shows, so it is an instant once that center's zone is known.
 */
function deliveryClock(value: string, center: ServiceCenter | null): Clock | null {
  const wall = wallOf(value);
  if (!wall) return null;
  if (wall.dateOnly) return { local_time: wall.day };
  const zone = zoneAt(center, wall.wall);
  return zone ? { time: instantIn(wall.wall, zone) } : { local_time: wall.wall };
}

/**
 * No reply shows whose clock a pickup is on, the origin's or Central's. It is
 * an instant only where both read the same, at an origin keeping Central time.
 */
function pickupClock(value: string, center: ServiceCenter | null): Clock | null {
  const wall = wallOf(value);
  if (!wall) return null;
  if (wall.dateOnly) return { local_time: wall.day };
  const zone = zoneAt(center, wall.wall);
  return zone && offsetAt(wall.wall, zone) === offsetAt(wall.wall, CENTRAL)
    ? { time: instantIn(wall.wall, CENTRAL) } : { local_time: wall.wall };
}

function eventOf(clock: Clock, description: string, center: ServiceCenter | null, stage: Stage): CarrierEvent {
  return { ...clock, description, ...(center?.place ? { location: center.place } : {}), stage, stage_source: 'carrier_map' };
}

/** The rail's furthest step the page shows as done or under way. */
function railStage(meta: Record<string, unknown>): Stage | undefined {
  const steps = meta.progress ?? [];
  if (!Array.isArray(steps) || steps.length > MAX_STEPS) invalid('ABF Freight returned an invalid progress rail');
  let reached: Stage | undefined;
  for (const step of steps) {
    if (!isRecord(step)) invalid('ABF Freight returned an invalid progress step');
    const stage = REACHED.has(text(step, 'completion', 20)) ? abfWordingStage(text(step, 'title', 80)) : undefined;
    if (stage) reached = stage;
  }
  return reached;
}

/** The total weight in kilograms, from pounds or kilograms. */
function weightOf(details: Record<string, unknown>): number | null {
  const weight = record(details, 'totalWeight');
  const value = weight.value;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const unit = text(weight, 'unit', 8).toLowerCase();
  const kg = unit === 'lb' || unit === 'lbs' ? value * POUNDS_TO_KG : unit === 'kg' ? value : null;
  return kg === null ? null : Math.round(kg * 1000) / 1000;
}

/** The shipment the reply has under its own PRO number: the page shows the last one. */
function shipmentOf(payload: unknown, number: string): Record<string, unknown> {
  if (!isRecord(payload)) invalid();
  const keys = Object.keys(payload);
  if (keys.length !== 1 || keys[0] !== number) invalid('ABF Freight answered for another number');
  const items = payload[number];
  if (!Array.isArray(items) || items.length > MAX_ITEMS) invalid();
  if (!items.length) throw new NotFoundError(PROVIDER);
  // The tracker also finds shipments by a reference; only the PRO's own item counts.
  const own = items.filter((item: unknown): item is Record<string, unknown> => {
    if (!isRecord(item)) invalid('ABF Freight returned an invalid shipment');
    if (text(item, 'id', 32) !== number) return false;
    const pro = text(record(record(item, 'data'), 'identifiers'), 'pronumber', 32);
    if (pro && pro !== number) invalid('ABF Freight returned a shipment with another PRO number');
    return true;
  });
  const item = own.at(-1);
  if (!item) throw new IndeterminateError(PROVIDER, 'ABF Freight found the number only as another shipment\'s reference');
  return item;
}

/**
 * The reply of `GET /api/nlo/track?ref={PRO}`: the number asked, with the
 * shipments it finds, here the shipment of that PRO. Without an account the
 * reply is a summary: the current status, the progress rail, the pickup and
 * delivery dates and the two ABF service centers. The status details name who
 * signed for a delivery; they, the parties, appointment and contacts, the
 * service centers' addresses, references and documents are never read.
 */
export function parseAbfFreight(payload: unknown, raw: string): CarrierResult {
  const number = normalizeAbfNumber(raw);
  const item = shipmentOf(payload, number);
  const data = record(item, 'data');
  const details = record(data, 'details');
  if (text(data, 'solution', 40) === UPACK || text(details, 'solution', 40) === UPACK) {
    throw new IndeterminateError(PROVIDER, 'ABF Freight tracks this U-Pack shipment on upack.com');
  }
  const transit = record(data, 'transitStatus');
  const centers = record(transit, 'serviceCenters');
  const origin = centerOf(centers, 'shipper');
  const destination = centerOf(centers, 'consignee');
  const status = text(transit, 'status', 120);
  const dateKind = text(transit, 'effectiveDateType', 20);
  const pickupKind = text(transit, 'effectivePickupType', 30);

  const events: CarrierEvent[] = [];
  if (dateKind === 'final') {
    const clock = deliveryClock(text(transit, 'effectiveDate', 40) || text(transit, 'delivered', 40), destination);
    if (clock) events.push(eventOf(clock, 'Delivered', destination, 'delivered'));
  }
  if (Object.hasOwn(PICKUPS, pickupKind)) {
    const clock = pickupClock(text(transit, 'effectivePickupDate', 40), origin);
    if (clock) events.push(eventOf(clock, PICKUPS[pickupKind]!, origin, 'accepted'));
  }

  const worded = status ? abfStage(status) : null;
  const fallback: Stage | undefined = railStage(record(item, 'meta'))
    ?? (dateKind === 'final' ? 'delivered' : Object.hasOwn(PICKUPS, pickupKind) ? 'accepted'
      : PICKUP_PENDING.has(pickupKind) ? 'registered' : undefined);
  const decided: ClassifiedWording | null = worded ?? (fallback ? { stage: fallback, source: 'carrier_map' } : null);
  if (!status && !decided && !events.length) throw new NoHistoryError(PROVIDER);
  const stage = decided?.stage;

  // The status has no clock of its own; a pickup or delivery dates it when it is that milestone.
  const current = events.find((event) => event.stage === stage);
  const delivered = stage === 'delivered' ? events.find((event) => event.stage === 'delivered') : undefined;
  const estimate = ESTIMATES.has(dateKind) && stage !== 'delivered' ? wallOf(text(transit, 'effectiveDate', 40)) : null;
  const weight = weightOf(details);
  const country = destination?.country;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(decided ? { current_stage: decided.stage, current_stage_source: decided.source } : {}),
    last_status_text: status || null,
    last_update: current?.time ?? null,
    ...(current?.local_time ? { last_update_local: current.local_time } : {}),
    expected_delivery: estimate?.day ?? null,
    ...(delivered?.time ? { delivered_at: delivered.time } : {}),
    ...(weight !== null ? { weight_kg: weight } : {}),
    ...(country ? { destination_country: country } : {}),
    summary_only: true,
    events,
  };
}
