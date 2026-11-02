import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { lastMovement } from '../../core/result/pickup.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, countryTimeZone, mislabeledLocalTime, mislabeledWallTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import {
  isReturnEvent, isSlovenskaPostaNotice, slovenskaPostaStage, slovenskaPostaStateStage,
} from './status.js';

export const PROVIDER = 'Slovenská pošta';
// A long history is a few kilobytes.
export const SLOVENSKA_POSTA_MAX_BYTES = 256_000;

const ZONE = 'Europe/Bratislava';
const MAX_PARCELS = 100;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
const CODE = /^[A-Z0-9][A-Z0-9_-]{0,39}$/;
const ENGLISH_REGIONS = new Intl.DisplayNames(['en'], { type: 'region' });
// The tracking page's headline for each state.
const STATE_WORDING: Readonly<Record<string, string>> = {
  accepted: 'Accepted',
  received: 'Posted',
  transit_there: 'In transit',
  transit_back: 'In transit back',
  delivering: 'Picked up for delivery',
  delivered: 'Delivered',
  returned: 'Returned',
  undeliverable: 'Undeliverable',
  canceled: 'Canceled',
  customs: 'eCustoms procedure',
};
const RETAINED_WORDING: Readonly<Record<string, string>> = { bbox: 'Deposited in ParcelBOX', point: 'Deposited at pickup point' };

/** Slovenská pošta tracks S10 item codes: its own, ending SK, and those other posts send to Slovakia. */
export function normalizeSlovenskaPostaNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (isValidS10TrackingNumber(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Slovenská pošta tracks S10 item codes');
}

interface Scan {
  readonly event: CarrierEvent;
  readonly code: string;
  readonly place: string;
}

/**
 * The place the tracking page shows for an event: a post office, BalíkoBOX or
 * PoštaPOINT by its display name, the last two with their town; an older
 * organisational unit by its name. Street, postcode, coordinates and phone
 * numbers are never read.
 */
function branchName(on: Record<string, unknown>): string {
  if ('kind' in on) {
    const name = clean(on.dname, 120) || clean(on.name, 120);
    const town = on.kind === 'bbox' || on.kind === 'point' ? clean(on.city, 80) : '';
    return name && town ? `${name}, ${town}` : name;
  }
  return clean(on.name, 120);
}

/**
 * When a scan happened. The service sends each event's local wall clock as if
 * it were UTC: the tracking page reads it with UTC getters and notes that the
 * times are local, and the documented T&T API sends the same digits as a local
 * date. A Slovak event is on Bratislava's clock and a foreign one on its
 * country's, when that country keeps a single clock; otherwise the wall clock
 * stays local.
 */
function clockOf(at: unknown, abroad: string | null): Pick<CarrierEvent, 'time'> & { local_time?: string } {
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at <= 0) {
    throw new SchemaError(PROVIDER, 'Slovenská pošta returned an event without a time');
  }
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) throw new SchemaError(PROVIDER, 'Slovenská pošta returned an invalid event time');
  const labeled = date.toISOString();
  const zone = abroad === null ? ZONE : countryTimeZone(abroad);
  const placed = zone ? mislabeledLocalTime(labeled, zone) : null;
  if (placed) return { time: placed.iso };
  const wall = mislabeledWallTime(labeled);
  if (!wall) throw new SchemaError(PROVIDER, 'Slovenská pošta returned an invalid event time');
  return { local_time: wall.replace(/\.\d+$/, '') };
}

