/**
 * DHL eCommerce, through its anonymous Americas Webtrack API first, then
 * the global tracking page's UTAPI for shipments outside Webtrack's scope.
 *
 * DHL may answer with a customer-confirmation id instead of the queried
 * alias, so only one eCommerce shipment from that exact request URL is
 * accepted, and the id itself is never retained.
 */

import { DateTime } from 'luxon';
import { accepted, lookupBudget, recognizeFromBrowserLookup, recognizeFromLookup, type AdapterFactory, type Recognition, type TrackingContext } from '../../core/adapter/index.js';
import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { USPS_ROUTING_BARCODE, uspsPackageIdentifier } from '../../core/detection/usps.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError, type CarrierErrorOptions } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { runSteps, singleFlight, takeTurn } from '../../core/runner/index.js';
import { countryCode, countryTimeZone, firstOccurrence, usStateTimeZone } from '../../core/time/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { clean as cleanText, fetchBounded, parseJsonBytes, UpstreamHttpError, UpstreamNetworkError, userAgentOf } from '../../core/transport/index.js';
import { scrapeUniversalPage, type UniversalBrowserOptions } from '../../core/transport/browser.js';
import { isRecord, type JsonObject } from '../../core/types.js';
import { isMissingShipment } from '../dhl-express/api.js';
import { partnerHasParcel, stageFor, statusFor } from './status.js';

const PROVIDER = 'DHL eCommerce';
const API = 'https://www.dhl.com/utapi';
const WEBTRACK_API = 'https://api.dhlecs.com/webtrack/v4/tracking';
const DIRECT_TIMEOUT_MS = 15_000;
const POUNDS_TO_KG = 0.453_592_37;
/**
 * Webtrack's names for the last-mile partner; `MIRROR` means DHL delivers itself. Another
 * name is read with its link, as other partner names are.
 */
const WEBTRACK_PARTNERS: Readonly<Record<string, string>> = { USPS: 'usps', DAI_DIRECT: 'dai-post' };
/** Statuses DHL answers with while its challenge is unsolved. */
const CHALLENGE_STATUSES = [401, 403, 419, 428];

function browserRecoveryAllowed(error: unknown): boolean {
  return error instanceof ChallengeError || error instanceof UpstreamNetworkError
    || error instanceof UpstreamHttpError && error.status >= 500
    || error instanceof IndeterminateError && ['webtrack_not_found', 'webtrack_no_history'].includes(error.reason ?? '');
}

/**
 * UTAPI strings occasionally carry markup. Tags are dropped without a
 * separator, as this adapter has always done, before the shared cleaner
 * collapses whitespace and caps the length.
 */
function clean(value: unknown, limit = 500): string {
  return typeof value === 'string' ? cleanText(value.replace(/<[^>]*>/g, ''), limit) : '';
}

function cleanNumber(raw: string): string {
  return raw.toUpperCase().replace(/[\s.-]/g, '');
}

/**
 * The number DHL is asked for. A USPS routing barcode opens with the
 * recipient's ZIP code; Webtrack also knows the package by the identifier
 * after it, so only that identifier is sent, and a barcode without a single
 * one is not sent at all. Webtrack also finds a package by the shipper's own
 * package id, so a number shorter than DHL's own identifiers is not sent: a
 * short one names some shipper's package, not necessarily the reader's.
 */
export function normalizeDHLEcommerceNumber(raw: string): string {
  const number = cleanNumber(raw);
  if (!/^(?=.*\d)[A-Z0-9]{10,40}$/.test(number)) throw new InvalidInputError(PROVIDER, 'DHL eCommerce tracking number is invalid');
  if (!USPS_ROUTING_BARCODE.test(number)) return number;
  const pic = uspsPackageIdentifier(number);
  if (!pic) throw new InvalidInputError(PROVIDER, 'A USPS routing barcode without a single package identifier is not sent');
  return pic;
}

export function dhlEcommerceTrackingUrl(number: string): string {
  return `https://www.dhl.com/ch-en/home/tracking.html?tracking-id=${normalizeDHLEcommerceNumber(number)}&submit=1`;
}

