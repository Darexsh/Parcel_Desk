import { isValidS10TrackingNumber } from '../../core/detection/s10.js';
import { IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { countryTimeZone, explicitOffsetTime, mislabeledLocalTime, mislabeledWallTime, type ParsedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import type { ClassifiedStatus } from '../../core/status/index.js';
import { classifyPostnordStatus, isPostnordAdministrativeEvent } from './status.js';

export function normalizePostnordNumber(raw: string): string {
  const number = raw.toUpperCase().replace(/[\s.-]/g, '');
  if (!/^\d{10,20}$/.test(number) && !/^\d{11}SE$/.test(number) && !isValidS10TrackingNumber(number)) {
    throw new InvalidInputError('PostNord', 'PostNord requires a numeric or postal tracking number');
  }
  return number;
}

/** The milestones EN_ROUTE covers, from the sender's drop-off to the delivery in progress. */
const EN_ROUTE_STAGES = new Set(['accepted', 'in_transit', 'customs', 'out_for_delivery']);

/**
 * The scan that made the parcel available at its service point, while it waits
 * there or once it is collected there: the delivery, scanned at that same point,
 * came right after it. A parcel taken back out for delivery has a movement between.
 */
function atPickupPoint(stage: string | undefined, events: readonly CarrierEvent[]): CarrierEvent | undefined {
  if (stage === 'ready_for_pickup') return events.find((event) => event.stage === 'ready_for_pickup');
  if (stage !== 'delivered') return undefined;
  const index = events.findIndex((event) => event.stage !== 'delivered');
  const ready = events[index];
  return index > 0 && ready?.stage === 'ready_for_pickup' && ready.location
    && events.slice(0, index).every((event) => event.location === ready.location) ? ready : undefined;
}

/**
 * The service point's name, then its street and "postcode town", from the point
 * record the tracking widget shows under a parcel ready for pickup. Without that
 * record the scan's name stands alone. The receiver's address is a separate record.
 */
function pickupPoint(raw: unknown, scanned: string): string {
  const point = isRecord(raw) ? raw : {};
  const address = isRecord(point.address) ? point.address : {};
  const name = clean(point.name, 160);
  if (!name) return scanned;
  const street = clean(address.street, 120);
  const town = clean(address.city, 80);
  return street && town ? [name, street, [clean(address.postalCode, 16), town].filter(Boolean).join(' ')].join('\n') : name;
}

/** PostNord's own countries. */
const POSTNORD_COUNTRIES = new Set(['SE', 'DK', 'NO', 'FI']);
const WHOLE_MINUTE_UTC = /T\d{2}:\d{2}:00(?:\.0{1,9})?Z$/;

/**
 * The country of a scan PostNord has by EDI and gives a country and no place
 * (`locationType` UNDEF), to the minute, when its digits are that country's
 * wall clock under a Z: PostNord's own, a Danish item's transport scans at
 * 05:09 and 05:12 beside its postcentre's at 03:09 and 03:12 UTC, and the
 * origin post's, Poczta Polska's posting at 08:23 UTC as 10:23Z. A post
 * delivering abroad relays instants: Deutsche Post's scans have the minute of
 * its own tracker's. With no destination, a foreign post's scan stays as labelled.
 * A terminal's own scans carry milliseconds; one it has to the minute (`HUB`) is
 * its wall clock too: an airport terminal's scans of mail from abroad at 15:28
 * and 15:29 UTC were answered by 14:56.
 */
function relayedWallCountry(raw: Record<string, unknown>, rawTime: string, destination: string | null): string | null {
  const location = isRecord(raw.location) ? raw.location : null;
  const country = location ? clean(location.countryCode, 8) : '';
  if (!location || !/^[A-Z]{2}$/.test(country) || !WHOLE_MINUTE_UTC.test(rawTime)) return null;
  if (clean(location.name, 160)) return location.locationType === 'HUB' && POSTNORD_COUNTRIES.has(country) ? country : null;
  if (location.locationType !== 'UNDEF') return null;
  return POSTNORD_COUNTRIES.has(country) || (destination && country !== destination) ? country : null;
}

export function parsePostnord(payload: unknown, number: string): CarrierResult {
  const requested = normalizePostnordNumber(number);
  if (!isRecord(payload) || payload.shipmentId !== requested || payload.actualReturnedId !== requested
    || !Array.isArray(payload.items) || payload.items.length > 100 || !payload.items.every(isRecord)) {
    throw new SchemaError('PostNord', 'PostNord returned a different shipment or an unsupported shipment reference');
  }
  const matches = payload.items.filter((item) => item.itemId === requested);
  if (matches.length !== 1) throw new SchemaError('PostNord', 'PostNord did not return one matching item');
  const item = matches[0]!;
  if (!isRecord(item.status) || !clean(item.status.code, 64) || !Array.isArray(item.events) || item.events.length > 500) {
    throw new SchemaError('PostNord');
  }
  const destination = isRecord(payload.receiver) && isRecord(payload.receiver.address)
    && typeof payload.receiver.address.countryCode === 'string' && /^[A-Z]{2}$/.test(payload.receiver.address.countryCode)
    ? payload.receiver.address.countryCode : null;
  const rows: { raw: Record<string, unknown>; description: string; code: string; rawTime: string; labelled: ParsedTime;
    wall: { country: string; time: ParsedTime | null } | null }[] = [];
  for (const raw of item.events) {
    if (!isRecord(raw)) throw new SchemaError('PostNord', 'PostNord returned an incomplete scan row');
    const description = clean(raw.eventDescription, 500);
    const code = clean(raw.status, 64);
    const rawTime = clean(raw.eventTime, 64);
    const labelled = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)$/.test(rawTime)
      ? explicitOffsetTime(rawTime) : null;
    if (!description || !code || !labelled) throw new SchemaError('PostNord', 'PostNord returned a scan without valid wording, code or offset timestamp');
    // These confirmed notices describe messages or recipient choices rather
    // than parcel movement. A notification "delivered" is not a delivery scan.
    if (isPostnordAdministrativeEvent(code, description)) continue;
    const country = relayedWallCountry(raw, rawTime, destination);
    const zone = country ? countryTimeZone(country) : null;
    rows.push({ raw, description, code, rawTime, labelled, wall: country ? { country, time: zone ? mislabeledLocalTime(rawTime, zone) : null } : null });
  }
  // The same relayed scan can also come labelled with its instant, its wall
  // clock's offset earlier: that row keeps its label, and the two are one scan.
  const relayed = ({ code, description, wall }: (typeof rows)[number], timestamp: number) =>
    `${code}\u0000${description}\u0000${wall?.country}\u0000${timestamp}`;
  const walls = new Set(rows.flatMap((row) => (row.wall?.time ? [relayed(row, row.wall.time.timestamp)] : [])));
  const scans: { event: CarrierEvent; timestamp: number; mapped?: ClassifiedStatus }[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const { raw, description, code, rawTime, labelled, wall } = row;
    const instant = wall && walls.has(relayed(row, labelled.timestamp));
    const time = wall && !instant ? wall.time : labelled;
    // A country of several clocks keeps the wall clock; it orders by its digits.
    const local = wall && !instant && !time ? mislabeledWallTime(rawTime) : null;
    const location = isRecord(raw.location) ? clean(raw.location.name, 160) : '';
    const timestamp = time?.timestamp ?? labelled.timestamp;
    const key = `${time ? timestamp : local}\u0000${code}\u0000${description}\u0000${location}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const mapped = classifyPostnordStatus(code, description);
    scans.push({ timestamp, mapped, event: { ...(time ? { time: time.iso } : { local_time: local! }), description, provider_code: code,
      ...(location ? { location } : {}), ...(mapped ? { stage: mapped.stage } : {}) } });
  }
  if (!scans.length) throw new IndeterminateError('PostNord', 'PostNord returned no shipment history');
  // The endpoint's ascending history is displayed newest first by the widget.
  // Compare instants rather than ISO text so mixed offsets stay in order.
  if (listsNewestFirst(scans.map(({ event }) => event)) === false) scans.reverse();
  scans.sort((a, b) => b.timestamp - a.timestamp);
  const events = scans.map((scan) => scan.event);
  const code = clean(item.status.code, 64);
  const header = clean(item.status.header, 500);
  // EN_ROUTE's heading, "The shipment item is under transportation", labels every
  // milestone of the code, a drop-off by the sender among them: the newest scan
  // names the milestone.
  const newest = code === 'EN_ROUTE' && header.replace(/\.$/, '') === 'The shipment item is under transportation'
    && scans[0]!.mapped && EN_ROUTE_STAGES.has(scans[0]!.mapped.stage) ? scans[0]!.mapped : undefined;
  const mapped = newest ?? classifyPostnordStatus(code, header);
  const measurements = Array.isArray(item.measurements) ? item.measurements.filter(isRecord) : [];
  const measured = (name: string, units: string[]) => {
    const values = measurements.filter((measurement) => measurement.name === name && typeof measurement.value === 'number'
      && Number.isFinite(measurement.value) && measurement.value > 0 && units.includes(clean(measurement.unit, 16)));
    return values.length === 1 ? values[0]! : null;
  };
  const weight = measured('weight', ['kg', 'g']);
  const dimensions = ['length', 'width', 'height'].map((name) => measured(name, ['cm']));
  const delivery = mapped?.status === 'delivered' ? events.find((event) => event.stage === 'delivered') : undefined;
  // The portal names the sender, usually the shop; of the receiver's address only the country is read.
  const sender = isRecord(payload.sender) ? clean(payload.sender.name, 200) : '';
  const pickupScan = atPickupPoint(mapped?.stage, events);
  const pickup = pickupScan ? pickupPoint(payload.servicePoint, pickupScan.location ?? '') : '';
  const service = clean(payload.serviceName, 80);
  return { status: mapped?.status ?? 'unknown', ...(mapped ? { current_stage: mapped.stage } : {}),
    last_status_text: (newest ? '' : header) || events[0]!.description, last_update: events[0]!.time ?? null,
    expected_delivery: null, ...(delivery?.time ? { delivered_at: delivery.time } : {}),
    ...(sender ? { sender_name: sender } : {}), ...(pickup ? { pickup_point: pickup } : {}), ...(service ? { service_name: service } : {}),
    ...(destination ? { destination_country: destination } : {}),
    ...(weight ? { weight_kg: (weight.value as number) / (weight.unit === 'g' ? 1000 : 1) } : {}),
    ...(dimensions.every(Boolean) ? { dimensions_text: `${dimensions.map((dimension) => dimension!.value).join(' × ')} cm` } : {}),
    events: events.slice(0, 100) };
}
