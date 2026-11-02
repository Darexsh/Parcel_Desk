import { BrowserRouteTrial, retryShare } from '../../core/transport/browserRouteTrial.js';

import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { recognizeFromBrowserLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { fillPartialAnswer } from '../../core/result/partial.js';
import { fedexBarcodeTrackingNumber, fedexGroundEconomyUspsNumber } from '../../core/detection/fedex.js';
import { uspsPackageIdentifier } from '../../core/detection/usps.js';
import {
  ChallengeError,
  InputRequiredError,
  InvalidInputError,
  RateLimitedError,
  SchemaError,
  TransportError,
  UpstreamHttpError,
} from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { runSteps, type StepContext } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import {
  calendarDay,
  canadaProvinceTimeZone,
  countryTimeZone,
  explicitOffsetTime,
  firstOccurrence,
  usStateTimeZone,
} from '../../core/time/index.js';
import { clean, cleanScalar, TRAWL_TRANSPORT_ALLOWANCE_MS, type TrawlClient } from '../../core/transport/index.js';
import { isRecord, type JsonObject } from '../../core/types.js';
import { FedExApiClient, fedexApiCredentials, type FedExApiCredentials } from './api.js';
import { FEDEX_CODE_STAGE, fedexScanStage, fedexStage, fedexStatus, statusForStage } from './status.js';

/**
 * FedEx, through its official Track API when the deployment has keys for it
 * (see `api.ts`), then through the tracking reply the public page reads itself.
 * Both replies become one shipment model, read by the same rules.
 *
 * The page at `fedextrack/?trknbr=` is a shell: every byte of tracking data
 * arrives as `POST https://api.fedex.com/track/v2/shipments`, a
 * browser-gated call. Plain HTTP and the deployed browser service received
 * HTTP 403 on 2026-09-22, while an interactive browser returned full history.
 * The browser service retains verified FedEx contexts for later lookups.
 * API rejection must stay a challenge so routing applies cooldown/fallback.
 * The browser's session is never replayed over plain HTTP.
 *
 * Response shape provenance: the page bundle's package model (`trackingNbr`,
 * `keyStatus`/`keyStatusCD`, `scanEventList` items with
 * `date`/`time`/`gmtOffset`/`scanLocation`/`status`/`statusCD`/`scanDetails`,
 * and the hold location's `halCmpnyName`/`halAddress`), inspected 2026-09-20
 * and 2026-10-08.
 */
const TRACKING_BASE = 'https://www.fedex.com/fedextrack/';
const TRACK_API = 'https://api.fedex.com/track/v2/shipments';
const MAX_BYTES = 10_000_000;
const DEFAULT_TIMEOUT_MS = 90_000;
// How long the browser may wait for the page's own tracking call after the page settles.
const SETTLE_TIMEOUT_MS = 15_000;
// Captured replies beyond this many are noise, never the answer.
const MAX_CAPTURED = 20;
// The official API's share of a lookup; it answers in about a second.
const API_TIMEOUT_MS = 15_000;
const MAX_EVENTS_TO_INSPECT = 500;
const MAX_EVENTS_TO_RETURN = 100;
const HOUR_MS = 3_600_000;

export function normalizeFedExTrackingNumber(raw: string): string {
  const value = raw.toLocaleUpperCase('en-US').replace(/[\s.-]/g, '');
  // A scanned label barcode is tracked by the tracking number it carries.
  const embedded = fedexBarcodeTrackingNumber(value);
  if (embedded) return embedded;
  // Twelve or fifteen digits, or a twenty-digit Ground Economy number. Its check
  // digit is not enforced here: detection already ranks by it, and a number a
  // caller insists on still reaches FedEx.
  if (!/^(?:\d{12}|\d{15}|\d{20})$/.test(value)) {
    throw new InvalidInputError('FedEx', 'FedEx tracking numbers must contain 12, 15 or 20 digits, or be a checksum-valid 22- or 34-digit FedEx label barcode');
  }
  return value;
}

export function fedexTrackingUrl(trackingNumber: string): string {
  const url = new URL(TRACKING_BASE);
  url.searchParams.set('trknbr', normalizeFedExTrackingNumber(trackingNumber));
  return url.toString();
}

/**
 * A scan's clock. FedEx sends a local wall-clock pair plus its explicit
 * offset, assembled into an offset-carrying ISO string rather than parsed, so
 * no zone is ever guessed. A step FedEx dates by its day alone, as it does its
 * pickup, comes with a 00:00:00 time and no offset; it keeps the day in
 * `local_time` rather than a midnight. Any other unusable triple keeps no clock.
 */
function scanClock(scan: JsonObject): Pick<CarrierEvent, 'time'> & { local_time?: string } {
  const date = cleanScalar(scan.date);
  const time = cleanScalar(scan.time);
  const offset = cleanScalar(scan.gmtOffset);
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!day) return {};
  if (/^\d{2}:\d{2}(?::\d{2})?$/.test(time) && /^[+-]\d{2}:?\d{2}$/.test(offset)) {
    const clock = time.length === 5 ? `${time}:00` : time;
    const parsed = explicitOffsetTime(`${date}T${clock}${offset}`);
    return parsed ? { time: parsed.iso } : {};
  }
  const local = !offset && /^00:00(?::00)?$/.test(time)
    ? calendarDay(Number(day[1]), Number(day[2]), Number(day[3])) : null;
  return local ? { local_time: local } : {};
}