function address(event: JsonObject): JsonObject {
  const location = isRecord(event.location) ? event.location : {};
  return isRecord(location.address) ? location.address : {};
}

// UTAPI returns local wall-clock timestamps, sometimes without countryCode.
// Resolve only unambiguous locations; never treat an unknown local time as UTC.
const HUB_ZONES: Record<string, string> = {
  'melrose park, il, us': 'America/Chicago', 'hebron, ky, us': 'America/New_York',
  'lahr': 'Europe/Berlin', 'staufenberg': 'Europe/Berlin',
};

/** The offsets a wall clock has in a zone: none in a skipped hour, two in a repeated one. */
function wallOffsets(raw: string, zone: string): number[] {
  const parsed = firstOccurrence(DateTime.fromISO(raw, { zone }));
  if (!parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== raw.slice(0, 19)) return [];
  return parsed.getPossibleOffsets().map((candidate) => candidate.offset);
}

/** A wall clock the zone skips or repeats at a clock change has no single instant. */
function zonedInstant(raw: string, zone: string): string | null {
  if (wallOffsets(raw, zone).length !== 1) return null;
  const parsed = firstOccurrence(DateTime.fromISO(raw, { zone }));
  return parsed.isValid ? parsed.toUTC().toISO() : null;
}

/**
 * A UTAPI clock: its own offset, else the wall clock read in the zone of the
 * event's country or an identified hub, as an instant in UTC. A local policy
 * rather than one from `core/time`, since UTAPI legs cross zones. A wall clock
 * without a zone, or one that zone skips or repeats at a clock change, stays
 * local, as Webtrack's do.
 */
function utapiClock(event: JsonObject): { time?: string; local_time?: string } | null {
  const raw = clean(event.timestamp, 64);
  // A wall clock, alone or with an offset of at most fourteen hours.
  const match = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(Z|[+-](0\d|1[0-4])(?::?([0-5]\d))?)?$/.exec(raw);
  if (!match) return null;
  if (match[1]) {
    if (Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0) > 840) return null;
    const parsed = DateTime.fromISO(raw, { zone: 'UTC', setZone: true });
    return parsed.isValid ? { time: parsed.toUTC().toISO() } : null;
  }
  const place = address(event);
  const locality = clean(place.addressLocality, 160);
  const country = clean(place.countryCode).toUpperCase();
  const zone = countryTimeZone(country) ?? countryTimeZone(locality) ?? HUB_ZONES[locality.toLowerCase()];
  // UTC validates the digits only; the wall clock is then read in the place's zone.
  const wall = DateTime.fromISO(raw, { zone: 'UTC' });
  if (!wall.isValid) return null;
  const instant = zone ? zonedInstant(wall.toISO({ includeOffset: false }), zone) : null;
  return instant ? { time: instant } : { local_time: wall.toISO({ includeOffset: false, suppressMilliseconds: true }) };
}

/** The locality, then the country unless the locality already ends with it ("Hebron, KY, US"). */
function utapiLocation(place: JsonObject): string {
  const locality = clean(place.addressLocality, 160);
  const country = clean(place.countryCode, 2);
  const last = locality.split(',').at(-1)!.trim();
  return country && last.toUpperCase() !== country.toUpperCase() ? [locality, country].filter(Boolean).join(', ') : locality;
}

/** Only call for the response to the exact requested UTAPI URL. DHL can return
 * a customer-confirmation id which differs from every queried parcel alias. */
