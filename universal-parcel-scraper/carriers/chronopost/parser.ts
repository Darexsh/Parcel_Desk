import { DateTime } from 'luxon';
import { dpdParcelNumber, isValidDpdParcelNumber } from '../../core/detection/dpd.js';
import { isAnotherPostItemAtChronopost } from '../../core/detection/chronopost.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { calendarDay, countryCode, countryTimeZone, explicitOffsetTime, firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { xmlDocument, type XmlNode } from '../../core/transport/xml.js';
import { isChronopostService } from './identity.js';
import { chronopostStage, isChronopostNotification, isOtherPickupPoint, isPickupDropOff, isReturnToSender } from './status.js';

export const CHRONOPOST_MAX_BYTES = 2_000_000;
const SOAP = 'http://schemas.xmlsoap.org/soap/envelope/';
export const CHRONOPOST_NAMESPACE = 'http://cxf.tracking.soap.chronopost.fr/';
const MAX_EVENTS = 500;
const UNMOVED: ReadonlySet<Stage> = new Set(['pending', 'registered', 'accepted']);
// The DPD networks that look a Geopost reference up for a parcel Chronopost
// sends to their country.
const GEOPOST_PARTNERS: ReadonlyMap<string, string> = new Map([['DE', 'dpd-de'], ['PT', 'dpd-pt']]);

export function normalizeChronopostNumber(raw: string): string {
  const value = raw.toUpperCase().replace(/[\s.-]/g, '');
  // A DPD parcel number, with its check character or without it as notices often
  // print it: Chronopost answers either form, echoing the number as asked. Its
  // tracker also answers XN and twelve digits.
  if (!/^(?:[A-Z]{2}\d{9}[A-Z]{2}|XN\d{12})$/.test(value) && dpdParcelNumber(value) === null) {
    throw new InvalidInputError('Chronopost', 'Chronopost requires a postal-shaped identifier, an XN number or a DPD parcel number');
  }
  return value;
}

function children(node: XmlNode, name: string, uri = ''): XmlNode[] {
  return node.children.filter(child => child.name === name && child.uri === uri);
}

function one(node: XmlNode, name: string, uri = ''): XmlNode {
  const found = children(node, name, uri);
  if (found.length !== 1) throw new SchemaError('Chronopost', 'Chronopost returned an invalid tracking structure');
  return found[0]!;
}

function scalar(node: XmlNode, name: string, required = false): string {
  const found = children(node, name);
  if (found.length > 1 || found[0]?.children.length || (required && found.length !== 1)) {
    throw new SchemaError('Chronopost', 'Chronopost returned an invalid tracking field');
  }
  return found[0]?.text.trim() ?? '';
}

function clock(raw: string): { time?: string; local_time?: string; provider_time_text?: string } {
  // Reject impossible offsets that Luxon otherwise normalizes.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(raw)) {
    const parsed = explicitOffsetTime(raw);
    if (parsed) return { time: parsed.iso };
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw) && DateTime.fromISO(raw, { zone: 'UTC' }).isValid) {
    return { local_time: raw };
  }
  return raw ? { provider_time_text: clean(raw, 64) } : {};
}

/** A partner's depot, as the scan names it: "Example Town - PT (depot 0001)". */
const DEPOT = / - ([A-Z]{2}) \(depot \d{1,6}\)$/;

/**
 * A partner depot's scan carries the depot's wall clock under Paris's offset.
 * Where the depot's country keeps another clock, the scan keeps its wall clock
 * alone, for its place to date.
 */
function depotClock(raw: string, place: string): ReturnType<typeof clock> {
  const read = clock(raw);
  const zone = countryTimeZone(DEPOT.exec(place)?.[1]);
  const wall = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?[+-]/.exec(raw)?.[1];
  if (!read.time || !zone || !wall) return read;
  const paris = firstOccurrence(DateTime.fromISO(wall, { zone: 'Europe/Paris' })).offset;
  return DateTime.fromISO(raw, { setZone: true }).offset === paris && firstOccurrence(DateTime.fromISO(wall, { zone })).offset !== paris
    ? { local_time: wall } : read;
}