// US states and Canadian provinces with places on more than one clock, and the
// countries whose islands keep another clock than the mainland zone they are given.
const SEVERAL_CLOCKS = new Set(['AK', 'FL', 'ID', 'IN', 'KS', 'KY', 'MI', 'ND', 'NE', 'NV', 'OR', 'SD', 'TN', 'TX',
  'BC', 'NL', 'NU', 'ON', 'QC', 'ES', 'PT']);

/** The zone of a place that keeps one clock: its country's, or its US state's or Canadian province's. */
function placeZone(country: string, region: string): string | null {
  if (country === 'US') return SEVERAL_CLOCKS.has(region) ? null : usStateTimeZone(region);
  if (country === 'CA') return SEVERAL_CLOCKS.has(region) ? null : canadaProvinceTimeZone(region);
  return SEVERAL_CLOCKS.has(country) ? null : countryTimeZone(country);
}

/** The page names a US or Canadian scan's state ("MEMPHIS, TN") and any other scan's country ("BOLOGNA IT"). */
function pageZone(location: string): string | null {
  const [, comma, code] = /(,?) ([A-Z]{2})$/.exec(location) ?? [];
  if (!code) return null;
  if (comma && usStateTimeZone(code)) return placeZone('US', code);
  if (comma && canadaProvinceTimeZone(code)) return placeZone('CA', code);
  return placeZone(code, '');
}

function apiZone(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return placeZone(cleanScalar(value.countryCode).toUpperCase(), cleanScalar(value.stateOrProvinceCode).toUpperCase());
}

/**
 * FedEx labels a scan it records after a clock change with the offset its
 * place has kept since, even when the scan came before: a hub's departure the
 * evening before October's change came as +01:00 among scans it had recorded
 * in time as +02:00. A label that is the place's offset at `readAt` but not at
 * the scan's wall clock is put back on the place's clock. A wall clock the
 * place repeats or skips keeps its label.
 */
function placeClock<Clock extends { time?: string }>(clock: Clock, zone: string | null, readAt: number): Clock {
  const shown = clock.time && zone ? DateTime.fromISO(clock.time, { setZone: true }) : null;
  if (!zone || !shown?.isValid || DateTime.fromMillis(readAt, { zone }).offset !== shown.offset) return clock;
  const { year, month, day, hour, minute, second } = shown;
  const own = firstOccurrence(DateTime.fromObject({ year, month, day, hour, minute, second }, { zone }));
  if (!own.isValid || own.hour !== hour || own.minute !== minute) return clock;
  if (own.getPossibleOffsets().some((possible) => possible.offset === shown.offset)) return clock;
  const time = own.toISO({ suppressMilliseconds: true });
  return time ? { ...clock, time } : clock;
}

interface ListedScan {
  event: CarrierEvent;
  /** Its place in FedEx's list, which runs newest first. */
  index: number;
  /** The day of a scan dated by its day alone, else empty. */
  day: string;
}

/**
 * Newest first. A scan with a time sorts by its instant, since each carries
 * its own offset, and one without a clock comes last. A scan dated by its day
 * alone could be any time from the day's start at UTC+14 to its end at UTC−12:
 * it goes below every scan certainly later, above every scan certainly earlier,
 * and in FedEx's own order among the rest. FedEx sorts it at its day's
 * midnight, below the shipper's data it received that day, which comes first:
 * it goes above that data.
 */
function newestFirst(scans: readonly ListedScan[]): CarrierEvent[] {
  const instant = (scan: ListedScan) => Date.parse(scan.event.time ?? '') || 0;
  const ordered = scans.filter((scan) => !scan.day).sort((left, right) => instant(right) - instant(left));
  for (const scan of scans.filter((scan) => scan.day)) {
    const start = Date.parse(`${scan.day}T00:00:00Z`);
    const at = ordered.findIndex((other) => other.day ? other.index > scan.index
      : instant(other) < start - 14 * HOUR_MS
        || (instant(other) < start + 36 * HOUR_MS && (other.index > scan.index || other.event.stage === 'registered')));
    ordered.splice(at < 0 ? ordered.length : at, 0, scan);
  }
  return ordered.map((scan) => scan.event);
}