export function parseDHLEcommerceResponse(payload: unknown): CarrierResult {
  if (!isRecord(payload) || !Array.isArray(payload.shipments)) throw new SchemaError(PROVIDER, 'DHL eCommerce returned an invalid tracking response');
  if (payload.shipments.length !== 1 || !isRecord(payload.shipments[0])) {
    throw new SchemaError(PROVIDER, 'DHL eCommerce did not return one unambiguous shipment');
  }
  const shipment = payload.shipments[0];
  if (!clean(shipment.id)) throw new SchemaError(PROVIDER, 'DHL eCommerce returned a shipment without an identifier');
  if (shipment.service !== 'ecommerce') throw new SchemaError(PROVIDER, 'This shipment is not handled by DHL eCommerce');
  if (!isRecord(shipment.status) || !clean(shipment.status.description)) throw new SchemaError(PROVIDER, 'DHL eCommerce returned no tracking status');
  if (!Array.isArray(shipment.events) || shipment.events.length > 500) throw new SchemaError(PROVIDER, 'DHL eCommerce returned invalid tracking events');
  const events: CarrierEvent[] = shipment.events.filter(isRecord).flatMap((event) => {
    const clock = utapiClock(event);
    const description = clean(event.description);
    if (!clock || !description) return [];
    const place = address(event);
    const stage = stageFor(event);
    return [{ ...clock, description: stage === 'delivered' ? 'Delivered' : description, location: utapiLocation(place), stage }];
  });
  // UTAPI lists scans newest first. Its order stands unless every scan has an instant.
  if (events.every((event) => event.time)) events.sort((left, right) => right.time!.localeCompare(left.time!));
  events.splice(100);
  const stage = shipment.returnFlag === true && shipment.status.statusCode === 'delivered'
    ? 'returned' : stageFor(shipment.status);
  const expected = clean(shipment.estimatedTimeOfDelivery, 64).slice(0, 10);
  const sender = clean(
    isRecord(shipment.sender) ? shipment.sender.name : shipment.senderName, 200,
  ) || null;
  const current = utapiClock(shipment.status);
  const deliveredAt = stage === 'delivered' ? current?.time : null;
  return {
    status: statusFor(stage), current_stage: stage,
    last_status_text: stage === 'delivered' ? 'Delivered' : clean(shipment.status.description),
    last_update: current?.time ?? null,
    ...(current?.local_time ? { last_update_local: current.local_time } : {}),
    expected_delivery: !['delivered', 'returned'].includes(stage) && /^\d{4}-\d{2}-\d{2}$/.test(expected)
      && DateTime.fromISO(expected).isValid ? expected : null,
    timezone: 'UTC', events,
    ...(sender ? { sender_name: sender } : {}),
    ...(deliveredAt ? { delivered_at: deliveredAt } : {}),
  };
}

// Webtrack names each scan's clock: a US zone (ET, CT, MT, PT), a fixed US abbreviation
// such as PDT, an offset such as +07, or LT for the place's own time.
const US_ZONES: Readonly<Record<string, string>> = {
  ET: 'America/New_York', CT: 'America/Chicago', MT: 'America/Denver', PT: 'America/Los_Angeles',
};
const US_ABBREVIATIONS: Readonly<Record<string, readonly [family: string, zone: string]>> = {
  EST: ['ET', 'UTC-5'], EDT: ['ET', 'UTC-4'], CST: ['CT', 'UTC-6'], CDT: ['CT', 'UTC-5'],
  MST: ['MT', 'UTC-7'], MDT: ['MT', 'UTC-6'], PST: ['PT', 'UTC-8'], PDT: ['PT', 'UTC-7'],
};
// States spanning several zones, with the zones a label may rightly name there. None of
// the four is Alaska's own.
const SPLIT_STATES: Readonly<Record<string, readonly string[]>> = {
  FL: ['ET', 'CT'], IN: ['ET', 'CT'], KY: ['ET', 'CT'], MI: ['ET', 'CT'], TN: ['ET', 'CT'],
  KS: ['CT', 'MT'], NE: ['CT', 'MT'], ND: ['CT', 'MT'], SD: ['CT', 'MT'], TX: ['CT', 'MT'],
  ID: ['MT', 'PT'], NV: ['MT', 'PT'], OR: ['MT', 'PT'], AK: [],
};

// The label a one-zone state's clocks carry. Arizona's is MT although it keeps standard time.
const ZONE_LABELS: Readonly<Record<string, string>> = {
  'America/New_York': 'ET', 'America/Chicago': 'CT', 'America/Denver': 'MT',
  'America/Phoenix': 'MT', 'America/Los_Angeles': 'PT',
};

