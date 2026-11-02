import { DateTime } from 'luxon';
import { carrierIdFromName, carrierIdFromPartner } from '../../core/catalog/hints.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { USPS_ROUTING_BARCODE, uspsPackageIdentifier } from '../../core/detection/usps.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { direxStage } from './status.js';

export const PROVIDER = 'Direx';
// One shipment is under two kilobytes; the tracker takes up to fifty numbers at once.
export const DIREX_MAX_BYTES = 256 * 1024;
// Direx gives each parcel a ten-digit item number.
const NUMBER = /^\d{10}$/;
const CLOCK = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const MAX_SHIPMENTS = 50;
const MAX_ROWS = 200;
const MAX_EVENTS = 100;
const MOVING: ReadonlySet<string> = new Set(['registered', 'accepted', 'in_transit']);
const ENDED: ReadonlySet<string> = new Set(['delivered', 'returned']);

/** A Direx item number; anything else is not one Direx issues. */
export function normalizeDirexNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Direx item numbers are ten digits');
  return number;
}

/** An optional record; anything but an object is a changed reply. */
function part(row: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (!isRecord(value)) throw new SchemaError(PROVIDER, `Direx returned an invalid ${key}`);
  return value;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Direx returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** An identifier as a whole: a string, or an exact nonnegative integer. */
function identifier(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Direx returned an invalid ${key}`);
  return normalizeTrackingNumber(value).toUpperCase();
}

/**
 * A row's clock, `created_at` of its link to the shipment: a wall clock to the
 * second without a zone. Rows Direx copies from the partner come to the minute.
 */
function wallClock(row: Record<string, unknown>): string {
  const pivot = part(row, 'pivot');
  const raw = pivot ? text(pivot, 'created_at', 32) : '';
  const local = raw.replace(' ', 'T');
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!CLOCK.test(raw) || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'Direx returned an invalid status time');
  }
  return local;
}

/** The scans, newest first; rows with the same clock keep the reply's order between them. */
function history(shipment: Record<string, unknown>): CarrierEvent[] {
  const rows = shipment.main_statuses ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Direx returned a shipment with invalid statuses');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Direx returned an oversized history');
  const seen = new Set<string>();
  const events: { event: CarrierEvent; index: number }[] = [];
  rows.forEach((row: unknown, index) => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Direx returned an invalid status');
    const description = text(row, 'name');
    if (!description) throw new SchemaError(PROVIDER, 'Direx returned a status without its name');
    const code = text(row, 'code', 16).toUpperCase();
    const local = wallClock(row);
    const key = JSON.stringify([local, code, description]);
    if (seen.has(key)) return;
    seen.add(key);
    const staged = direxStage(code, description);
    events.push({ index, event: {
      local_time: local,
      description,
      ...(code ? { provider_code: code } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  });
  // The reply does not list the rows in time order; the page sorts them by clock as well.
  return events.sort((a, b) => (b.event.local_time as string).localeCompare(a.event.local_time as string) || b.index - a.index)
    .map(({ event }) => event);
}

/**
 * The stage the history has reached. A registration listed after the parcel
 * moved is no step back, and a delivery or return stands against transit rows
 * dated after it: Direx's own rows and those it copies from the partner can
 * keep different clocks.
 */
function current(events: CarrierEvent[]): CarrierEvent | undefined {
  const staged = events.filter((event) => event.stage);
  const newest = staged.find((event) => event.stage !== 'registered') ?? staged[0];
  const ended = staged.find((event) => ENDED.has(event.stage!));
  return ended && newest && MOVING.has(newest.stage!) ? ended : newest;
}

/** The partner's number, without the recipient's ZIP code a USPS routing barcode opens with. */
function partnerNumber(raw: string, number: string): string | undefined {
  const code = USPS_ROUTING_BARCODE.test(raw) ? uspsPackageIdentifier(raw) ?? '' : raw;
  return /^[A-Z0-9]{4,40}$/.test(code) && code !== number ? code : undefined;
}

/**
 * The carrier Direx handed the parcel to, and its number from the shipment's
 * label. The partner is named only when the catalog knows its exact name and
 * its link, if any, is its own; the number stays without a partner otherwise.
 * The link with the number filled in is never read.
 */
function partner(shipment: Record<string, unknown>, number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const label = part(shipment, 'api_label');
  const delivery = label ? partnerNumber(identifier(label, 'item'), number) : undefined;
  if (!delivery) return {};
  const service = part(shipment, 'partner_service');
  const name = service ? text(service, 'display_name', 80) : '';
  // A link alone does not name the partner: Direx links USPS parcels to the tracker of APG
  // eCommerce Solutions, the consolidator that hands them on, which is not the partner's own.
  const link = service ? text(service, 'tracking_link', 300) : '';
  const own = carrierIdFromPartner('', link) === 'apg-ecommerce' ? '' : link;
  const carrier = name && carrierIdFromName(name) ? carrierIdFromPartner(name, own) : undefined;
  return { ...(carrier && carrier !== 'direx' ? { delivery_carrier: carrier } : {}), delivery_tracking_number: delivery };
}

/** The destination as an ISO code, else by the name the reply gives. */
function destination(shipment: Record<string, unknown>): Pick<CarrierResult, 'destination_country' | 'destination_country_name'> {
  const country = part(shipment, 'country');
  if (!country) return {};
  const code = text(country, 'code', 8).toUpperCase();
  const name = text(country, 'name_en', 80) || text(country, 'name', 80);
  const iso = /^[A-Z]{2}$/.test(code) ? countryCode(code) : countryCode(name);
  return iso ? { destination_country: iso } : name ? { destination_country_name: name } : {};
}

/**
 * The reply of the tracking page's lookup, `old.direx.bg/track/multiple`, for
 * one number: an array of the shipments it found. The lookup also finds a
 * shipment by its partner's number, so only the one whose Direx number is the
 * one asked counts. An empty array is the page's unknown-number answer.
 */
export function parseDirex(payload: unknown, raw: string): CarrierResult {
  const number = normalizeDirexNumber(raw);
  if (!Array.isArray(payload)) throw new SchemaError(PROVIDER, 'Direx returned a reply that is not a list of shipments');
  if (payload.length > MAX_SHIPMENTS) throw new SchemaError(PROVIDER, 'Direx returned too many shipments');
  if (!payload.length) throw new NotFoundError(PROVIDER);
  const own = payload.filter((shipment: unknown) => {
    if (!isRecord(shipment)) throw new SchemaError(PROVIDER, 'Direx returned an invalid shipment');
    return identifier(shipment, 'tracking_code') === number;
  }) as Record<string, unknown>[];
  if (!own.length) throw new IndeterminateError(PROVIDER, 'Direx answered for another shipment');
  if (own.length > 1) throw new IndeterminateError(PROVIDER, 'Direx answered for several shipments');
  const shipment = own[0]!;

  const events = history(shipment);
  if (!events.length) throw new NoHistoryError(PROVIDER);
  const newest = events[0]!;
  const reached = current(events);
  const stage = reached?.stage as Stage | undefined;
  const product = part(shipment, 'product');
  const service = product ? text(product, 'name', 80) : '';
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: reached!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    ...(service ? { service_name: service } : {}),
    ...destination(shipment),
    ...partner(shipment, number),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