/** The recipient's chosen redelivery day, printed as dd/MM/yyyy. */
function redeliveryDay(value: string): string | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  return match ? calendarDay(Number(match[3]), Number(match[2]), Number(match[1])) : null;
}

/** An appointment window within one day, printed as dd/MM/yyyy HH:mm[:ss] at both ends. */
function appointmentWindow(start: string, end: string): string | null {
  const ends = [start, end].map(value => /^(\d{2})\/(\d{2})\/(\d{4}) ([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(value));
  const days = ends.map(match => match ? calendarDay(Number(match[3]), Number(match[2]), Number(match[1])) : null);
  const clocks = ends.map(match => match ? `${match[4]}:${match[5]}` : '');
  return days[0] && days[0] === days[1] && clocks[0]! < clocks[1]! ? `${days[0]} ${clocks[0]}–${clocks[1]}` : null;
}

/**
 * A relay or locker, given as `name - street - postcode - city - country`: its name, then its
 * street and town on their own lines when the address has that layout.
 */
function relayPoint(point: string): string {
  const parts = point.split(' - ').map(part => clean(part, 200));
  const name = parts[0]!;
  if (parts.length < 3 || !/\p{L}/u.test(name) || !/^[\p{L}\p{M}\p{N} .,'’&()/-]+$/u.test(name)) return '';
  const street = parts.slice(1, -3).join(' - ');
  const [postcode, city] = parts.slice(-3, -1);
  return /\p{L}/u.test(street) && /^(?=.*\d)[A-Z\d][A-Z\d -]{1,9}$/.test(postcode!) && /\p{L}/u.test(city!)
    ? `${name}\n${street}\n${postcode} ${city}` : name;
}

/**
 * Geopost's form of the skybill itself: its letters and nine digits, a service code and a
 * check character. It names no other network's parcel, unlike the reference of a partner abroad.
 */
function ownReference(reference: string, skybill: string): boolean {
  return reference === skybill || (/^[A-Z]{2}\d{9}/.test(skybill) && reference.startsWith(skybill.slice(0, 11)));
}

/** The calendar day of a scan's own clock, or '' without one. */
const clockDay = (event: CarrierEvent) => {
  const clock = event.time ?? event.local_time;
  return typeof clock === 'string' ? /^\d{4}-\d{2}-\d{2}/.exec(clock)?.[0] ?? '' : '';
};

/** Stages on the way to a planned delivery. */
const ONGOING = new Set<Stage>(['pending', 'registered', 'accepted', 'in_transit', 'customs', 'out_for_delivery']);
/** How soon a scan written again is the same scan. */
const REPEAT_MS = 2 * 60_000;

/**
 * Keep operational places, never the delivery-point address or shop contact block,
 * nor an office label that names a service ("Web Services", "Service d'avisage").
 */
function location(office: string, place: string): string {
  if (/^[\p{L}\p{M} .,'’()-]{1,100} - [A-Z]{2}(?: \(depot \d{1,6}\))?$/u.test(place)) return place;
  const shop = /^([\p{L}\p{M} .,'’-]{1,100}) - ([A-Z]{2}) - /u.exec(office);
  if (shop) return `${shop[1]}, ${shop[2]}`;
  return /^[\p{L}\p{M} .,'’()/-]{1,160}$/u.test(office) && !isChronopostService(office) ? office : '';
}

export function parseChronopostTrackingXml(xml: string, rawNumber: string): CarrierResult {
  const requested = normalizeChronopostNumber(rawNumber);
  const root = xmlDocument(xml, CHRONOPOST_MAX_BYTES);
  if (!root || root.name !== 'Envelope' || root.uri !== SOAP) {
    if (/<title>\s*Just a moment|cf-chl-|challenge-platform/i.test(xml)) throw new ChallengeError('Chronopost');
    throw new SchemaError('Chronopost', 'Chronopost returned invalid tracking XML');
  }
  const body = one(root, 'Body', SOAP);
  if (children(body, 'Fault', SOAP).length) throw new IndeterminateError('Chronopost', 'Chronopost tracking returned a SOAP fault');
  if (body.children.length !== 1) throw new SchemaError('Chronopost', 'Chronopost returned ambiguous tracking results');
  const response = one(body, 'trackSkybillV2Response', CHRONOPOST_NAMESPACE);
  const result = one(response, 'return');
  const errorCode = scalar(result, 'errorCode', true);
  if (!/^\d+$/.test(errorCode)) throw new SchemaError('Chronopost', 'Chronopost returned an invalid tracking error code');
  if (Number(errorCode) !== 0) throw new IndeterminateError('Chronopost', 'Chronopost tracking is unavailable');
  const history = one(result, 'listEventInfoComp');
  // Compare the entire identity, without truncation or accepting a linked parcel as an alias.
  const identity = scalar(history, 'skybillNumber', true).toUpperCase().replace(/[\s.-]/g, '');
  if (identity !== requested) {
    throw new SchemaError('Chronopost', 'Chronopost returned a different shipment');
  }
  const scans = children(history, 'events');
  if (!scans.length) throw new NotFoundError('Chronopost');
  if (scans.length > MAX_EVENTS) throw new SchemaError('Chronopost', 'Chronopost returned excessive tracking history');

  const references = new Set<string>();
  const geoReferences = new Set<string>();
  const destinations = new Set<string>();
  const projected = scans.map((scan, index) => {
    const description = clean(scalar(scan, 'eventLabel', true), 500);
    const code = clean(scalar(scan, 'code'), 40);
    if (!description) throw new SchemaError('Chronopost', 'Chronopost returned an empty tracking event');
    const extras = children(scan, 'infoCompList');
    let place = '';
    let redelivery: string | null | undefined;
    let start: string | undefined;
    let end: string | undefined;
    let collection = '';
    let point = '';
    let relay = '';
    for (const extra of extras) {
      const name = scalar(extra, 'name');
      const value = scalar(extra, 'value');
      if (name === 'Lieu') place = value;
      if (name === 'Date de relivraison') redelivery = redeliveryDay(value);
      if (name === 'Début créneau RDV') start = value;
      if (name === 'Fin créneau RDV') end = value;
      if (name === 'Type de retrait') collection = value;
      if (name === 'Point de retrait') relay = value;
      if (name === 'Numéro partenaire') {
        const match = /^(?:GEO\/)?([A-Z0-9]{4,40})$/.exec(value.toUpperCase());
        if (match && !ownReference(match[1]!, requested)) {
          references.add(match[1]!);
          if (value.toUpperCase().startsWith('GEO/') && isValidDpdParcelNumber(match[1]!)) geoReferences.add(match[1]!);
        }
      }
      if (name === 'Point de livraison') {
        // Only the terminal country and a pickup point are projected.
        point = value;
        const country = countryCode(/ - ([A-Z]{2})$/.exec(value)?.[1]);
        if (country) destinations.add(country);
      }
    }
    const at = location(scalar(scan, 'officeLabel'), place);
    const event: CarrierEvent = {
      ...depotClock(scalar(scan, 'eventDate'), at),
      description,
      location: at,
      ...(code ? { provider_code: code } : {}),
    };
    const mapped = chronopostStage(code, description);
    return { event, mapped, notification: isChronopostNotification(description), index, redelivery,
      appointment: start === undefined && end === undefined ? undefined : appointmentWindow(start ?? '', end ?? ''),
      dropOff: isPickupDropOff(code, description), returnStart: isReturnToSender(code, description),
      otherPoint: isOtherPickupPoint(code, description),
      // A delivery point is a relay only when the scan names how it is collected.
      pickup: relay ? relayPoint(relay) : collection && point ? relayPoint(point) : '' };
  });
  // The operation returns oldest first. Reorder only when all scan clocks
  // establish instants, so mixed local clocks cannot create a guessed order.
  if (projected.every(scan => explicitOffsetTime(scan.event.time))) {
    projected.sort((left, right) => explicitOffsetTime(left.event.time)!.timestamp
      - explicitOffsetTime(right.event.time)!.timestamp || left.index - right.index);
  }
  let stage: Stage = 'pending';
  let stageSource = 'none';
  let pickupPoint = '';
  let deliveredAt: string | undefined;
  let returning = false;
  for (const scan of projected) {
    // An alert or an instruction records activity, but does not regress delivery or prove
    // movement. Nor does a drop-off scan that follows the pickup point's arrival scan.
    const kept = scan.notification || (scan.dropOff && stage === 'ready_for_pickup');
    // Once the parcel starts back to the sender, the scans that follow are the return's,
    // and a delivery reaches the sender.
    returning ||= scan.returnStart;
    // Before the parcel has moved, a pickup point's scan of it at another point than the one
    // planned is the sender's drop-off there: the point hands the parcel to the courier next.
    const mapped: ClassifiedWording = scan.otherPoint && UNMOVED.has(stage) ? { stage: 'accepted' as const, source: 'carrier_map' }
      : returning && scan.mapped.stage === 'delivered' ? { ...scan.mapped, stage: 'returned' as const } : scan.mapped;
    if (!kept && mapped.source !== 'none') {
      stage = mapped.stage;
      stageSource = mapped.source;
      pickupPoint = stage === 'ready_for_pickup' ? scan.pickup : '';
      if (stage === 'delivered') deliveredAt = scan.event.time;
    }
    scan.event.stage = kept ? stage : mapped.stage;
    scan.event.stage_source = kept ? 'none' : mapped.source;
  }
  // The newest scan that names a redelivery day or an appointment window
  // decides, even when its value is unreadable; a redelivery day replaces the
  // window on the same scan. A later scan that is not progress towards that
  // delivery, or that falls on a later day, ends it.
  let promised: string | null = null;
  for (const scan of projected) {
    if (scan.redelivery !== undefined) promised = scan.redelivery;
    else if (scan.appointment !== undefined) promised = scan.appointment;
    else if (promised && (clockDay(scan.event) > promised.slice(0, 10)
      || (!scan.notification && !ONGOING.has(scan.mapped.stage)))) {
      promised = null;
    }
  }
  // Chronopost can write a scan twice, under one code or two, seconds to a minute apart: the
  // arrival at the pickup point, a sort at the depot, a notice. In the same words at the same
  // place, it is one scan.
  const shown = projected.filter((scan, index) => {
    const before = projected[index - 1];
    if (!before) return true;
    const [earlier, later] = [explicitOffsetTime(before.event.time), explicitOffsetTime(scan.event.time)];
    return !earlier || !later || later.timestamp - earlier.timestamp >= REPEAT_MS || later.timestamp < earlier.timestamp
      || scan.event.description !== before.event.description || scan.event.location !== before.event.location;
  });
  const events = shown.reverse().slice(0, 100).map(scan => scan.event);
  const latest = events[0]!;
  const reference = references.size === 1 ? [...references][0] : undefined;
  const destination = destinations.size === 1 ? [...destinations][0] : undefined;
  // The typed Geopost reference and a destination whose DPD network delivers
  // Chronopost's parcels propose a national lookup. The downstream adapter
  // must still confirm ownership and activity.
  const partner = reference && geoReferences.has(reference) && destination ? GEOPOST_PARTNERS.get(destination) : undefined;
  return {
    status: languageStageStatus(stage),
    current_stage: stage,
    current_stage_source: stageSource,
    last_status_text: latest.description,
    last_update: latest.time ?? null,
    ...(!latest.time && latest.local_time ? { last_update_local: latest.local_time } : {}),
    expected_delivery: returning || ['delivered', 'returned', 'ready_for_pickup'].includes(stage) ? null : promised,
    ...(stage === 'delivered' && deliveredAt ? { delivered_at: deliveredAt } : {}),
    ...(pickupPoint ? { pickup_point: pickupPoint } : {}),
    ...(reference ? { delivery_tracking_number: reference } : {}),
    ...(partner ? { delivery_carrier: partner } : !reference && isAnotherPostItemAtChronopost(requested) ? { delivery_carrier: 'la-poste' } : {}),
    ...(destination ? { destination_country: destination } : {}),
    events,
  };
}
