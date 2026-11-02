import { load, type CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { lastMovement } from '../../core/result/pickup.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { venipakScanStage } from './status.js';

export const PROVIDER = 'Venipak';

// A parcel number: V, the sender's five-digit customer ID, E and a serial.
const PARCEL = /^V\d{5}E\d{7}$/;
// A shipment number: the tracker answers it with the shipment's parcels. It
// has grown from seven digits to nine, and is sometimes typed with zeros in front.
const SHIPMENT = /^0{0,3}([1-9]\d{6,9})$/;
const CLOCK = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/;
// A parcel the shipment lists, as its container's id names it.
const PARCEL_ID = /^parcel-([A-Z0-9]{6,40})$/;
// The first part of a scan's place when it is a Venipak locker or pickup point.
const POINT_KIND = /^Venipak [^,]{1,40}$/;
// A terminal or depot, which the tracker writes in capitals ("VILNIUS TM2").
// Anything else after a scan's wording is not read: it could be an address.
const TERMINAL = /^[\p{Lu}\d][\p{Lu}\d .'-]{0,39}$/u;
const MAX_ROWS = 200;
const MAX_EVENTS = 100;

export interface VenipakNumber {
  /** The number as the tracker is asked for it. */
  readonly query: string;
  readonly kind: 'parcel' | 'shipment';
}

/** A Venipak parcel number, or a shipment number without its leading zeros. */
export function normalizeVenipakNumber(raw: string): VenipakNumber {
  const number = normalizeTrackingNumber(raw);
  if (PARCEL.test(number)) return { query: number, kind: 'parcel' };
  const shipment = SHIPMENT.exec(number);
  if (shipment) return { query: shipment[1]!, kind: 'shipment' };
  throw new InvalidInputError(PROVIDER, 'Venipak tracks V, five digits, E and seven digits, or a shipment number of seven to ten digits');
}

/** Only a parcel number: shipment numbers are dense, so the tracker knowing one says little about whose it is. */
export function normalizeVenipakParcelNumber(raw: string): string {
  const number = normalizeVenipakNumber(raw);
  if (number.kind !== 'parcel') throw new InvalidInputError(PROVIDER, 'Venipak recognizes parcel numbers only');
  return number.query;
}

/** The tracker's clock ("2026-07-21 20:06") as a wall time. It carries no offset. */
function wallClock(text: string): string | null {
  const match = CLOCK.exec(text);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  // UTC only checks the calendar fields. No offset is assigned.
  const parsed = DateTime.fromObject({ year: Number(year), month: Number(month), day: Number(day), hour: Number(hour),
    minute: Number(minute) }, { zone: 'UTC' });
  return parsed.isValid ? parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") : null;
}

interface Place {
  /** Where the scan happened, as far as it names a terminal or a Venipak point. */
  readonly location?: string;
  /** A Venipak locker or pickup point: its name, then its town on the next line. */
  readonly point?: string;
}

/**
 * The parts of a scan's text after its wording. A locker or pickup point comes
 * as its kind, its name and often its town; a terminal as one word in capitals.
 */
function placeOf(parts: readonly string[]): Place {
  if (!parts.length) return {};
  if (POINT_KIND.test(parts[0]!) && parts.length >= 2 && parts.length <= 3) {
    const named = parts.slice(1);
    return { location: named.join(', '), point: named.join('\n') };
  }
  return parts.length === 1 && TERMINAL.test(parts[0]!) ? { location: parts[0]! } : {};
}

interface Scan {
  readonly event: CarrierEvent;
  readonly time: string;
  readonly wording: string;
  readonly point?: string;
  readonly index: number;
}

function scanOf(row: ReturnType<CheerioAPI>, index: number): Scan {
  const time = wallClock(clean(row.children('.info-time').text(), 32));
  if (!time) throw new SchemaError(PROVIDER, 'Venipak returned an invalid scan time');
  const places = row.children('.info-place');
  if (places.length !== 1) throw new SchemaError(PROVIDER, 'Venipak returned a scan without its text');
  const [wording, ...rest] = clean(places.text(), 300).split(/\s*,\s*/).map((part) => part.trim());
  if (!wording) throw new SchemaError(PROVIDER, 'Venipak returned a scan without wording');
  const { location, point } = placeOf(rest.filter(Boolean));
  const stage = venipakScanStage(wording);
  return { event: { local_time: time, description: wording, ...(location ? { location } : {}),
    ...(stage ? { stage, stage_source: 'carrier_map' } : {}) }, time, wording, ...(point ? { point } : {}), index };
}

/** The parcel the reply is about, with the number the result reports when the lookup named its shipment. */
function selectParcel($: CheerioAPI, number: VenipakNumber): { container: ReturnType<CheerioAPI>; canonical?: string } {
  const containers = $('.parcel-info-container');
  const parcels = containers.toArray().map((node) => PARCEL_ID.exec($(node).attr('id') ?? '')?.[1]);
  if (parcels.some((parcel) => !parcel)) throw new SchemaError(PROVIDER, 'Venipak returned a parcel without its number');
  if (number.kind === 'parcel') {
    const matching = parcels.flatMap((parcel, index) => parcel === number.query ? [index] : []);
    if (matching.length !== 1) throw new SchemaError(PROVIDER, 'Venipak returned a different parcel');
    return { container: containers.eq(matching[0]!) };
  }
  // The shipment's own number must be the one asked for, and must hold one parcel.
  const shipment = $('#consignmentID');
  if (shipment.length !== 1 || clean(shipment.attr('value'), 20) !== number.query) {
    throw new SchemaError(PROVIDER, 'Venipak returned a different shipment');
  }
  if (parcels.length > 1) {
    throw new IndeterminateError(PROVIDER, 'Venipak shipment holds several parcels; track each parcel number', { reason: 'several_parcels' });
  }
  return { container: containers.first(), canonical: parcels[0]! };
}

/**
 * The tracker's reply: an HTML fragment listing the parcels of the shipment the
 * number belongs to, each with its scans oldest first. The reply echoes the
 * number it searched; the parcel is the one whose container the number names,
 * or the only parcel of the shipment asked for by its number. A number the
 * tracker does not know returns its "not found" notice and no parcel.
 */
export function parseVenipak(reply: unknown, raw: string): CarrierResult {
  const number = normalizeVenipakNumber(raw);
  if (typeof reply !== 'object' || reply === null || Array.isArray(reply) || typeof (reply as { parcels?: unknown }).parcels !== 'string') {
    throw new SchemaError(PROVIDER, 'Venipak tracking reply changed');
  }
  const $ = load((reply as { parcels: string }).parcels);
  const searched = $('#searchQuery');
  if (searched.length !== 1 || clean(searched.attr('value'), 200).split(' ').pop() !== number.query) {
    throw new SchemaError(PROVIDER, 'Venipak did not answer for the requested number');
  }
  const containers = $('.parcel-info-container');
  const notices = $('.error-message');
  if (notices.length) {
    const notice = clean(notices.text(), 300);
    if (notices.length === 1 && !containers.length) {
      if (notice === `Shipment ${number.query} not found`) throw new NotFoundError(PROVIDER);
      if (notice === 'Wrong shipment ID') throw new InvalidInputError(PROVIDER, 'Venipak refused the number', { reason: 'wrong_number' });
    }
    throw new IndeterminateError(PROVIDER, 'Venipak returned a notice instead of the parcel');
  }
  if (!containers.length) throw new IndeterminateError(PROVIDER, 'Venipak did not return a parcel');
  const { container, canonical } = selectParcel($, number);

  const rows = container.children('.parcel-info');
  if (!rows.length) throw new NoHistoryError(PROVIDER);
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Venipak returned too many scans');
  const scans: Scan[] = [];
  const seen = new Set<string>();
  rows.each((index, node) => {
    const scan = scanOf($(node), index);
    const identity = `${scan.time}\u0000${scan.wording}\u0000${scan.event.location ?? ''}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    scans.push(scan);
  });
  // Newest first. The tracker lists scans oldest first, so of two with the same
  // clock the later one in its list is the newer.
  scans.sort((left, right) => right.time > left.time ? 1 : right.time < left.time ? -1 : right.index - left.index);
  const events = scans.map(({ event }) => event);
  const newest = scans[0]!;
  const stage = newest.event.stage as Stage | undefined;

  // The point the parcel waits at, or was collected from: the one it was
  // delivered to, when that was the last move. A parcel taken on from there
  // or brought to the door has none.
  const ready = scans.find(({ event }) => event.stage === 'ready_for_pickup');
  const atPoint = (stage === 'ready_for_pickup' || stage === 'delivered') && lastMovement(events) === 'ready_for_pickup';
  const point = atPoint ? ready?.point : undefined;

  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.wording,
    last_update: null,
    last_update_local: newest.time,
    expected_delivery: null,
    ...(point ? { pickup_point: point } : {}),
    ...(canonical ? { canonical_tracking_number: canonical } : {}),
    events: events.slice(0, MAX_EVENTS),
  };
}
