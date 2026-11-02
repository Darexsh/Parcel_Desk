import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { carrierIdFromName, carrierIdFromPartner } from '../../core/catalog/hints.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { USPS_ROUTING_BARCODE, uspsPackageIdentifier } from '../../core/detection/usps.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence, usStateTimeZone } from '../../core/time/index.js';
import { cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { epostGlobalFacilityScan, epostGlobalStage } from './status.js';

export const PROVIDER = 'ePost Global';
// A delivered parcel's reply is up to a hundred kilobytes: its history twice,
// as data and as rendered rows.
export const EPOST_GLOBAL_MAX_BYTES = 1024 * 1024;
// EPG and ten to fifteen digits; current labels print fifteen.
const NUMBER = /^(?:EPG\d{10,15}|[A-Z]{2}\d{9}US)$/;
// The page's call that shows a card's details: its scans, the card's index,
// the number asked, the partner's number and the shipment's details.
const CALL = /^transactionDetails\('(.*?)','(\d+)','([^']*)', '([^']*)', '(.*)'\)$/s;
// The tracker's notice on the card of a number it has no shipment for.
const NOT_TRACKED = /We haven.t received any tracking updates/;
// A browser check, which the site has not been seen to send.
const CHALLENGE = /captcha|cf-turnstile|_cf_chl_opt|<title>\s*(?:Just a moment|Attention Required)/i;
const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,7})?$/;
// A processing center's place: its town and state ("Itasca IL").
const FACILITY = /^[A-Za-z][A-Za-z .'-]{0,60} ([A-Z]{2})$/;
// States split between zones, where the state does not tell the clock.
const SPLIT_STATES = new Set(['AK', 'FL', 'ID', 'IN', 'KS', 'KY', 'MI', 'ND', 'NE', 'NV', 'OR', 'SD', 'TN', 'TX']);
// Partners whose names the catalog does not know. Spring's PostNL service is
// tracked by spring-gds under the same number.
const VENDORS: ReadonlyMap<string, string> = new Map([['SPRING POST NL', 'spring-gds']]);
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** An ePost Global number; anything else is a number the tracker is not asked for. */
export function normalizeEpostGlobalNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'ePost Global numbers are EPG and ten to fifteen digits, or a USPS code ending in US');
  return number;
}

/** An optional text field; an object or array is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 500): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' && typeof value !== 'number') throw new SchemaError(PROVIDER, `ePost Global returned an invalid ${key}`);
  return cleanScalar(value, maxLength);
}

/**
 * A scan's place up to its first word holding a digit, where partners put a
 * postcode, a depot number or a street address. A dash is no place, and a
 * country named twice is named once.
 */
function placeOf(raw: string): string {
  const words: string[] = [];
  for (const word of raw.split(' ')) {
    if (/\d/.test(word)) break;
    words.push(word);
  }
  const parts = words.join(' ').split(',').map((part) => part.trim()).filter(Boolean);
  const place = parts.filter((part, index) => part !== parts[index - 1]).join(', ');
  return /^[-.\s]*$/.test(place) ? '' : place;
}

/** The zone of a processing center's scan: the clock of the center's state. */
function facilityZone(description: string, place: string): string | null {
  if (!epostGlobalFacilityScan(description)) return null;
  const state = FACILITY.exec(place)?.[1];
  return state && !SPLIT_STATES.has(state) ? usStateTimeZone(state) : null;
}

/** A scan's clock: an instant in the center's zone, else the wall clock as stamped. */
function clockOf(stamp: string, zone: string | null): { time: string } | { local_time: string } {
  const wall = WALL_CLOCK.exec(stamp)?.[1];
  if (!wall || !DateTime.fromISO(wall, { zone: 'utc' }).isValid) {
    throw new SchemaError(PROVIDER, 'ePost Global returned an invalid scan time');
  }
  if (!zone) return { local_time: wall };
  const time = firstOccurrence(DateTime.fromISO(wall, { zone })).toISO({ suppressMilliseconds: true });
  if (!time) throw new SchemaError(PROVIDER, 'ePost Global returned an invalid scan time');
  return { time };
}

function projectScan(row: unknown): { key: string; event: CarrierEvent } | null {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'ePost Global returned an invalid scan');
  const description = text(row, 'Event');
  if (!description) return null;
  const stamp = text(row, 'EventDT', 64);
  const place = placeOf(text(row, 'Loc', 200));
  const code = text(row, 'ECode', 32);
  const staged = epostGlobalStage(description, code);
  const event: CarrierEvent = {
    ...clockOf(stamp, facilityZone(description, place)),
    description,
    ...(place ? { location: place } : {}),
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([stamp, description, place, code]), event };
}

