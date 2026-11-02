import { returnedTrackingNumber } from '../../core/detection/returned.js';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime, firstOccurrence } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { kuehneNagelLabel, kuehneNagelStage } from './status.js';

export const PROVIDER = 'Kuehne+Nagel';
// A search reply lists at most 50 shipments; a route and its notices are a few kilobytes.
export const KUEHNE_NAGEL_MAX_BYTES = 512_000;

// Tracking numbers, waybills, bookings and references of every transport mode share one search.
const NUMBER = /^(?=.*\d)[A-Z0-9]{6,35}$/;
const ID = /^\d{1,15}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^\d{2}:\d{2}(?::\d{2})?$/;
const OFFSET = /^(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_ROUTE_LOCATIONS = 100;
const MAX_MILESTONES = 50;
const MAX_EVENTS = 200;
// The search kind of a shipment's own tracking number.
const TRACKING_NUMBER = 'reference.TN';
// References Kuehne+Nagel issues itself: its tracking, waybill, booking and
// file numbers. The others (customer and package references, containers,
// carriers' own bills and waybills) can belong to anyone.
const OWN_KINDS = new Set(['TN', 'HAW', 'BI', 'BN', 'KN', 'KNE', 'KNI', 'SN', 'MKNR', 'MTN', 'SWB', 'BBL']
  .map(kind => `reference.${kind}`));
// Free text naming a place, as the shipper's or consignee's town; with digits it can carry a postcode or a street.
const DIGIT = /\d/;
// The route's last stop: the consignee's town or the delivery point.
const DESTINATION = /^route-location\.(?:destination|delivery)\./;
// A clock without an offset is ordered as if read in Zurich, the catalog zone. It keeps no offset.
const ORDER_ZONE = 'Europe/Zurich';

/** Kuehne+Nagel's public tracker takes a tracking number or reference of letters and digits. */
export function normalizeKuehneNagelNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (NUMBER.test(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Kuehne+Nagel tracks references of 6 to 35 letters and digits');
}

/** The shipment one search found, by the tracker's own id. */
export interface KuehneNagelMatch {
  readonly id: string;
  /** The shipment's own tracking number. */
  readonly trackingNumber: string;
  /** The kind of reference the search matched, as `reference.TN`. */
  readonly kind: string;
  readonly weightKg?: number;
  /** The newest achieved milestone the search names, when it carries an offset. */
  readonly lastActivityAt: string | null;
}

/** Whether the search matched a reference Kuehne+Nagel issues itself. */
export function kuehneNagelOwnReference(match: KuehneNagelMatch): boolean {
  return OWN_KINDS.has(match.kind);
}

interface Clock {
  readonly time?: string;
  readonly local_time?: string;
  /** For ordering only: the instant, or the wall clock read in Zurich. */
  readonly order: number;
}

/**
 * A tracker date: `date`, `time` and `offset` fields. The offset is present
 * only when the scanning system knows it. Without one, the `offsetDateTime`
 * beside it still says +00:00, which nobody measured, so it is never read.
 */
function clock(value: unknown): Clock | null {
  if (!isRecord(value)) return null;
  const date = typeof value.date === 'string' && DAY.test(value.date) ? value.date : null;
  if (!date) return null;
  const time = typeof value.time === 'string' && CLOCK.test(value.time) ? value.time.padEnd(8, ':00') : null;
  const offset = typeof value.offset === 'string' && OFFSET.test(value.offset) ? value.offset : null;
  if (time && offset) {
    const parsed = explicitOffsetTime(`${date}T${time}${offset}`);
    return parsed ? { time: parsed.iso, order: parsed.timestamp } : null;
  }
  const wall = time ? `${date}T${time}` : date;
  const read = firstOccurrence(DateTime.fromISO(wall, { zone: ORDER_ZONE }));
  return read.isValid ? { local_time: wall, order: read.toMillis() } : null;
}

/** An achieved milestone's date; a planned one is a forecast. */
function achieved(milestone: Record<string, unknown>): Clock | null {
  for (const field of ['actualAchievementDateTime', 'achievementDateTime']) {
    const value = milestone[field];
    if (isRecord(value) && value.condition === 'ACTUAL') return clock(value.dateTime);
  }
  return null;
}

function newestActivity(shipment: Record<string, unknown>): string | null {
  const times = ['currentMilestoneDate', 'completionMilestoneDate'].flatMap((field) => {
    const date = shipment[field];
    const actual = isRecord(date) ? date.actualAchievementDateTime : null;
    const read = isRecord(actual) && actual.condition === 'ACTUAL' ? clock(actual.dateTime) : null;
    return read?.time ? [read.order] : [];
  });
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

function weightKg(value: unknown): number | undefined {
  if (!isRecord(value) || value.unit !== 'content.weightUnit.kg') return undefined;
  const raw = cleanScalar(value.value, 20);
  const weight = /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : Number.NaN;
  return Number.isFinite(weight) && weight > 0 ? weight : undefined;
}

/**
 * The search reply: the shipments found, grouped by the kind of reference the
 * query matched. The search ignores case, spaces and dashes, matches whole
 * references only and covers shipments of the last 90 days. A shipment whose
 * own tracking number is the query is the answer; otherwise the one shipment
 * all the references found, whatever their kind.
 */
export function parseKuehneNagelSearch(payload: unknown, rawNumber: string): KuehneNagelMatch {
  const number = normalizeKuehneNagelNumber(rawNumber);
  if (!isRecord(payload) || typeof payload.totalResults !== 'number') {
    throw new SchemaError(PROVIDER, 'Kuehne+Nagel did not return its search results');
  }
  const groups = payload.searchResultsByType ?? [];
  if (!Array.isArray(groups)) throw new SchemaError(PROVIDER, 'Kuehne+Nagel returned invalid search results');
  const found = new Map<string, { readonly match: KuehneNagelMatch; readonly exact: boolean }>();
  for (const group of groups) {
    if (!isRecord(group) || typeof group.kind !== 'string' || !Array.isArray(group.shipments)) {
      throw new SchemaError(PROVIDER, 'Kuehne+Nagel returned an invalid search group');
    }
    const kind = clean(group.kind, 60);
    for (const shipment of group.shipments as unknown[]) {
      const id = isRecord(shipment) ? cleanScalar(shipment.id, 20) : '';
      const trackingNumber = isRecord(shipment) ? returnedTrackingNumber(shipment.trackingNumber) : '';
      if (!isRecord(shipment) || !ID.test(id) || !trackingNumber || trackingNumber.length > 40) {
        throw new SchemaError(PROVIDER, 'Kuehne+Nagel returned a shipment without its id or tracking number');
      }
      const exact = kind === TRACKING_NUMBER && trackingNumber === number;
      const known = found.get(id);
      if (known && (known.exact || !exact)) continue;
      const weight = weightKg(shipment.weight);
      found.set(id, { exact, match: { id, trackingNumber, kind, lastActivityAt: newestActivity(shipment), ...(weight ? { weightKg: weight } : {}) } });
    }
  }
  if (!found.size) {
    if (payload.totalResults === 0) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'Kuehne+Nagel counted shipments it did not list');
  }
  const candidates = [...found.values()];
  const exact = candidates.filter(candidate => candidate.exact);
  const chosen = exact.length === 1 ? exact[0]! : !exact.length && candidates.length === 1 ? candidates[0]! : null;
  if (!chosen) throw new IndeterminateError(PROVIDER, 'Kuehne+Nagel found several shipments for the reference', { reason: 'several_parcels' });
  return chosen.match;
}

/** A stop's town, as the page shows it, and its country. */
function place(location: unknown): string | undefined {
  if (!isRecord(location)) return undefined;
  const country = typeof location.countryCode === 'string' && /^[A-Z]{2}$/.test(location.countryCode) ? location.countryCode : '';
  // A coded stop is a Kuehne+Nagel station, port or airport; an uncoded one is the shipper's or consignee's town.
  const named = location.locationCode != null ? clean(location.internationalName, 80) || clean(location.freeTextLocation, 80)
    : clean(location.freeTextLocation, 80);
  const town = DIGIT.test(named) ? '' : named;
  if (town) return country ? `${town}, ${country}` : town;
  return clean(location.countryName, 60) || country || undefined;
}

function humanize(code: string): string {
  const words = code.split('.').filter(part => !['road', 'air', 'sea', 'default', 'name', 'child'].includes(part)).join(' ').replaceAll('-', ' ');
  return words ? words[0]!.toUpperCase() + words.slice(1) : code;
}

interface Scan { readonly event: CarrierEvent; readonly order: number; readonly index: number }

function scan(code: string, at: Clock, location?: string): CarrierEvent {
  return {
    ...(at.time ? { time: at.time } : { local_time: at.local_time! }),
    description: kuehneNagelLabel(code) ?? humanize(code),
    provider_code: code,
    ...(location ? { location } : {}),
  };
}

function suffix(label: unknown, prefix: string): string | null {
  const raw = clean(label, 200);
  return raw.startsWith(prefix) && raw.length > prefix.length ? raw.slice(prefix.length) : null;
}

/**
 * The shipment's route and its notices. The route lists the stops in order,
 * each with its milestones; a milestone counts once it has an actual date,
 * and a road milestone can carry an exception such as a failed delivery. The
 * notices are bookings, customs steps and documents, each with its date.
 */
export function parseKuehneNagel(routing: unknown, information: unknown, match: KuehneNagelMatch, rawNumber: string): CarrierResult {
  const number = normalizeKuehneNagelNumber(rawNumber);
  if (!isRecord(routing) || !Array.isArray(routing.routeLocations) || routing.routeLocations.length > MAX_ROUTE_LOCATIONS) {
    throw new SchemaError(PROVIDER, 'Kuehne+Nagel did not return the shipment route');
  }
  const notices = isRecord(information) ? information.transportInformationMilestones ?? [] : null;
  if (!Array.isArray(notices) || notices.length > MAX_MILESTONES) {
    throw new SchemaError(PROVIDER, 'Kuehne+Nagel did not return the shipment notices');
  }

  const scans: Scan[] = [];
  const seen = new Set<string>();
  const add = (event: CarrierEvent, order: number) => {
    const identity = JSON.stringify(event);
    if (seen.has(identity)) return;
    seen.add(identity);
    scans.push({ event, order, index: scans.length });
  };
  let destination: string | undefined;
  for (const stop of routing.routeLocations) {
    if (!isRecord(stop)) throw new SchemaError(PROVIDER, 'Kuehne+Nagel returned an invalid route stop');
    const location = place(stop.location);
    if (DESTINATION.test(clean(stop.labelIdentifier, 120)) && isRecord(stop.location)
      && typeof stop.location.countryCode === 'string' && /^[A-Z]{2}$/.test(stop.location.countryCode)) {
      destination = stop.location.countryCode;
    }
    const milestones = stop.locationMilestones ?? [];
    if (!Array.isArray(milestones) || milestones.length > MAX_MILESTONES) {
      throw new SchemaError(PROVIDER, 'Kuehne+Nagel returned invalid route milestones');
    }
    for (const milestone of milestones) {
      if (!isRecord(milestone)) throw new SchemaError(PROVIDER, 'Kuehne+Nagel returned an invalid route milestone');
      const code = suffix(milestone.labelIdentifier, 'location-milestone.');
      if (!code) throw new SchemaError(PROVIDER, 'Kuehne+Nagel returned a milestone without its label');
      const at = achieved(milestone);
      if (at) add(scan(code, at, location), at.order);
      // The page shows the exception's own label beside the milestone and the date it was reported.
      const exception = milestone.exception;
      const label = isRecord(exception) ? clean(exception.label, 200).replace(/^routing\./, '') : '';
      if (label && /^[a-z0-9.-]+$/i.test(label)) {
        const when = (isRecord(exception) ? clock(exception.statusDate) : null) ?? at;
        if (when) add(scan(label, when, location), when.order);
      }
    }
  }
  for (const notice of notices) {
    if (!isRecord(notice)) throw new SchemaError(PROVIDER, 'Kuehne+Nagel returned an invalid notice');
    const children = notice.children ?? [];
    if (!Array.isArray(children) || children.length > MAX_MILESTONES) throw new SchemaError(PROVIDER, 'Kuehne+Nagel returned invalid notice details');
    for (const entry of [notice, ...(children as unknown[])]) {
      if (!isRecord(entry)) throw new SchemaError(PROVIDER, 'Kuehne+Nagel returned an invalid notice detail');
      const code = suffix(entry.labelIdentifier, 'information-milestone.');
      const at = clock(entry.dateTime);
      // An undated notice is a step the page lists as still to come.
      if (code && at) add(scan(code, at), at.order);
    }
  }
  if (!scans.length) throw new IndeterminateError(PROVIDER, 'Kuehne+Nagel has no achieved milestones for the shipment', { reason: 'no_history' });

  // Newest first; the route and the notices list theirs oldest first.
  scans.sort((left, right) => right.order - left.order || right.index - left.index);
  const events = scans.map(({ event }) => event);
  for (const event of events) {
    const stage = kuehneNagelStage(event.provider_code!);
    if (stage) Object.assign(event, { stage, stage_source: 'carrier_map' });
  }

  const staged = events.filter(event => event.stage);
  // A booking can be confirmed or changed after the first scans, and a
  // customs notice filed after the delivery: neither moves a shipment back.
  let current = staged.find(event => event.stage !== 'registered') ?? staged[0];
  const delivery = staged.find(event => event.stage === 'delivered');
  if (current && delivery && ['accepted', 'in_transit', 'customs', 'out_for_delivery'].includes(current.stage!)) current = delivery;
  const latest = current ?? events[0]!;
  const stage = current?.stage as Stage | undefined;
  // The proof of delivery comes after the delivery itself, which dates it.
  const delivered = stage === 'delivered'
    ? (staged.find(event => event.stage === 'delivered' && event.provider_code !== 'pod-available') ?? current)!
    : null;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    ...(latest.time ? {} : { last_update_local: latest.local_time }),
    expected_delivery: null,
    delivered_at: delivered?.time ?? null,
    ...(match.weightKg ? { weight_kg: match.weightKg } : {}),
    ...(destination ? { destination_country: destination } : {}),
    ...(match.trackingNumber !== number ? { canonical_tracking_number: match.trackingNumber } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