/** The US state that closes a text, with or without a ZIP code after it ("AZ", "AZ 00000"). */
function stateIn(text: string): string | null {
  const match = /(?:^|\s)([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?$/.exec(text);
  return match && usStateTimeZone(match[1]) ? match[1]! : null;
}

/** "US", "USA" or the country's name. */
function namesUS(text: string): boolean {
  return text === 'USA' || countryCode(text) === 'US';
}

/**
 * A Webtrack place reads "Town, ST, US" in the United States, at times with a ZIP code
 * after the state, without commas ("Town ST US") or without the country ("Town, ST"),
 * and "Town, CC" or the country alone in another country. A code both a state's and a
 * country's, such as CA or DE, is read as the state when the label fits that state, and
 * as the country if not.
 */
function webtrackPlace(location: string, family: string): { state: string | null; foreign: boolean } {
  const parts = location.toUpperCase().split(',').map((part) => part.trim()).filter(Boolean);
  let last = parts.at(-1) ?? '';
  let before = parts.at(-2) ?? '';
  const spaced = /^(.+?)\s+(?:US|USA)$/.exec(last);
  if (spaced && !namesUS(last)) [before, last] = [spaced[1]!, 'US'];
  if (namesUS(last)) return { state: stateIn(before), foreign: false };
  const zip = /\d$/.test(last);
  const state = parts.length <= 2 || zip ? stateIn(last) : null;
  const labels = state ? SPLIT_STATES[state] ?? [ZONE_LABELS[usStateTimeZone(state)!]] : [];
  if (state && (zip || !countryCode(state) || labels.includes(family))) return { state, foreign: false };
  return { state: null, foreign: countryCode(last) !== null };
}

/**
 * The zone of a US state: its own, or for a state split between zones the one the label
 * names there. Undefined when the label names none of the state's zones; null without a
 * state. Arizona stays on standard time, except the Navajo Nation, which this reads as the
 * rest of the state.
 */
function stateZone(state: string | null, family: string): string | null | undefined {
  if (!state) return null;
  const split = SPLIT_STATES[state];
  if (!split) return usStateTimeZone(state);
  return split.includes(family) ? US_ZONES[family] : undefined;
}

/**
 * The zone a scan's clock label names. A US label (ET or PDT) holds at a US place or one
 * that names no country, checked against an identified hub or the place's state: a hub and
 * a one-zone state keep their own clock (Arizona stays on standard time, Hawaii has its own
 * zone), a split state must be one the label can name, and an abbreviation's offset must be
 * one the place's clock has on that date. At a place in another country, as for LT or an unknown label, the place's
 * own zone holds. Null keeps the clock local.
 */
function webtrackZone(label: unknown, location: string, raw: string): string | null {
  const code = clean(label, 8).toUpperCase();
  const generic = Object.hasOwn(US_ZONES, code) ? US_ZONES[code]! : null;
  const abbreviation = Object.hasOwn(US_ABBREVIATIONS, code) ? US_ABBREVIATIONS[code]! : null;
  const family = abbreviation ? abbreviation[0] : code;
  const place = webtrackPlace(location, family);
  if ((generic || abbreviation) && !place.foreign) {
    const own = HUB_ZONES[location.toLowerCase()] ?? stateZone(place.state, family);
    if (own === undefined) return null;
    if (generic) return own ?? generic;
    const fixed = abbreviation![1];
    if (!own) return fixed;
    return wallOffsets(raw, own).includes(firstOccurrence(DateTime.fromISO(raw, { zone: fixed })).offset) ? fixed : null;
  }
  const offset = /^([+-])(0\d|1[0-4])(?::?([0-5]\d))?$/.exec(code);
  if (offset) return `UTC${offset[1]}${Number(offset[2])}${offset[3] && offset[3] !== '00' ? `:${offset[3]}` : ''}`;
  const country = location.split(',').at(-1)?.trim() ?? '';
  return countryTimeZone(country) ?? countryTimeZone(location) ?? HUB_ZONES[location.toLowerCase()] ?? null;
}

function webtrackClock(event: JsonObject): { time?: string; local_time?: string } | null {
  const date = clean(event.date, 32);
  const time = clean(event.time, 32);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)
    || !/^\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/.test(time)) return null;
  const raw = `${date}T${time}`;
  const explicit = DateTime.fromISO(raw, { zone: 'UTC', setZone: true });
  if (!explicit.isValid) return null;
  if (/(?:Z|[+-]\d{2}:\d{2})$/.test(time)) return { time: explicit.toUTC().toISO() };
  const zone = webtrackZone(event.timeZone, clean(event.location, 160), raw);
  const instant = zone ? zonedInstant(raw, zone) : null;
  return instant ? { time: instant } : { local_time: raw };
}

