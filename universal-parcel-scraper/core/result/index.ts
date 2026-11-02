/**
 * The result every adapter and provider returns, and its normalization.
 *
 * What it is: the shape contract between the carrier package and the host
 * (status, stage, estimate, sender/pickup names, weight, and the projected
 * events). What it is not: it does not classify wording into stages or touch
 * the database; the host's sync does that after `normalizeCarrierResult`. It
 * reads only the few customs wordings that ask the recipient to act.
 * An event with no `stage` means "no explicit mapping" (see
 * ARCHITECTURE.md § Status model).
 */
import { isRecord, type JsonObject } from '../types.js';
import { CARRIER_CATALOG, STAGES } from '../../generated/catalog.js';
import { normalizeTrackingNumber } from '../detection/normalize.js';
import { USPS_ROUTING_BARCODE, uspsPackageIdentifier } from '../detection/usps.js';
import { deliveredToDoor } from './pickup.js';
import { isRecipientAction, recipientAction, type RecipientAction } from '../status/action.js';
import { withTieOrder } from './order.js';

export type CarrierStatus =
  | 'pending'
  | 'in_transit'
  | 'out_for_delivery'
  | 'delivered'
  | 'exception'
  | 'unknown';

export interface CarrierEvent extends JsonObject {
  time?: string;
  /** The scan's wall clock, when the carrier does not say in which zone. */
  local_time?: string;
  /**
   * The zone a deduced `time` reads `local_time` in, and how it was chosen:
   * `place`, `neighbour`, `destination` or `carrier` (`dateLocalClocks` in `/places`).
   */
  time_zone?: string;
  time_zone_basis?: string;
  location?: string;
  description?: string;
  stage?: string;
  /** Explicit map, wording rule, or unresolved fallback used by the adapter. */
  stage_source?: string;
  provider_code?: string;
  /**
   * Where the carrier itself puts the scanning facility, when it says so. The
   * map uses it only where it agrees with the town in `location`.
   */
  point?: EventPoint;
  /** When the carrier's system wrote the scan, with that system's offset, where its reply says. */
  written_at?: string;
  /**
   * What the scan asks the recipient to do before the parcel can move on, in a customs wording
   * that says so explicitly (`recipientAction`) or a carrier code that does.
   */
  recipient_action?: RecipientAction;
  /**
   * The scan's place among the answer's scans at its instant, from the oldest: the carrier's
   * own order of scans it dates alike (`withTieOrder`).
   */
  tie_order?: number;
}

export interface EventPoint extends JsonObject {
  latitude: number;
  longitude: number;
}

/**
 * The import charges the carrier lists for the parcel, in `currency`. The
 * amounts are in its major unit, such as 34.41 for €34.41.
 */
export interface ImportCharges extends JsonObject {
  /** ISO 4217 code of the amounts. */
  currency: string;
  /** Customs duty and import VAT together, which the carrier collects for the customs authority. */
  customs?: number;
  /** The carrier's own fee for clearing the parcel, as charged on delivery. */
  carrier_fee?: number;
  /** That fee when the charges are paid online before delivery, while the carrier still takes payment online. */
  carrier_fee_online?: number;
  /** Whether the charges are paid, when the carrier says. */
  paid?: boolean;
  /** The carrier's own code for where the payment stands. */
  status_code?: string;
}