function scanOf(value: unknown): Scan {
  if (!isRecord(value)) throw new SchemaError(PROVIDER, 'Slovenská pošta returned an invalid event');
  const code = clean(value.type, 40);
  if (!CODE.test(code)) throw new SchemaError(PROVIDER, 'Slovenská pošta returned an event without a code');
  const on = isRecord(value.on) ? value.on : null;
  // An event abroad names its country (which may be an unknown "XX"); one in
  // Slovakia names the branch, or nothing at all.
  const country = on && 'country' in on ? clean(on.country, 8).toUpperCase() : null;
  const abroad = country !== null && country !== 'SK' ? country : null;
  const known = abroad ? countryCode(abroad) : null;
  const place = on && country === null ? branchName(on) : '';
  const location = known ? ENGLISH_REGIONS.of(known) ?? known : place;
  const desc = isRecord(value.desc) ? value.desc : {};
  // Older wordings leave a placeholder for the branch, which the page fills in.
  const wording = (clean(desc.en, 300) || clean(desc.sk, 300)).replaceAll('{office}', place).replace(/\s+/g, ' ').trim();
  const event: CarrierEvent = { ...clockOf(value.at, abroad), description: wording || code, provider_code: code,
    ...(location ? { location } : {}) };
  return { event, code, place };
}

function identityOf(parcel: Record<string, unknown>, key: 'barcode' | 'query'): string {
  return typeof parcel[key] === 'string' ? normalizeTrackingNumber(parcel[key]) : '';
}

/** The parcel the answer gives for the number, or the error it gives instead. */
function parcelFor(payload: unknown, number: string): Record<string, unknown> {
  if (!isRecord(payload) || !Array.isArray(payload.parcels) || payload.parcels.length > MAX_PARCELS
    || !payload.parcels.every(isRecord)) {
    throw new SchemaError(PROVIDER, 'Slovenská pošta did not return a parcel list');
  }
  const parcels = payload.parcels as Record<string, unknown>[];
  const bound = parcels.filter(parcel => identityOf(parcel, 'barcode') === number);
  if (bound.length > 1) {
    throw new IndeterminateError(PROVIDER, 'Slovenská pošta returned several items for the number', { reason: 'several_parcels' });
  }
  if (bound.length === 1) return bound[0]!;
  // A rejected number comes back with the query alone.
  const refused = parcels.find(parcel => !('barcode' in parcel) && identityOf(parcel, 'query') === number && 'error' in parcel);
  if (refused) return refused;
  throw new SchemaError(PROVIDER, 'Slovenská pošta answered for a different item');
}

function weightOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 10_000 ? value : null;
}

/**
 * The tracking page's answer for one number: the item's current state and its
 * events, newest first, each with a code, English and Slovak wording, a clock
 * and the branch or country. A number Slovenská pošta has no item for comes
 * back with an error code.
 */