/** Whether two spellings name one place: the parts of one, in order, among the other's. */
function samePlace(left: string, right: string): boolean {
  const parts = (place: string) => place.toLowerCase().split(',').map((part) => part.trim()).filter(Boolean);
  const [short, long] = [parts(left), parts(right)].sort((a, b) => a.length - b.length) as [string[], string[]];
  let at = 0;
  for (const part of long) if (part === short[at]) at += 1;
  return at === short.length;
}

/** The last-mile partner Webtrack names, never DHL eCommerce itself. */
function webtrackPartner(name: string, url: string): string | undefined {
  const partner = WEBTRACK_PARTNERS[name.toUpperCase()]
    ?? (name.toUpperCase() === 'MIRROR' ? undefined : carrierIdFromPartner(name.replace(/_/g, ' '), url));
  return partner === 'dhl-ecommerce' ? undefined : partner;
}

function webtrackWeight(value: unknown): number | null {
  if (!isRecord(value) || typeof value.value !== 'number' || !Number.isFinite(value.value) || value.value <= 0) return null;
  const unit = clean(value.unitOfMeasure, 8).toUpperCase();
  const factor = unit === 'LB' ? POUNDS_TO_KG : unit === 'KG' ? 1 : null;
  return factor === null ? null : Math.round(value.value * factor * 1000) / 1000;
}

/** Webtrack scopes the read to the requested alias and returns that alias on
 * each package, as its own client requires. An alias can differ from all of
 * the package's carrier identifiers, so accept it only on one identified,
 * unambiguous package. Never accept a bare query echo or a fabricated shell. */