/**
 * The API's clock for a scan: an ISO time with its offset. A step FedEx dates
 * by its day alone, which the tracking page sends as midnight without an offset,
 * keeps that day in `local_time`, as it does there.
 */
function apiClock(value: unknown): Pick<CarrierEvent, 'time'> & { local_time?: string } {
  const raw = cleanScalar(value, 64);
  const parsed = explicitOffsetTime(raw);
  if (parsed) return { time: parsed.iso };
  const day = /^(\d{4})-(\d{2})-(\d{2})(?:T00:00(?::00)?)?$/.exec(raw);
  const local = day ? calendarDay(Number(day[1]), Number(day[2]), Number(day[3])) : null;
  return local ? { local_time: local } : {};
}

/** A scan's place as the tracking page writes it: the town, then its state or province, else its country. */
function apiPlace(value: unknown): string {
  if (!isRecord(value)) return '';
  const city = clean(value.city, 80);
  const region = clean(value.stateOrProvinceCode, 40) || clean(value.countryCode, 8);
  return city && region ? `${city}, ${region}` : city;
}

function scanDescription(status: string, details: string): string {
  if (details && !status.toLocaleLowerCase('en-US').includes(details.toLocaleLowerCase('en-US'))) {
    return clean(`${status} — ${details}`);
  }
  return status;
}

/** Delivery-date estimate as a calendar day; anything else is not an estimate. */
function expectedDelivery(value: unknown): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(cleanScalar(value, 64));
  return match ? match[1]! : null;
}

/** A delivered-at instant; offset-less or unparsable values are dropped. */
function deliveredAt(value: unknown): string | null {
  return explicitOffsetTime(value)?.iso ?? null;
}

/**
 * The hold location, read only while the parcel waits there: its name, then
 * its street and its town on their own lines when FedEx gives both. These are
 * the `halCmpnyName` and `halAddress` the page reads for a held parcel, or the
 * API's `holdAtLocation`. The recipient and shipper blocks are never a
 * fallback, and a residential hold address is someone's home, so it is never
 * projected.
 */
function holdLocation(nameValue: unknown, addressValue: unknown, residential: boolean): string {
  const name = clean(nameValue, 200);
  const address: JsonObject = isRecord(addressValue) ? addressValue : {};
  if (!name || residential || address.residential === true) return '';
  const street = Array.isArray(address.streetLines)
    ? address.streetLines.map((line) => clean(line, 120)).filter(Boolean)
    : [];
  const city = clean(address.city, 80);
  if (street.length === 0 || !city) return name;
  const postcode = cleanScalar(address.postalCode, 16);
  // A US state or Canadian province comes before the postcode, after the town.
  const region = clean(address.stateOrProvinceCode, 40);
  const town = region ? `${city}, ${[region, postcode].filter(Boolean).join(' ')}` : [postcode, city].filter(Boolean).join(' ');
  return [name, street[0], street.slice(1).join(', '), town].filter(Boolean).join('\n');
}

// FedEx flags a parcel scanned in after the day's cutoff as delayed (`DY`) while
// its wording reads as an ordinary pickup: the parcel leaves on the next business
// day. Only that newest pickup scan explains the flag.
const AFTER_CUTOFF = /\breceived after fedex cutoff\b/i;

// Ground Economy can hand a parcel to the U.S. Postal Service for the last leg.
// FedEx then relays USPS's scans, the first naming the package number USPS
// tracks it under; most parcels instead say delivery stays with FedEx Ground.
const USPS_HAS_PARCEL = /\b(?:accepted by|at|with|delivered by) (?:the )?u\.?s\.? postal service\b/i;
// A negation before USPS in the same sentence says USPS does not have it.
const USPS_NEGATED = /\b(?:not|never|no longer)\b[^.;!?]*\bu\.?s\.? postal service\b/i;
const USPS_TRACKING_ID = /\btracking id\s*:?\s*(\d{22}|\d{26})\b/i;

/**
 * The USPS package number a parcel travels under once a scan shows USPS has
 * it: the one the scan names, else, for a 20-digit Ground Economy number whose
 * check digit passes, that number with 92 in front. Otherwise null.
 */
function uspsHandoff(scans: readonly FedExScan[], number: string): string | null {
  const texts = scans.map((scan) => scan.wording)
    .filter((text) => USPS_HAS_PARCEL.test(text) && !USPS_NEGATED.test(text));
  if (texts.length === 0) return null;
  for (const text of texts) {
    const named = uspsPackageIdentifier(USPS_TRACKING_ID.exec(text)?.[1] ?? '');
    if (named) return named;
  }
  return fedexGroundEconomyUspsNumber(number);
}

function errorCode(error: unknown): string {
  return isRecord(error) ? cleanScalar(error.code).toLocaleUpperCase('en-US') : '';
}

