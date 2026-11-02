import { DateTime } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { EXPLICIT_OFFSET_PATTERN, firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord, type JsonObject } from '../../core/types.js';
import { todayStateStage } from './status.js';

export const PROVIDER = 'To-Day';
// A page with a long route is under twenty kilobytes.
export const TODAY_MAX_BYTES = 512 * 1024;
const ZONE = 'Asia/Seoul';
// What the page's search box takes, without the sixteen-digit numbers of its
// demonstration for delivery partners. Thirteen characters can be the number
// a partner gave the parcel, such as a Korea Post EMS number.
const NUMBER = /^(?:\d{12,13}|[A-Z]{2}\d{9}[A-Z]{2})$/;
const MAX_STATIONS = 50;
const NEXT_DATA = /<script id="__NEXT_DATA__" type="application\/json"[^>]*>([\s\S]*?)<\/script>/;
const PAGE_TYPES = new Set(['NORMAL', 'LM_COLLECT', 'ERROR']);
// The names the page gives a route's end when it is the sender's or the recipient's address.
const ADDRESS_ENDS = new Set(['수거지', '접수지', '도착지', '반품지']);
// A shipper's own pickup point, which carries the shipper's name.
const SHIPPER_POINT = 'CLIENT_COLLECT';
// Routes that end at the recipient's door rather than at a station.
const TO_DOOR = new Set(['STATION_TO_LM', 'LM_TO_LM']);
// The partners To-Day's own code links for a parcel handed on, with the numbers each issues.
const PARTNERS: ReadonlyMap<string, { carrier: string; issues: (number: string) => boolean }> = new Map([
  ['HANJIN', { carrier: 'hanjin', issues: (number: string) => /^(?:\d{12}|\d{14})$/.test(number) }],
  ['CJ', { carrier: 'cj-logistics', issues: (number: string) => /^\d{10}(?:\d{2})?$/.test(number) }],
  ['EMS', { carrier: 'korea-post', issues: (number: string) => number.endsWith('KR') && isValidS10TrackingNumber(number) }],
]);

export type TodayPageType = 'NORMAL' | 'LM_COLLECT' | 'ERROR';

/** A number To-Day's tracker takes, without spaces or hyphens; anything else is not one it issues. */
export function normalizeTodayNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'To-Day waybills are twelve digits');
  return number;
}

/**
 * The sealed lookup the tracking page carries in its Next.js data, or null for
 * a page without that data. The server looks the number up and seals the
 * answer; the page's script opens it.
 */