export function parseSlovenskaPosta(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeSlovenskaPostaNumber(rawNumber);
  const parcel = parcelFor(payload, number);

  if ('error' in parcel) {
    const error = clean(parcel.error, 40);
    if (error === 'not_found') throw new NotFoundError(PROVIDER);
    if (error === 'invalid_barcode') throw new InvalidInputError(PROVIDER, 'Slovenská pošta does not accept this item number', { reason: 'wrong_number' });
    if (error === 'not_found_used') {
      throw new IndeterminateError(PROVIDER, 'Slovenská pošta registers no data for the item', { reason: 'no_history' });
    }
    if (error === 'not_found_assigned') {
      // The number belongs to a sender who has not posted the item yet.
      return {
        status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map', provider_code: error,
        last_status_text: 'The item has not been posted by the sender yet', last_update: null, expected_delivery: null,
        summary_only: true, events: [],
      };
    }
    throw new IndeterminateError(PROVIDER, 'Slovenská pošta returned an error instead of the item');
  }

  const rows = parcel.events ?? [];
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Slovenská pošta returned an invalid item history');
  const state = isRecord(parcel.state) ? parcel.state : {};
  const stateName = clean(state.state, 40);
  const stateStage = slovenskaPostaStateStage(stateName);
  const scans: Scan[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const scan = scanOf(row);
    const identity = JSON.stringify(scan.event);
    if (seen.has(identity)) continue;
    seen.add(identity);
    scans.push(scan);
  }

  const weight = weightOf(parcel.weight);
  const recipient = isRecord(parcel.recipient) ? countryCode(parcel.recipient.country) : null;
  const extras: Partial<CarrierResult> = {
    ...(weight ? { weight_kg: weight } : {}),
    ...(recipient ? { destination_country: recipient } : {}),
  };
  // The state's branch is where the item waits; the page names it.
  const retainedAt = stateName === 'retained' && isRecord(state.on) && 'kind' in state.on ? branchName(state.on) : '';

  if (!scans.length) {
    const messages = Array.isArray(parcel.messages) ? parcel.messages : [];
    if (!stateStage) {
      if (messages.includes('track_not_provided')) {
        throw new IndeterminateError(PROVIDER, 'Slovenská pošta does not track this item type', { reason: 'tracking_withheld' });
      }
      throw new IndeterminateError(PROVIDER, 'Slovenská pošta returned the item without events', { reason: 'no_history' });
    }
    const kind = isRecord(state.on) ? clean(state.on.kind, 16) : '';
    const wording = stateName === 'retained' ? (Object.hasOwn(RETAINED_WORDING, kind) ? RETAINED_WORDING[kind]! : 'Deposited at post office')
      : STATE_WORDING[stateName]!;
    return {
      status: languageStageStatus(stateStage), current_stage: stateStage, current_stage_source: 'carrier_map',
      provider_code: stateName, last_status_text: wording, last_update: null, expected_delivery: null,
      ...(retainedAt ? { pickup_point: retainedAt } : {}), ...extras, summary_only: true, events: [],
    };
  }

  // Oldest first: a notice keeps the stage of the event before it, and a
  // delivery after the item was sent back reaches the sender, as does one the
  // state places on the way back.
  let returning = stateName === 'transit_back' || stateName === 'returned';
  let previous: Stage | undefined;
  for (const { event, code } of [...scans].reverse()) {
    if (isReturnEvent(code)) returning = true;
    if (isSlovenskaPostaNotice(code)) {
      if (previous) Object.assign(event, { stage: previous, stage_source: 'none' });
      continue;
    }
    const classified = slovenskaPostaStage(code, event.description!);
    const stage = classified?.stage === 'delivered' && returning ? 'returned' : classified?.stage;
    if (stage) Object.assign(event, { stage, stage_source: classified!.source });
    previous = stage;
  }

  const decider = scans.find(scan => !isSlovenskaPostaNotice(scan.code)) ?? scans[0]!;
  const eventStage = decider.event.stage as Stage | undefined;
  // An event without a stage leaves the item's state, which the page headlines.
  const stage = eventStage ?? stateStage;
  const source = eventStage ? decider.event.stage_source! : 'carrier_map';

  // The office or box an item waits at is its pickup point; a delivered item
  // was collected there when it waited there last. A return's is the sender's.
  let point = '';
  if (!returning) {
    if (stage === 'ready_for_pickup') point = retainedAt || (eventStage === 'ready_for_pickup' ? decider.place : '');
    else if (stage === 'delivered' && eventStage === 'delivered') {
      const earlier = scans.slice(scans.indexOf(decider) + 1);
      if (lastMovement(earlier.map(scan => scan.event)) === 'ready_for_pickup') {
        point = earlier.find(scan => scan.event.stage === 'ready_for_pickup' && !isSlovenskaPostaNotice(scan.code))?.place ?? '';
      }
    }
  }
  const delivered = stage === 'delivered' && eventStage === 'delivered' ? decider.event.time : undefined;
  const newest = scans[0]!.event;
  const events = scans.map(scan => scan.event);

  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source } : {}),
    last_status_text: decider.event.description!,
    last_update: newest.time ?? null,
    ...(newest.time ? {} : { last_update_local: newest.local_time! }),
    expected_delivery: null,
    ...(point ? { pickup_point: point } : {}),
    ...(delivered ? { delivered_at: delivered } : {}),
    ...extras,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