export function parseDHLEcommerceWebtrackResponse(payload: unknown, trackingNumber: string): CarrierResult {
  const number = normalizeDHLEcommerceNumber(trackingNumber);
  if (!isRecord(payload) || !Array.isArray(payload.packages) || !Number.isInteger(payload.total)
    || Number(payload.total) < 0 || payload.packages.length > 50 || payload.offset !== 0
    || (payload.errors !== undefined && (!Array.isArray(payload.errors) || payload.errors.length > 0))) {
    throw new SchemaError(PROVIDER, 'DHL eCommerce returned an invalid Webtrack response');
  }
  if (payload.total === 0 && payload.packages.length === 0) {
    // Webtrack covers the Americas network; the global endpoint may still
    // know an item this regional endpoint does not list.
    throw new IndeterminateError(PROVIDER, 'DHL eCommerce Webtrack does not list this shipment', { reason: 'webtrack_not_found' });
  }
  if (payload.total !== 1 || payload.packages.length !== 1 || !isRecord(payload.packages[0])) {
    throw new SchemaError(PROVIDER, 'DHL eCommerce did not return one unambiguous Webtrack package');
  }
  const shipment = payload.packages[0];
  const identifiers = [shipment.trackingId, shipment.packageId, shipment.dhlPackageId, shipment.deliveryConfirmationNumber];
  const matches = (value: unknown) => typeof value === 'string'
    && value.toUpperCase().replace(/[\s.-]/g, '') === number;
  if (!clean(shipment.tmiUid) || !identifiers.some((value) => clean(value))
    || ![shipment.trackedValue, ...identifiers].some(matches)) {
    throw new SchemaError(PROVIDER, 'DHL eCommerce returned a different or unidentified Webtrack package');
  }
  const summary = clean(shipment.status);
  if (!summary || !Array.isArray(shipment.events) || shipment.events.length > 500
    || shipment.events.some((event) => !isRecord(event))) {
    throw new SchemaError(PROVIDER, 'DHL eCommerce returned invalid Webtrack tracking history');
  }
  const events: CarrierEvent[] = [];
  const keys: string[] = [];
  for (const event of shipment.events as JsonObject[]) {
    const description = clean(event.primaryEventDescription);
    const location = clean(event.location, 160);
    const clock = webtrackClock(event);
    if (!description || !clock) continue;
    // While a parcel is en route, Webtrack adds an EN ROUTE row without a place, stamped
    // with the time of each request: an echo of the status, not a scan.
    if (description.toUpperCase() === 'EN ROUTE' && !location) continue;
    const stage = stageFor({ description });
    const scan: CarrierEvent = { ...clock, description: stage === 'delivered' ? 'Delivered' : description, location, stage };
    // Webtrack can list one scan twice, under one id with two spellings of its place
    // ("Town, AU" and "Town, City, AU"). The row with an instant, then the fuller place, is kept.
    const id = clean(event.primaryEventId, 80);
    const key = [id, clean(event.date, 32), clean(event.time, 32), clean(event.timeZone, 16), description].join('|');
    const twin = id ? keys.indexOf(key) : -1;
    if (twin >= 0 && samePlace(events[twin]!.location ?? '', location)) {
      const kept = events[twin]!;
      if (scan.time && !kept.time || !scan.time === !kept.time && location.length > (kept.location ?? '').length) events[twin] = scan;
      continue;
    }
    events.push(scan);
    keys.push(key);
  }
  // Webtrack lists scans newest first. Its order stands unless every scan has an instant.
  if (events.every((event) => event.time)) events.sort((left, right) => right.time!.localeCompare(left.time!));
  events.splice(100);
  const summaryStage = stageFor({ description: summary, statusCode: summary === 'Delivered' ? 'delivered' : undefined });
  // A published scan carries finer semantics than Webtrack's coarse summary.
  const stage = ['delivered', 'returned'].includes(summaryStage) ? summaryStage : events[0]?.stage ?? summaryStage;
  if (events.length === 0) {
    throw new IndeterminateError(PROVIDER, 'DHL eCommerce has not published Webtrack tracking history', { reason: 'webtrack_no_history' });
  }
  const expected = clean(shipment.estimatedDeliveryDate, 32);
  const sender = clean(isRecord(shipment.sender) ? shipment.sender.name : null, 200);
  const service = clean(shipment.productName, 80);
  const weight = webtrackWeight(shipment.weight);
  // The partner is named from the label onwards; it is reported once it has the parcel,
  // with its own number for it, such as a USPS PIC, when that is not the one asked for.
  const partner = shipment.events.some((event: JsonObject) => partnerHasParcel(event.primaryEventDescription))
    ? webtrackPartner(clean(shipment.dspName, 40), clean(shipment.dspUrl, 300)) : undefined;
  const partnerNumber = clean(shipment.deliveryConfirmationNumber, 40).toUpperCase().replace(/[\s.-]/g, '');
  return {
    status: statusFor(stage), current_stage: stage,
    last_status_text: stage === 'delivered' ? 'Delivered' : summary,
    last_update: events.find((event) => event.time)?.time ?? null,
    expected_delivery: !['delivered', 'returned'].includes(stage) && /^\d{4}-\d{2}-\d{2}$/.test(expected)
      && DateTime.fromISO(expected).isValid ? expected : null,
    timezone: 'UTC', events,
    ...(sender ? { sender_name: sender } : {}),
    ...(service ? { service_name: service } : {}),
    ...(weight !== null ? { weight_kg: weight } : {}),
    ...(partner ? { delivery_carrier: partner } : {}),
    ...(partner && partnerNumber !== number && /^[A-Z0-9]{4,40}$/.test(partnerNumber)
      ? { delivery_tracking_number: partnerNumber } : {}),
    ...(stage === 'delivered' && events[0]?.stage === 'delivered' && events[0].time ? { delivered_at: events[0].time } : {}),
  };
}