export interface CarrierResult extends JsonObject {
  status?: CarrierStatus;
  current_stage?: string;
  /** How the adapter chose current_stage, when it records that decision. */
  current_stage_source?: string;
  last_status_text?: string | null;
  /** The carrier's own code for the current status, when a summary has no scan to carry it. */
  provider_code?: string;
  last_update?: string | null;
  expected_delivery?: string | null;
  expected_delivery_from?: string | null;
  /**
   * Who sent the parcel. Null when the name the carrier gives is not its sender, as the account
   * a return goes back to: a name an earlier answer gave no longer stands. Absent says nothing.
   */
  sender_name?: string | null;
  receiver_name?: string | null;
  /**
   * The point the parcel waits at for collection: its name, then its address on
   * the following lines. On a delivered parcel, the point it was collected from;
   * a parcel brought to the door has none.
   */
  pickup_point?: string | null;
  delivered_at?: string | null;
  weight_kg?: number | null;
  dimensions_text?: string | null;
  /** The carrier's own name for the shipping service the parcel travels under, as its page shows it. */
  service_name?: string;
  /** The duties, taxes and fees the carrier lists for importing the parcel. */
  import_charges?: ImportCharges;
  /** A declared delivery partner, still subject to direct identity/progress confirmation. */
  delivery_carrier?: string;
  destination_country?: string;
  /** Preserve provider country labels when no verified ISO mapping is available. */
  destination_country_name?: string;
  delivery_tracking_number?: string;
  canonical_tracking_number?: string;
  international_tracking_number?: string;
  timezone?: string;
  /** An identity-bound current status without a scan history. */
  summary_only?: boolean;
  /** The carrier returned only part of a longer scan history, such as its newest scans. */
  history_truncated?: boolean;
  /**
   * The clocks of rows the carrier holds back as written ahead of them, which a provider
   * relaying them shows as scans: an instant with its offset, or a wall clock.
   */
  written_ahead?: string[];
  events?: CarrierEvent[];
}

// A clock of a row written ahead: a date and a time of day, with or without seconds and an offset.
const WRITTEN_AHEAD_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?$/;
const MAX_WRITTEN_AHEAD = 200;

const STATUSES = new Set<CarrierStatus>([
  'pending',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'exception',
  'unknown',
]);
const CURRENT_STAGES = new Set<string>(STAGES);
const OPTIONAL_TEXT_FIELDS = [
  'current_stage_source',
  'last_status_text',
  'provider_code',
  'last_update',
  'expected_delivery',
  'expected_delivery_from',
  'sender_name',
  'receiver_name',
  'pickup_point',
  'delivered_at',
  'dimensions_text',
  'canonical_tracking_number',
  'international_tracking_number',
  'timezone',
] as const;
const EVENT_TEXT_FIELDS = ['time', 'location', 'description', 'stage', 'stage_source'] as const;
const NUMBER_FIELDS = ['delivery_tracking_number', 'canonical_tracking_number', 'international_tracking_number'] as const;

/** A carrier's coordinates for a scan, or null when they are not a usable point. */
export function eventPoint(latitude: unknown, longitude: unknown): EventPoint | null {
  const number = (value: unknown) => typeof value === 'string' && value.trim() ? Number(value) : value;
  const lat = number(latitude);
  const lon = number(longitude);
  if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  // 0,0 is a missing value, not a scan in the Gulf of Guinea.
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return null;
  // Four decimals is about ten metres: a building, not a desk.
  return { latitude: Math.round(lat * 1e4) / 1e4, longitude: Math.round(lon * 1e4) / 1e4 };
}

const AMOUNTS = ['customs', 'carrier_fee', 'carrier_fee_online'] as const;

/** The import charges an adapter states, without the members that are not valid; none without a currency or anything it says. */
function importCharges(value: unknown): ImportCharges | undefined {
  if (!isRecord(value) || typeof value.currency !== 'string' || !/^[A-Z]{3}$/.test(value.currency)) return undefined;
  const charges: ImportCharges = { currency: value.currency };
  for (const field of AMOUNTS) {
    const amount = value[field];
    if (typeof amount === 'number' && Number.isFinite(amount) && amount >= 0) charges[field] = amount;
  }
  if (typeof value.paid === 'boolean') charges.paid = value.paid;
  if (typeof value.status_code === 'string' && value.status_code.trim() && value.status_code.length <= 60) charges.status_code = value.status_code;
  return Object.keys(charges).length > 1 ? charges : undefined;
}