/** An empty answer proves nothing either way, so it stays a retryable unknown. */
function notLocated(): CarrierResult {
  return {
    status: 'unknown',
    last_status_text: 'FedEx could not locate the shipment',
    last_update: null,
    expected_delivery: null,
    events: [],
  };
}

/** One scan, from either reply. */
interface FedExScan {
  /** Its status, then the detail it adds. */
  description: string;
  /** Both, as plain words for the status map and the USPS handoff. */
  wording: string;
  /** Its code, uppercased. */
  code: string;
  clock: Pick<CarrierEvent, 'time'> & { local_time?: string };
  location: string;
  /** Its place's zone, when the place keeps one clock. */
  zone: string | null;
}

/** A shipment as either reply gives it, its scans in FedEx's order, newest first. */
interface FedExShipment {
  scans: readonly FedExScan[];
  statusText: string;
  statusCode: string;
  statusDetails: string;
  estimate: unknown;
  deliveredAt: unknown;
  /** The hold location, whether or not the parcel waits there yet. */
  holdLocation: string;
}

const GENERIC_TRANSIT = 'On the way';

function shipmentResult(shipment: FedExShipment, number: string): CarrierResult {
  const listed: ListedScan[] = [];
  const seen = new Set<string>();
  for (const [index, scan] of shipment.scans.entries()) {
    if (!scan.description) continue;
    const stage = fedexScanStage(scan.code, scan.wording);
    const { clock } = scan;
    // A delivered scan names its signatory; the event keeps the fact, not the name.
    const event: CarrierEvent = {
      ...clock,
      ...(scan.location ? { location: scan.location } : {}),
      description: stage === 'delivered' ? 'Delivered' : scan.description,
      ...(scan.code ? { provider_code: scan.code } : {}),
      ...(stage ? { stage } : {}),
    };
    const identity = JSON.stringify([clock.time ?? clock.local_time ?? '', event.location ?? '', event.description]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    listed.push({ event, index, day: clock.local_time ?? '' });
  }
  // FedEx writes its generic "On the way" beside a specific scan at the same instant and place, as
  // beside "Departed FedEx hub": a second copy of that scan.
  const at = (event: CarrierEvent) => JSON.stringify([event.time ?? event.local_time ?? '', event.location ?? '']);
  const specific = new Set(listed.filter(({ event }) => event.description !== GENERIC_TRANSIT).map(({ event }) => at(event)));
  const kept = listed.filter(({ event }) => event.description !== GENERIC_TRANSIT || !specific.has(at(event)));
  const trimmed = newestFirst(kept).slice(0, MAX_EVENTS_TO_RETURN);
  const newest = trimmed[0];
  const { statusText: keyStatus, statusDetails } = shipment;
  const keyStatusCD = shipment.statusCode.toUpperCase();
  const statusText = keyStatus || newest?.description || 'Tracking information received';
  const wording = fedexStage(`${keyStatus} ${statusDetails}`);
  const afterCutoff = keyStatusCD === 'DY' && newest?.stage === 'accepted'
    && AFTER_CUTOFF.test(newest.description ?? '') && !(wording && statusForStage(wording) === 'exception');
  const stage = afterCutoff ? 'accepted' : FEDEX_CODE_STAGE[keyStatusCD] ?? wording ?? undefined;
  const status = afterCutoff ? 'in_transit' : fedexStatus(keyStatusCD, `${keyStatus} ${statusDetails}`, trimmed.length > 0);
  const delivered = stage === 'delivered';
  const estimate = delivered ? null : expectedDelivery(shipment.estimate);
  const pickupPoint = stage === 'ready_for_pickup' ? shipment.holdLocation : '';
  const postal = uspsHandoff(shipment.scans, number);
  // A host starts a scan dated by its day alone at midnight on the result's zone, else the catalog's
  // UTC, the evening before for a pickup in the United States: the day's scans' place gives it.
  const dayZones = new Set(shipment.scans.filter(({ clock }) => !clock.time && clock.local_time).map(({ zone }) => zone));
  const dayZone = dayZones.size === 1 ? [...dayZones][0] : null;
  return {
    status,
    ...(stage ? { current_stage: stage } : {}),
    last_status_text: delivered ? 'Delivered' : statusText,
    last_update: newest?.time || null,
    // A newest scan dated by its day alone has no instant, only that day.
    ...(!newest?.time && typeof newest?.local_time === 'string' ? { last_update_local: newest.local_time } : {}),
    ...(dayZone ? { timezone: dayZone } : {}),
    expected_delivery: estimate,
    ...(delivered && deliveredAt(shipment.deliveredAt)
      ? { delivered_at: deliveredAt(shipment.deliveredAt) } : {}),
    ...(pickupPoint ? { pickup_point: pickupPoint } : {}),
    ...(postal ? { delivery_carrier: 'usps', delivery_tracking_number: postal } : {}),
    ...(trimmed.length === 0 ? { summary_only: true } : {}),
    events: trimmed,
  };
}

/** The structured answer of the tracking page's own API call. */
export function parseFedExTrackingResponse(payload: unknown, trackingNumber: string, readAt = Date.now()): CarrierResult {
  const number = normalizeFedExTrackingNumber(trackingNumber);
  if (!isRecord(payload) || !isRecord(payload.output)) {
    throw new SchemaError('FedEx', 'FedEx returned an invalid tracking response');
  }
  const output = payload.output;
  const packages = Array.isArray(output.packages) ? output.packages.filter(isRecord) : null;
  if (!packages) throw new SchemaError('FedEx', 'FedEx returned an invalid tracking response');
  if (packages.length === 0) {
    const codes = Array.isArray(output.errorList) ? output.errorList.map(errorCode).join(' ') : '';
    if (/AUTHENTICAT|AUTHORIZATION/.test(codes)) {
      throw new InputRequiredError('FedEx', 'recipient verification',
        'FedEx requires recipient verification for this shipment');
    }
    return notLocated();
  }
  const matches = packages.filter((item) =>
    cleanScalar(item.trackingNbr).replace(/[\s.-]/g, '').toLocaleUpperCase('en-US') === number);
  if (matches.length !== 1) {
    throw new SchemaError('FedEx', matches.length === 0
      ? 'FedEx did not return the requested parcel'
      : 'FedEx returned several shipments for this number');
  }
  const shipment = matches[0]!;
  const scans = Array.isArray(shipment.scanEventList) ? shipment.scanEventList.filter(isRecord) : [];
  const errors = Array.isArray(shipment.errorList) ? shipment.errorList.filter(isRecord) : [];
  const codes = errors.map(errorCode).join(' ');
  // Error replies can echo the number with a default status and an empty scan.
  // Those placeholders cannot establish a shipment, even when the status says moving.
  if (/TRACKINGNUMBER|NOTFOUND|NOT FOUND|NO TRACKING/.test(codes)) return notLocated();
  const keyStatus = clean(shipment.keyStatus);
  const keyStatusCD = cleanScalar(shipment.keyStatusCD);
  const statusDetails = clean(shipment.statusWithDetails);
  if (scans.length === 0 && !keyStatus && !keyStatusCD) {
    if (/AUTHENTICAT|AUTHORIZATION/.test(codes)) {
      throw new InputRequiredError('FedEx', 'recipient verification',
        'FedEx requires recipient verification for this shipment');
    }
    throw new SchemaError('FedEx', 'FedEx returned no usable tracking status');
  }
  return shipmentResult({
    scans: scans.slice(0, MAX_EVENTS_TO_INSPECT).map((raw) => ({
      description: scanDescription(clean(raw.status), clean(raw.scanDetails)),
      wording: `${clean(raw.status)} ${clean(raw.scanDetails)}`,
      code: cleanScalar(raw.statusCD).toLocaleUpperCase('en-US'),
      clock: placeClock(scanClock(raw), pageZone(clean(raw.scanLocation)), readAt),
      location: clean(raw.scanLocation),
      zone: pageZone(clean(raw.scanLocation)),
    })),
    statusText: keyStatus,
    statusCode: keyStatusCD,
    statusDetails,
    estimate: shipment.estDeliveryDt,
    deliveredAt: shipment.actDeliveryDt,
    holdLocation: holdLocation(shipment.halCmpnyName, shipment.halAddress, shipment.halresidential === true),
  }, number);
}

/** The time of the first `dateAndTimes` entry of one of these types, in that order. */
function apiDate(result: JsonObject, ...types: string[]): unknown {
  const dates = Array.isArray(result.dateAndTimes) ? result.dateAndTimes.filter(isRecord) : [];
  for (const type of types) {
    const found = dates.find((entry) => cleanScalar(entry.type).toUpperCase() === type);
    if (found) return found.dateTime;
  }
  return undefined;
}

/**
 * The official Track API's answer (`POST /track/v1/trackingnumbers`). It reads
 * the scans, the latest status, the delivery dates and the hold location; the
 * recipient, shipper, signatory, package and service blocks are never read.
 */
export function parseFedExApiResponse(payload: unknown, trackingNumber: string, readAt = Date.now()): CarrierResult {
  const number = normalizeFedExTrackingNumber(trackingNumber);
  const complete = isRecord(payload) && isRecord(payload.output) && Array.isArray(payload.output.completeTrackResults)
    ? payload.output.completeTrackResults.filter(isRecord) : null;
  if (!complete) throw new SchemaError('FedEx', 'FedEx API returned an invalid tracking response');
  const bound = (value: unknown) => cleanScalar(value).replace(/[\s.-]/g, '').toLocaleUpperCase('en-US') === number;
  const results = complete.filter((entry) => bound(entry.trackingNumber))
    .flatMap((entry) => Array.isArray(entry.trackResults) ? entry.trackResults.filter(isRecord) : [])
    .filter((result) => bound(isRecord(result.trackingNumberInfo) ? result.trackingNumberInfo.trackingNumber : undefined));
  if (results.length !== 1) {
    throw new SchemaError('FedEx', results.length === 0
      ? 'FedEx did not return the requested parcel'
      : 'FedEx returned several shipments for this number');
  }
  const result = results[0]!;
  const code = errorCode(result.error);
  if (/AUTHENTICAT|AUTHORIZATION/.test(code)) {
    throw new InputRequiredError('FedEx', 'recipient verification', 'FedEx requires recipient verification for this shipment');
  }
  if (/TRACKINGNUMBER|NOTFOUND|NOT FOUND|NO TRACKING/.test(code)) return notLocated();
  const scans = Array.isArray(result.scanEvents) ? result.scanEvents.filter(isRecord) : [];
  const latest: JsonObject = isRecord(result.latestStatusDetail) ? result.latestStatusDetail : {};
  const statusText = clean(latest.description);
  const statusCode = cleanScalar(latest.code);
  if (scans.length === 0 && !statusText && !statusCode) {
    throw new SchemaError('FedEx', 'FedEx returned no usable tracking status');
  }
  const reasons = Array.isArray(latest.ancillaryDetails)
    ? latest.ancillaryDetails.filter(isRecord).map((detail) => clean(detail.reasonDescription)).filter(Boolean) : [];
  const hold: JsonObject = isRecord(result.holdAtLocation) ? result.holdAtLocation : {};
  const held: JsonObject = isRecord(hold.locationContactAndAddress) ? hold.locationContactAndAddress : {};
  const estimateWindow = isRecord(result.estimatedDeliveryTimeWindow) && isRecord(result.estimatedDeliveryTimeWindow.window)
    ? result.estimatedDeliveryTimeWindow.window : {};
  return shipmentResult({
    scans: scans.slice(0, MAX_EVENTS_TO_INSPECT).map((raw) => ({
      description: scanDescription(clean(raw.eventDescription), clean(raw.exceptionDescription)),
      wording: `${clean(raw.eventDescription)} ${clean(raw.exceptionDescription)}`,
      code: cleanScalar(raw.eventType).toLocaleUpperCase('en-US'),
      clock: placeClock(apiClock(raw.date), apiZone(raw.scanLocation), readAt),
      location: apiPlace(raw.scanLocation),
      zone: apiZone(raw.scanLocation),
    })),
    statusText,
    statusCode,
    statusDetails: reasons.join(' '),
    estimate: apiDate(result, 'ESTIMATED_DELIVERY') ?? estimateWindow.ends,
    deliveredAt: apiDate(result, 'ACTUAL_DELIVERY'),
    holdLocation: holdLocation(isRecord(held.contact) ? held.contact.companyName : undefined, held.address, false),
  }, number);
}

/**
 * The page the browser rendered, read only to tell a bot challenge from an
 * inconclusive load. The page renders its "can't find that tracking number"
 * notice both for unknown numbers and for tracking calls the edge refused,
 * so rendered text never decides not-found: only the structured reply does.
 */
export function parseFedExTrackingHtml(page: string): 'challenged' | 'inconclusive' {
  const $ = load(page);
  $('script, style, noscript').remove();
  const visible = clean($('body').text(), 20_000);
  if (/access denied|system down|just a moment|attention required|are you a robot|verify you are human|before you proceed/i.test(visible)) {
    return 'challenged';
  }
  return 'inconclusive';
}

export interface FedExTrackerOptions {
  timeoutMs?: number;
  /** The browser service, or null when none is configured. */
  trawl?: TrawlClient | null;
  /** Independent service which attests IPv6 connections to the page and tracking API. */
  ipv6Trawl?: TrawlClient | null;
  /** Share of qualifying retries sent to that service, from zero to one. */
  ipv6RetryShare?: number;
  /** The deployment's FedEx API project, or null without one. */
  api?: FedExApiCredentials | null;
  fetcher?: typeof fetch;
  recorder?: StepRecorder;
}

export class FedExTracker {
  readonly timeoutMs: number;
  readonly #trawl: TrawlClient | null;
  readonly #ipv6Trawl: TrawlClient | null;
  readonly #ipv6RetryShare: number;
  readonly #api: FedExApiClient | null;
  readonly #fetcher: typeof fetch | undefined;
  readonly #recorder: StepRecorder;

  constructor(options: FedExTrackerOptions = {}) {
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
      throw new TypeError('FedEx timeout must be positive');
    }
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#trawl = options.trawl ?? null;
    this.#ipv6Trawl = options.ipv6Trawl ?? null;
    this.#ipv6RetryShare = retryShare(options.ipv6RetryShare ?? 1);
    this.#api = options.api ? new FedExApiClient(options.api, options.fetcher) : null;
    this.#fetcher = options.fetcher;
    this.#recorder = options.recorder ?? NOOP_RECORDER;
  }

  async fetch(trackingNumber: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeFedExTrackingNumber(trackingNumber);
    // Plain HTTP to the page's own API is refused; without FedEx API keys only the browser reads it.
    const trawl = this.#trawl;
    const api = this.#api;
    if (!trawl && !api) {
      throw new ChallengeError(
        'FedEx',
        'FedEx challenged direct tracking; configure FLARESOLVERR_URL for browser fallback',
      );
    }
    const browserMs = (remainingMs: number) => Math.max(1, Math.floor(Math.min(this.timeoutMs, remainingMs)));
    const trial = new BrowserRouteTrial({ primary: trawl, alternative: this.#ipv6Trawl,
      route: 'ipv6', share: this.#ipv6RetryShare, steps: ['trawl'], recorder: this.#recorder });
    const browser = async (client: TrawlClient, remainingMs: number, signal: AbortSignal, requireIpv6 = false) =>
      trial.result(await this.#trawlResult(client, number, browserMs(remainingMs), signal, requireIpv6,
        family => trial.observeFamily(family)));
    return runSteps<CarrierResult>({
      // Without a caller's budget the lookup leaves the service its own time and
      // the request the allowance to bring the answer back.
      carrier: 'fedex',
      budgetMs: context.budgetMs ?? (api ? API_TIMEOUT_MS : 0) + (trawl ? this.timeoutMs + TRAWL_TRANSPORT_ALLOWANCE_MS : 0),
      signal: context.signal,
      recorder: trial.recorder,
    }, [
      // FedEx's own API answers in a second; it leaves the browser at least half the budget.
      ...(api ? [{ id: 'api', run: ({ remainingMs, signal }: StepContext) => this.#apiResult(api, number,
        Math.max(1, Math.floor(Math.min(API_TIMEOUT_MS, trawl ? remainingMs / 2 : remainingMs))), signal) }] : []),
      ...(trawl ? [
        // The page answers what the API could not, except a shipment the recipient must verify.
        { id: 'trawl', recovers: (error: unknown) => !(error instanceof InputRequiredError),
          run: ({ remainingMs, signal }: StepContext) => browser(trial.primary()!, remainingMs, signal) },
        // The service discards a context whose tracking call was refused, so a
        // second read starts a fresh one: Akamai's 403 is intermittent.
        { id: 'trawl', recovers: (error: unknown) => error instanceof ChallengeError && error.reason === 'api_denied' && error.status === 403,
          run: ({ remainingMs, signal }: StepContext) => {
            const client = trial.retry()!;
            return browser(client, remainingMs, signal, trial.isAlternate);
          } },
      ] : []),
    ]);
  }

  async #apiResult(api: FedExApiClient, number: string, timeoutMs: number, signal: AbortSignal): Promise<CarrierResult> {
    const result = parseFedExApiResponse(await api.track(number, signal, timeoutMs), number);
    result.tracking_url = fedexTrackingUrl(number);
    result.tracking_source = 'official-api-response';
    return result;
  }

  /**
   * A real browser loads the page and makes the tracking call itself; the
   * service hands that reply back. The browser's session is never replayed
   * over plain HTTP: the edge accepts the call only from the session it
   * validated. The page the browser rendered only tells a challenge apart.
   */
  async #trawlResult(trawl: TrawlClient, number: string, timeoutMs: number, signal: AbortSignal,
    requireIpv6 = false, observed: (family: 'IPv4' | 'IPv6' | 'unknown') => void = () => {}): Promise<CarrierResult> {
    const page = await trawl.scrape({
      url: fedexTrackingUrl(number),
      skipHttp: true,
      maxTier: 3,
      maxTimeout: timeoutMs,
      captureResponses: [TRACK_API],
      settleTimeout: SETTLE_TIMEOUT_MS,
    }, {
      provider: 'TRAWL while fetching FedEx',
      timeoutMs,
      maxBytes: MAX_BYTES,
      fetcher: this.#fetcher,
      signal,
    });
    if (requireIpv6) {
      const proof = page.raw.fedexEgress;
      if (!isRecord(proof) || proof.family !== 'IPv6' || !Number.isSafeInteger(proof.pageConnections)
        || Number(proof.pageConnections) < 1 || !Number.isSafeInteger(proof.apiConnections) || Number(proof.apiConnections) < 1) {
        throw new TransportError('FedEx', 'The retry service did not verify IPv6 tracking connections', { reason: 'ipv6_unverified' });
      }
      observed('IPv6');
    }
    let captureError: Error | undefined;
    // Newest first: a later reply is the page's final answer.
    const responses = page.capturedResponses.slice(-MAX_CAPTURED).reverse();
    for (const [index, entry] of responses.entries()) {
      if (entry.url !== TRACK_API) continue;
      if (!requireIpv6) {
        const family = entry.headers['x-trawl-network-family'];
        observed(family === 'IPv4' || family === 'IPv6' ? family : 'unknown');
      }
      if (entry.status === 0 && entry.error === 'fedex-tracking-request-failed') {
        throw new TransportError('FedEx', 'FedEx tracking request did not complete');
      }
      // The page shell can load normally while its tracking API is rejected.
      // Preserve that failure instead of reporting a missing capture or falling
      // back to an older successful reply from the same page.
      if (entry.status === 401 || entry.status === 403) {
        throw new ChallengeError('FedEx', 'FedEx rejected the browser tracking request', { status: entry.status, reason: 'api_denied' });
      }
      if (entry.status === 429) {
        const header = entry.headers['retry-after'] ?? entry.headers['Retry-After'];
        const delay = header && /^\d+(?:\.\d+)?$/.test(header) ? Number(header) * 1000
          : header ? Date.parse(header) - Date.now() : NaN;
        throw new RateLimitedError('FedEx', Number.isFinite(delay) ? Math.max(0, delay) : undefined);
      }
      if (entry.status >= 500) throw new UpstreamHttpError('FedEx', entry.status);
      if (entry.status >= 400) {
        throw new TransportError('FedEx', `FedEx tracking API returned HTTP ${entry.status}`, { status: entry.status });
      }
      if (entry.status !== 200) continue;
      if (entry.truncated || entry.body === null) {
        captureError = new SchemaError('FedEx', 'FedEx tracking response could not be read completely');
        break;
      }
      try {
        const payload: unknown = JSON.parse(entry.body);
        const result = this.#structuredResult(number, payload);
        // A later status can omit scans that this same lookup already received.
        // It keeps that history only when it still fits the newer status and clock.
        if (result.summary_only === true) {
          const qualifier = (data: unknown): unknown => isRecord(data) && isRecord(data.output) && Array.isArray(data.output.packages)
            ? data.output.packages.filter(isRecord).find(item => cleanScalar(item.trackingNbr).replace(/[\s.-]/g, '') === number)?.trackingQualifier
            : undefined;
          const currentQualifier = qualifier(payload);
          for (const earlier of responses.slice(index + 1)) {
            if (typeof currentQualifier !== 'string' || !currentQualifier.trim()) break;
            if (earlier.url !== TRACK_API || earlier.status !== 200 || earlier.truncated || earlier.body === null) continue;
            try {
              const prior: unknown = JSON.parse(earlier.body);
              if (qualifier(prior) !== currentQualifier) continue;
              const filled = fillPartialAnswer('fedex', number, result, this.#structuredResult(number, prior));
              if (filled) return filled;
            } catch { /* An earlier unreadable reply supplies no history. */ }
          }
        }
        return result;
      } catch (error) {
        if (error instanceof InputRequiredError) throw error;
        // An unreadable or unrelated reply; the rendered page may still name a challenge.
        captureError ??= error instanceof SyntaxError
          ? new SchemaError('FedEx', 'FedEx returned unreadable tracking JSON', { cause: error })
          : error instanceof Error ? error : new SchemaError('FedEx', 'FedEx returned invalid tracking data', { cause: error });
        break;
      }
    }
    if (parseFedExTrackingHtml(page.html) === 'challenged') {
      throw new ChallengeError('FedEx', 'FedEx challenged the browser tracking session', { cause: captureError });
    }
    if (captureError) throw captureError;
    throw new TransportError('FedEx', 'TRAWL did not capture the FedEx tracking response', { cause: captureError });
  }

  #structuredResult(number: string, payload: unknown): CarrierResult {
    const result = parseFedExTrackingResponse(payload, number);
    result.tracking_url = fedexTrackingUrl(number);
    result.tracking_source = 'structured-web-response';
    return result;
  }
}

export const adapter: AdapterFactory = (environment) => {
  const api = fedexApiCredentials(environment.env);
  const percent = environment.env.FEDEX_IPV6_RETRY_PERCENT;
  const tracker = new FedExTracker({
    fetcher: environment.fetcher,
    trawl: environment.trawl,
    ipv6Trawl: environment.trawlRoutes?.['fedex-ipv6'] ?? null,
    ipv6RetryShare: percent === undefined ? 1 : Number(percent) / 100,
    api,
    recorder: environment.recorder,
  });
  return {
    id: 'fedex', recordsSteps: true, plannedScans: true,
    // FedEx's own API when the deployment has keys for it, then the browser;
    // universal recovery belongs to the caller.
    steps: [...(api ? ['api'] : []), 'trawl'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognizeWithBrowser: (number, context) => recognizeFromBrowserLookup(() => tracker.fetch(number, context)),
  };
};