/**
 * The tracking page answered with a challenge status instead of the tracking
 * application. The name is part of the host's error metadata contract: it
 * reports the upstream status for errors named `DHLEcommerceSessionError`.
 */
export class DHLEcommerceSessionError extends ChallengeError {
  /** Always present here; narrowed from the optional base field. */
  declare readonly status: number;

  constructor(status: number, options?: CarrierErrorOptions) {
    super(PROVIDER, `DHL eCommerce rejected the tracking session with HTTP ${status}`, { ...options, status });
    this.name = 'DHLEcommerceSessionError';
  }
}

function trackingApiUrl(number: string): string {
  const url = new URL(API);
  url.search = new URLSearchParams({ trackingNumber: number, language: 'en', requesterCountryCode: 'CH', source: 'tt' }).toString();
  return url.toString();
}

/**
 * The UTAPI answers that end the browser step: no DHL shipment with the number, or only
 * shipments another DHL service carries, such as DHL Paket's. The second is DHL eCommerce's
 * answer that it holds no shipment under the number, not an outage.
 */
function utapiAnswer(payload: unknown): Error | undefined {
  if (isMissingShipment(payload)) return new NotFoundError(PROVIDER);
  if (isRecord(payload) && Array.isArray(payload.shipments) && payload.shipments.length > 0 && payload.shipments.every(
    (shipment) => isRecord(shipment) && typeof shipment.service === 'string' && shipment.service !== 'ecommerce',
  )) return new IndeterminateError(PROVIDER, 'Another DHL service carries the shipment', { reason: 'portal_not_found' });
  return undefined;
}

export interface DHLEcommerceTrackerOptions extends Omit<UniversalBrowserOptions, 'signal'> {
  budgetMs?: number;
  recorder?: StepRecorder;
  fetcher?: typeof fetch;
  userAgent?: string;
}

/**
 * The package identifier of a typed routing barcode is the number DHL was
 * asked for, and the one USPS tracks, so consumers can keep that.
 */
function withPackageIdentifier(typed: string, number: string, result: CarrierResult): CarrierResult {
  return cleanNumber(typed) !== number ? { ...result, canonical_tracking_number: number } : result;
}

export class DHLEcommerceTracker {
  private readonly recorder: StepRecorder;
  private readonly serialize = singleFlight();