/** The delivering partner: one the catalog knows by name, whose link, if any, is its own. */
function deliveryPartner(vendor: string, url: string): string | undefined {
  const mapped = VENDORS.get(vendor.toUpperCase());
  if (mapped) return mapped;
  const named = vendor ? carrierIdFromName(vendor) : undefined;
  return named && named !== 'epost-global' && carrierIdFromPartner(vendor, url) === named ? named : undefined;
}

/** The partner's number, without the recipient's ZIP code a USPS routing barcode opens with. */
function partnerNumber(raw: string, number: string): string | undefined {
  const compact = normalizeTrackingNumber(raw);
  const code = USPS_ROUTING_BARCODE.test(compact) ? uspsPackageIdentifier(compact) ?? '' : compact;
  return /^[A-Z0-9]{4,40}$/.test(code) && code !== number ? code : undefined;
}

/**
 * The HTML fragment `POST /TrackingShipment/ShipmentData` answers: one card
 * per number asked, whose click handler carries the shipment's details as
 * JSON. The tracker also finds a shipment by its partner's number, so the
 * details count only when their own number is the one asked for. The
 * recipient's postcode, the scans' ZIP codes, the master air waybill and the
 * customer reference are never read.
 */
export function parseEpostGlobal(html: string, raw: string): CarrierResult {
  const number = normalizeEpostGlobalNumber(raw);
  const $ = load(html);
  const cards = $('div[id^="tracking-card"]');
  if (!cards.length) {
    if (CHALLENGE.test(html)) throw new ChallengeError(PROVIDER, 'ePost Global answered with a browser check');
    throw new SchemaError(PROVIDER, 'ePost Global returned a page without a shipment card');
  }
  if (cards.length > 1) throw new SchemaError(PROVIDER, 'ePost Global returned several shipments');
  const call = CALL.exec(cards.attr('onclick') ?? '');
  if (!call) throw new SchemaError(PROVIDER, 'ePost Global returned a card without its details');
  if (normalizeTrackingNumber(call[3]!) !== number) throw new SchemaError(PROVIDER, 'ePost Global answered for another number');
  if (!call[5]) {
    if (NOT_TRACKED.test(cards.text())) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'ePost Global returned a card without details');
  }

  let details: unknown;
  try {
    details = JSON.parse(call[5]);
  } catch (cause) {
    throw new SchemaError(PROVIDER, 'ePost Global returned details that are not JSON', { cause });
  }
  if (!isRecord(details)) throw new SchemaError(PROVIDER, 'ePost Global returned invalid details');
  const track = normalizeTrackingNumber(text(details, 'Track', 64));
  if (normalizeTrackingNumber(text(details, 'Ref', 64)) !== number) {
    // Found by another number of the shipment: its partner's, which is not ePost Global's own.
    if (track === number) throw new IndeterminateError(PROVIDER, 'ePost Global found another shipment by its partner number');
    throw new SchemaError(PROVIDER, 'ePost Global returned another shipment');
  }
  const rows = details.Events;
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'ePost Global returned a shipment without scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'ePost Global returned an oversized history');

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    const scan = projectScan(row);
    if (!scan || seen.has(scan.key)) continue;
    seen.add(scan.key);
    events.push(scan.event);
  }
  if (!events.length) throw new IndeterminateError(PROVIDER, 'ePost Global has no scans for the shipment yet');

  // The reply lists scans newest first by their stamps. Partner clocks are not
  // instants, so its order stands. A receipt after the parcel moved on is the
  // partner's, not its acceptance.
  let moved = false;
  for (const event of [...events].reverse()) {
    const stage = event.stage as Stage | undefined;
    if (stage === 'accepted' && moved) Object.assign(event, { stage: 'in_transit', stage_source: 'carrier_map' });
    if (stage && !['registered', 'accepted', 'exception'].includes(stage)) moved = true;
  }
  const newest = events[0]!;
  // A partner's announcement after ePost Global shipped the parcel is no step back.
  const current = events.find((event) => event.stage && event.stage !== 'registered') ?? events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const partner = deliveryPartner(text(details, 'Vendor', 80),
    text(details, 'VendorTrackingUrl', 500) || text(details, 'VendorBaseUrl', 500));
  const delivery = partnerNumber(track, number);
  const country = text(details, 'DC', 8).toUpperCase();
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    ...(partner ? { delivery_carrier: partner } : {}),
    ...(delivery ? { delivery_tracking_number: delivery } : {}),
    ...(/^[A-Z]{2}$/.test(country) ? { destination_country: country } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