export function normalizeCarrierResult(value: unknown): CarrierResult {
  if (!isRecord(value)) throw new TypeError('The carrier adapter returned an invalid response');
  const normalized: CarrierResult = { ...value };
  normalized.status = typeof value.status === 'string' && STATUSES.has(value.status as CarrierStatus)
    ? value.status as CarrierStatus
    : 'unknown';
  if (value.current_stage !== undefined) {
    if (typeof value.current_stage !== 'string' || !CURRENT_STAGES.has(value.current_stage)) {
      throw new TypeError('The carrier adapter returned an invalid current stage');
    }
    normalized.current_stage = value.current_stage;
  }

  for (const field of OPTIONAL_TEXT_FIELDS) {
    const fieldValue = normalized[field];
    if (fieldValue != null && typeof fieldValue !== 'string') {
      throw new TypeError(`The carrier adapter returned an invalid ${field.replaceAll('_', ' ')}`);
    }
  }
  const weight = normalized.weight_kg;
  if (weight != null && (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0)) {
    throw new TypeError('The carrier adapter returned an invalid parcel weight');
  }
  if (typeof normalized.service_name !== 'string' || !normalized.service_name.trim() || normalized.service_name.length > 80) {
    delete normalized.service_name;
  }
  const charges = importCharges(normalized.import_charges);
  if (charges) normalized.import_charges = charges;
  else delete normalized.import_charges;

  // A USPS routing barcode opens with the recipient's ZIP code. A reported
  // number keeps only the package identifier after it, and is dropped when
  // that identifier cannot be split off cleanly.
  for (const field of NUMBER_FIELDS) {
    const number = normalized[field];
    if (typeof number !== 'string' || !USPS_ROUTING_BARCODE.test(normalizeTrackingNumber(number))) continue;
    const pic = uspsPackageIdentifier(number);
    if (pic) normalized[field] = pic;
    else delete normalized[field];
  }

  // Optional routing evidence must not discard otherwise valid tracking history.
  // A carrier can report a verified downstream reference without naming the
  // operator. Preserve that independent evidence for catalog-based discovery.
  if ((normalized.delivery_carrier != null && (typeof normalized.delivery_carrier !== 'string'
      || !Object.hasOwn(CARRIER_CATALOG, normalized.delivery_carrier)))
    || (normalized.delivery_tracking_number != null && (typeof normalized.delivery_tracking_number !== 'string'
      || !/^[A-Z0-9]{4,40}$/.test(normalized.delivery_tracking_number)))) {
    delete normalized.delivery_carrier;
    delete normalized.delivery_tracking_number;
  }
  if (typeof normalized.destination_country !== 'string' || !/^[A-Z]{2}$/.test(normalized.destination_country)) {
    delete normalized.destination_country;
  }
  if (typeof normalized.destination_country_name !== 'string' || normalized.destination_country_name.length > 80) {
    delete normalized.destination_country_name;
  }
  // Completeness flags qualify the history; one that is not a boolean says nothing.
  for (const flag of ['summary_only', 'history_truncated'] as const) {
    if (typeof normalized[flag] !== 'boolean') delete normalized[flag];
  }
  const ahead = normalized.written_ahead;
  if (!Array.isArray(ahead) || !ahead.length || ahead.length > MAX_WRITTEN_AHEAD
    || !ahead.every((clock) => typeof clock === 'string' && WRITTEN_AHEAD_CLOCK.test(clock))) delete normalized.written_ahead;

  const rawEvents = normalized.events ?? [];
  if (!Array.isArray(rawEvents)) {
    throw new TypeError('The carrier adapter returned invalid tracking events');
  }
  normalized.events = rawEvents.map((rawEvent) => {
    if (!isRecord(rawEvent)) {
      throw new TypeError('The carrier adapter returned an invalid tracking event');
    }
    for (const field of EVENT_TEXT_FIELDS) {
      const fieldValue = rawEvent[field];
      if (fieldValue != null && typeof fieldValue !== 'string') {
        throw new TypeError('The carrier adapter returned an invalid tracking event');
      }
    }
    const event = { ...rawEvent };
    // A blank place is no place.
    if (typeof event.location === 'string' && !event.location.trim()) delete event.location;
    if (event.point !== undefined) {
      const point = isRecord(event.point) ? eventPoint(event.point.latitude, event.point.longitude) : null;
      if (point) event.point = point;
      else delete event.point;
    }
    const action = isRecipientAction(event.recipient_action) ? event.recipient_action : recipientAction(event.description);
    if (action) event.recipient_action = action;
    else delete event.recipient_action;
    return event;
  });
  withTieOrder(normalized.events);
  // Some carriers keep naming a pickup point on a parcel the courier brought to
  // the door: the one it waited at before going back out, or the one it would
  // have gone to.
  if (normalized.pickup_point != null && deliveredToDoor(normalized)) delete normalized.pickup_point;
  return normalized;
}