  constructor(readonly options: DHLEcommerceTrackerOptions = {}) {
    const timeout = options.timeoutMs;
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0 || timeout > 60_000)) {
      throw new TypeError('DHL eCommerce timeout must be between 1 and 60000 ms');
    }
    this.recorder = options.recorder ?? NOOP_RECORDER;
  }

  /** One browser at a time per instance: a batch must not spawn a Chromium per parcel. */
  async fetch(trackingNumber: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeDHLEcommerceNumber(trackingNumber);
    const timeoutMs = this.options.timeoutMs ?? 45_000;
    const result = await takeTurn(this.serialize, PROVIDER, context, ({ signal, budgetMs }) => runSteps<CarrierResult>(
      { carrier: 'dhl-ecommerce', budgetMs: budgetMs ?? this.options.budgetMs ?? timeoutMs + 15_000, signal, recorder: this.recorder },
      [
        { id: 'direct', run: (step) => this.direct(number, Math.min(DIRECT_TIMEOUT_MS, step.remainingMs), step.signal) },
        { id: 'browser', recovers: browserRecoveryAllowed,
          run: (step) => this.browser(number, Math.max(1, Math.floor(Math.min(timeoutMs, step.remainingMs))), step.signal) },
      ],
    ));
    return withPackageIdentifier(trackingNumber, number, result);
  }

  /** Recognition never starts the global page or spends a browser budget. */
  async recognize(trackingNumber: string, context: TrackingContext = {}): Promise<Recognition> {
    return recognizeFromLookup(async () => {
      const number = normalizeDHLEcommerceNumber(trackingNumber);
      const budget = lookupBudget(context, DIRECT_TIMEOUT_MS, PROVIDER);
      try {
        return await this.direct(number, Math.min(DIRECT_TIMEOUT_MS, budget.remainingMs()), budget.signal);
      } catch (error) {
        // A clean regional miss is unknown to this recognition check; it is
        // never a claim that the global DHL network does not know the number.
        if (error instanceof IndeterminateError && error.reason === 'webtrack_not_found') throw new NotFoundError(PROVIDER);
        throw error;
      }
    }, () => accepted(() => normalizeDHLEcommerceNumber(trackingNumber)));
  }

  private async direct(number: string, timeoutMs: number, signal: AbortSignal): Promise<CarrierResult> {
    try {
      const { response, bytes } = await fetchBounded(WEBTRACK_API, { method: 'POST', signal,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) },
        body: JSON.stringify({ trackedValue: number, offset: 0, locale: 'en-US' }),
      }, { provider: PROVIDER, timeoutMs, maxBytes: 1_000_000, fetcher: this.options.fetcher, allowHttpStatuses: [404, 410] });
      if (!response.ok) throw new IndeterminateError(PROVIDER, 'DHL eCommerce Webtrack endpoint is unavailable');
      return parseDHLEcommerceWebtrackResponse(parseJsonBytes(bytes, PROVIDER), number);
    } catch (error) {
      if (error instanceof UpstreamHttpError && CHALLENGE_STATUSES.includes(error.status)) {
        throw new DHLEcommerceSessionError(error.status, { cause: error });
      }
      throw error;
    }
  }

  private async browser(number: string, timeoutMs: number, signal: AbortSignal): Promise<CarrierResult> {
    try {
      const api = trackingApiUrl(number);
      return await scrapeUniversalPage({ executablePath: this.options.executablePath, timeoutMs, signal }, {
        name: PROVIDER, url: dhlEcommerceTrackingUrl(number), responseUrl: api,
        responseErrors: { [api]: utapiAnswer }, errorStatuses: [404],
      }, parseDHLEcommerceResponse);
    } catch (error) {
      // The challenge can also reach the page itself; name it so the host
      // records the upstream status rather than a bare transport failure.
      if (error instanceof UpstreamHttpError && CHALLENGE_STATUSES.includes(error.status)) {
        throw new DHLEcommerceSessionError(error.status, { cause: error });
      }
      throw error;
    }
  }

  async recognizeWithBrowser(number: string, context: TrackingContext = {}, previousError?: unknown) {
    if (previousError !== undefined && !browserRecoveryAllowed(previousError)) {
      throw previousError instanceof Error ? previousError : new Error('DHL eCommerce HTTP recognition cannot recover through a browser');
    }
    const normalized = normalizeDHLEcommerceNumber(number);
    return takeTurn(this.serialize, PROVIDER, context, (step) => recognizeFromBrowserLookup(async () => withPackageIdentifier(number, normalized,
      await runSteps<CarrierResult>(
        { carrier: 'dhl-ecommerce', budgetMs: step.budgetMs ?? 20_000, signal: step.signal, recorder: this.recorder },
        [{ id: 'browser', run: ({ signal, remainingMs }) => this.browser(normalized, remainingMs, signal) }],
      ))));
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new DHLEcommerceTracker({
    executablePath: environment.browserExecutablePath ?? undefined, recorder: environment.recorder,
    fetcher: environment.fetcher, userAgent: environment.userAgent,
  });
  return {
    id: 'dhl-ecommerce', recordsSteps: true,
    steps: ['direct', 'browser'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => tracker.recognize(number, context),
    recognizeWithBrowser: (number, context, previousError) => tracker.recognizeWithBrowser(number, context, previousError),
  };
};