export function todayPage(html: string): { type: TodayPageType; sealed: string } | null {
  const script = NEXT_DATA.exec(html)?.[1];
  if (script === undefined) return null;
  let data: unknown;
  try {
    data = JSON.parse(script);
  } catch (cause) {
    throw new SchemaError(PROVIDER, 'To-Day returned page data that is not JSON', { cause });
  }
  const props = isRecord(data) && isRecord(data.props) ? data.props.pageProps : undefined;
  if (!isRecord(props) || typeof props.type !== 'string' || !PAGE_TYPES.has(props.type)) {
    throw new SchemaError(PROVIDER, 'To-Day returned a page without its lookup');
  }
  const sealed = props.type === 'ERROR' ? props.error : props.result;
  if (typeof sealed !== 'string' || !sealed) throw new SchemaError(PROVIDER, 'To-Day returned a page without its lookup');
  return { type: props.type as TodayPageType, sealed };
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: JsonObject, key: string, maxLength = 120): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `To-Day returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * A time of the reply, to the second. The service writes Korea's offset; a
 * time without one is read on Korea's single clock, which has no daylight
 * saving.
 */
function instant(row: JsonObject, key: string): DateTime | null {
  const value = row[key];
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 64 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
    throw new SchemaError(PROVIDER, `To-Day returned an invalid ${key}`);
  }
  const parsed = EXPLICIT_OFFSET_PATTERN.test(value)
    ? DateTime.fromISO(value, { setZone: true })
    : firstOccurrence(DateTime.fromISO(value, { zone: ZONE }));
  if (!parsed.isValid) throw new SchemaError(PROVIDER, `To-Day returned an invalid ${key}`);
  return parsed.setZone(ZONE).startOf('second');
}

interface Station {
  name: string;
  shipperPoint: boolean;
  arrival: DateTime | null;
  departure: DateTime | null;
}

function stations(steps: JsonObject): Station[] {
  const rows = steps.logs ?? [];
  if (!Array.isArray(rows) || rows.length > MAX_STATIONS) throw new SchemaError(PROVIDER, 'To-Day returned an invalid route');
  return rows.map((row) => {
    if (!isRecord(row) || !isRecord(row.station)) throw new SchemaError(PROVIDER, 'To-Day returned an invalid station');
    return {
      name: text(row.station, 'name', 80),
      shipperPoint: text(row.station, 'type', 40) === SHIPPER_POINT,
      arrival: instant(row, 'arrivalTime'),
      departure: instant(row, 'departureTime'),
    };
  });
}

/** The stations the page lists between a route's two ends, which it shows apart. */
function listed(route: Station[], shippingType: string): Station[] {
  switch (shippingType) {
    case 'STATION_TO_STATION': return route.slice(1, -1);
    case 'LM_TO_STATION': return route.slice(0, -1);
    case 'STATION_TO_LM': return route.slice(1);
    default: return route;
  }
}

interface Scan {
  at: DateTime;
  description: string;
  location: string;
  stage: Stage;
  order: number;
}

/**
 * The history the page draws: the pickup, the arrival at and departure from
 * each station it lists, the steps of its progress rail no row already dates,
 * and the delivery. The departure from the last station of a route that ends
 * at the door is the rail's start of delivery. A route's first station, which
 * the page folds into the pickup, adds its arrival when that came later.
 */
function scans(data: JsonObject, load: JsonObject): Scan[] {
  if (!isRecord(data.steps)) throw new SchemaError(PROVIDER, 'To-Day returned a shipment without its route');
  const steps = data.steps;
  const shippingType = text(steps, 'shippingType', 40) || text(load, 'shippingType', 40);
  const route = stations(steps);
  const place = (station: Station | undefined) => (station && !station.shipperPoint ? station.name : '');
  const end = (title: string, station: Station | undefined) => (ADDRESS_ENDS.has(title) || station?.shipperPoint ? '' : title);
  const found: Scan[] = [];
  let order = 0;
  const add = (at: DateTime | null, description: string, location: string, stage: Stage) => {
    if (at) found.push({ at, description, location, stage, order: order++ });
  };

  const source = isRecord(steps.source) ? steps.source : {};
  const pickedUp = instant(source, 'time');
  // A route from a station heads the pickup with that station, but a parcel
  // picked up elsewhere reaches it later.
  const first = shippingType.startsWith('STATION_TO_') && route[0] && !route[0].shipperPoint ? route[0] : undefined;
  const reached = first?.arrival && pickedUp && +first.arrival > +pickedUp ? first.arrival : null;
  add(pickedUp, text(source, 'actionName', 20) || '픽업', reached ? '' : end(text(source, 'title', 80), route[0]), 'accepted');
  add(reached, '도착', place(first), 'in_transit');
  for (const station of listed(route, shippingType)) {
    add(station.arrival, '도착', place(station), 'in_transit');
    add(station.departure, '출발', place(station), 'in_transit');
  }
  const progress = isRecord(data.progress) ? data.progress : null;
  if (progress) {
    const started = instant(progress, 'deliveryStartTime');
    if (started && TO_DOOR.has(shippingType)) {
      const left = found.findIndex((scan) => scan.description === '출발' && +scan.at === +started);
      const location = left >= 0 ? found.splice(left, 1)[0]!.location : place(route.at(-1));
      add(started, '배송중', location, 'out_for_delivery');
    }
    const shipped = instant(progress, 'shippingTime');
    if (shipped && !found.some((scan) => +scan.at === +shipped)) add(shipped, '배송시작', '', 'in_transit');
  }
  const destination = isRecord(steps.destination) ? steps.destination : {};
  const delivered = instant(destination, 'deliveryTime') ?? (progress ? instant(progress, 'deliveryTime') : null);
  add(delivered, '배송완료', end(text(destination, 'title', 80), route.at(-1)), 'delivered');
  return found;
}

/** The partner a parcel was handed on to, when the reply names one the page links and its number fits. */
function handoff(load: JsonObject, order: unknown): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const info = isRecord(load.forwardingInfo) ? load.forwardingInfo
    : isRecord(order) && isRecord(order.forwardingInfo) ? order.forwardingInfo : null;
  if (!info) return {};
  const partner = PARTNERS.get(clean(info.deliveryOrganizationName, 40).toUpperCase());
  const number = normalizeTrackingNumber(clean(info.invoiceNumber, 40));
  return partner?.issues(number) ? { delivery_carrier: partner.carrier, delivery_tracking_number: number } : {};
}

/** An answer without a shipment: the number is unknown, or its details were removed. */
function refusal(data: JsonObject, number: string): never {
  if (data.type !== 'NOT_FOUND' && data.type !== 'EXPIRED') throw new SchemaError(PROVIDER, 'To-Day returned an unknown answer');
  const echoed = typeof data.invoiceNumber === 'string' ? normalizeTrackingNumber(data.invoiceNumber) : '';
  if (echoed !== number) throw new IndeterminateError(PROVIDER, 'To-Day answered for another number');
  if (data.type === 'EXPIRED') {
    throw new IndeterminateError(PROVIDER, 'To-Day removes a parcel\'s details three months after its delivery', { reason: 'history_expired' });
  }
  throw new NotFoundError(PROVIDER);
}

/**
 * The opened lookup of the tracking page for one number. A shipment must carry
 * the number asked, as To-Day's own waybill or as the number the page shows
 * for it, such as the shipper's. Names, phone numbers, coordinates, products
 * and the driver are left behind.
 */
export function parseToday(type: TodayPageType, data: unknown, raw: string): CarrierResult {
  const number = normalizeTodayNumber(raw);
  if (!isRecord(data)) throw new SchemaError(PROVIDER, 'To-Day returned an invalid reply');
  if (type === 'ERROR') refusal(data, number);
  if (!isRecord(data.sanitizedLoad)) throw new SchemaError(PROVIDER, 'To-Day returned a reply without its shipment');
  const load = data.sanitizedLoad;
  const own = [load.invoiceNumber, load.displayInvoiceNumber].filter((value) => typeof value === 'string')
    .map((value) => normalizeTrackingNumber(value));
  if (!own.length) throw new SchemaError(PROVIDER, 'To-Day returned a shipment without its number');
  if (!own.includes(number)) throw new IndeterminateError(PROVIDER, 'To-Day answered for another shipment');

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  const found = scans(data, load).sort((a, b) => +b.at - +a.at || b.order - a.order);
  for (const scan of found) {
    const time = scan.at.toISO({ suppressMilliseconds: true })!;
    const key = JSON.stringify([time, scan.description, scan.location]);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push({ time, ...(scan.location ? { location: scan.location } : {}), description: scan.description,
      stage: scan.stage, stage_source: 'carrier_map' });
  }

  // The page's state for a regular parcel; a pickup or return has only the load's.
  const state = type === 'NORMAL' ? text(data, 'state', 40) : '';
  const loadState = text(load, 'state', 40);
  const held = state === 'HOLDING_DELIVERY' || (!state && loadState === 'HOLDING_DELIVERY');
  const delivered = events.find((event) => event.stage === 'delivered');
  const stage: Stage = held ? 'failed_attempt'
    : delivered ? 'delivered'
    : loadState === 'LOST' || loadState === 'QUIT' ? 'exception'
    : todayStateStage(state) ?? (loadState === 'IN_DELIVERY' ? 'out_for_delivery' : undefined)
      ?? (events[0]?.stage as Stage | undefined) ?? 'registered';
  // The headline names why a delivery was held, with its emphasis marks, and is
  // what the page says for a parcel without a scan.
  const headline = clean(text(data, 'title', 200).replace(/[<>]/g, ''));
  const heading = type === 'LM_COLLECT'
    ? (text(load, 'deliveryClass', 40) === 'RETURNING' ? '반품 접수가 완료되었어요' : '수거 접수가 완료되었어요')
    : headline;
  return {
    status: languageStageStatus(stage),
    current_stage: stage,
    current_stage_source: 'carrier_map',
    last_status_text: (held && headline) || events[0]?.description || heading || null,
    ...(!events.length && state ? { provider_code: state } : {}),
    last_update: events[0]?.time ?? null,
    delivered_at: stage === 'delivered' ? delivered?.time ?? null : null,
    ...handoff(load, data.sanitizedOrder),
    events,
  };
}
