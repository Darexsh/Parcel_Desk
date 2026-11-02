
import { load, type CheerioAPI } from 'cheerio';
import makeFetchCookie from 'fetch-cookie';
import { DateTime } from 'luxon';
import { CookieJar } from 'tough-cookie';
import { lookupBudget, type AdapterFactory, type LookupBudget, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import { eventPoint, type CarrierEvent, type CarrierResult, type EventPoint } from '../../core/result/index.js';
import type { ClassifiedStatus } from '../../core/status/index.js';
import { isValidS10TrackingNumber } from '../../core/detection/index.js';
import {
  countryCode, countryTimeZone, isoTime, mislabeledLocalTime, timeZoneCountry, type ParsedTime,
} from '../../core/time/index.js';
import {
  cleanScalar,
  decodeText,
  fetchBounded,
  parseJsonBytes,
  UpstreamHttpError,
} from '../../core/transport/index.js';
import { isRecord, type JsonObject } from '../../core/types.js';
import { classifyIndiaPostEvent, indiaPostEventText } from './status.js';

// Protocol provenance (inspected 2026-09-01):
// https://github.com/bivu-m/njs-tracker-scraper
// MySpeedPost currently exposes its tracking form as a Livewire component at
// /track and completes the asynchronous lookup through /livewire/update.
const TRACKING_PAGE = 'https://myspeedpost.com/track';
const LIVEWIRE_UPDATE = 'https://myspeedpost.com/livewire/update';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 750;
const DEFAULT_MAX_POLL_ATTEMPTS = 10;
// MySpeedPost serves its last sync until someone presses Refresh: one parcel
// kept an 11-day-old "Item Booked" while it reached export customs.
const REFRESH_AFTER_MS = 30 * 60_000;
const USER_TIMEZONE = 'Europe/Zurich';
// The zone of every Indian office, and the one MySpeedPost labels all clocks in.
const INDIA_ZONE = 'Asia/Kolkata';
const MAX_RESPONSE_BYTES = 2_000_000;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
  + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

export { classifyIndiaPostEvent };

interface ParsedEvent {
  event: CarrierEvent;
  classified: ClassifiedStatus;
  timestamp: number;
  index: number;
}

interface TrackComponent {
  snapshot: string;
  data: JsonObject;
  status: string;
}

interface LivewireUpdate {
  component: TrackComponent;
  effects: JsonObject;
}

interface IndiaPostTrackerOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
  fetcher?: typeof fetch;
  now?: () => Date;
}

// India Post sends ids and pincodes as numbers as often as strings, so the
// number-tolerant `cleanScalar` is used throughout instead of `clean`.
const clean = cleanScalar;

/** MySpeedPost answered with a Cloudflare challenge or a Turnstile check, not with a shipment answer. */
export class IndiaPostChallengeError extends ChallengeError {
  constructor(message = 'India Post tracking returned a browser challenge') {
    super('India Post', message);
    this.name = 'IndiaPostChallengeError';
  }
}

export function normalizeIndiaPostTrackingNumber(raw: string): string {
  const value = raw.toLocaleUpperCase('en-US').replace(/[\s.-]/g, '');
  if (!/^[A-Z]{2}\d{9}IN$/.test(value) || !isValidS10TrackingNumber(value)) {
    throw new InvalidInputError('India Post', 'India Post tracking requires a valid 13-character S10 number ending in IN');
  }
  return value;
}

export function indiaPostTrackingUrl(raw: string): string {
  const url = new URL(TRACKING_PAGE);
  url.searchParams.set('n', normalizeIndiaPostTrackingNumber(raw));
  url.searchParams.set('sync', 'true');
  return url.toString();
}

function parseTrackingRequest(html: string): JsonObject {
  const $ = load(html);
  for (const element of $('[tracking-request]').toArray()) {
    const serialized = $(element).attr('tracking-request');
    if (!serialized) continue;
    try {
      const payload: unknown = JSON.parse(serialized);
      if (isRecord(payload) && Array.isArray(payload.tracking_events)) return payload;
    } catch {
      // Keep looking in case an unrelated component owns the malformed attribute.
    }
  }
  throw new SchemaError('India Post', 'India Post returned an invalid tracking history');
}

// India Post's code for a flight leaving, in `event_type`. The wording beside
// it changes: one row read "Aircraft Departure", then "UPLIFT".
const TAKE_OFF_CODE = 'AircraftTakeOff';
// The label a take-off's wall clock arrives under; any other offset is kept.
const UTC_LABEL = /(?:Z|[+-]00:?00)$/i;
// The zones of the airports a take-off row may name, by IATA code.
const AIRPORT_ZONES: Readonly<Record<string, string>> = {
  BOM: 'Asia/Kolkata', DEL: 'Asia/Kolkata', MAA: 'Asia/Kolkata', CCU: 'Asia/Kolkata',
  BLR: 'Asia/Kolkata', HYD: 'Asia/Kolkata', COK: 'Asia/Kolkata', AMD: 'Asia/Kolkata',
  FRA: 'Europe/Berlin', MUC: 'Europe/Berlin', LEJ: 'Europe/Berlin', CGN: 'Europe/Berlin',
  LHR: 'Europe/London', CDG: 'Europe/Paris', AMS: 'Europe/Amsterdam', ZRH: 'Europe/Zurich',
  VIE: 'Europe/Vienna', BRU: 'Europe/Brussels', LGG: 'Europe/Brussels', FCO: 'Europe/Rome',
  MXP: 'Europe/Rome', MAD: 'Europe/Madrid', CPH: 'Europe/Copenhagen', ARN: 'Europe/Stockholm',
  HEL: 'Europe/Helsinki', IST: 'Europe/Istanbul',
  DXB: 'Asia/Dubai', AUH: 'Asia/Dubai', DOH: 'Asia/Qatar', SIN: 'Asia/Singapore',
  HKG: 'Asia/Hong_Kong', BKK: 'Asia/Bangkok', NRT: 'Asia/Tokyo', ICN: 'Asia/Seoul',
  PVG: 'Asia/Shanghai', KUL: 'Asia/Kuala_Lumpur', CMB: 'Asia/Colombo', DAC: 'Asia/Dhaka',
  KTM: 'Asia/Kathmandu',
  JFK: 'America/New_York', EWR: 'America/New_York', ORD: 'America/Chicago',
  LAX: 'America/Los_Angeles', SFO: 'America/Los_Angeles', YYZ: 'America/Toronto',
  SYD: 'Australia/Sydney', MEL: 'Australia/Melbourne',
};

// Only verified names are expanded; other airport codes stay as the carrier wrote them.
const AIRPORT_PLACES: Readonly<Record<string, { name: string; country: string }>> = {
  BOM: { name: 'Mumbai Airport', country: 'India' },
  DEL: { name: 'Delhi Airport', country: 'India' },
  FRA: { name: 'Frankfurt Airport', country: 'Germany' },
  CDG: { name: 'Paris Charles de Gaulle Airport', country: 'France' },
};

function officeAirport(office: string): string | undefined {
  return /^Office - ([A-Z]{3})\b/.exec(office)?.[1];
}

/**
 * A flight's number and route, from a remark naming the office's airport as
 * the origin. Flight remarks have a narrow format; unrelated remarks can
 * contain recipient details.
 */
function flightRoute(remarks: unknown, office: string): RegExpExecArray | null {
  const match = /^Flight No:\s*([A-Z0-9]{2}\d{1,4}[A-Z]?)\s*\(From ([A-Z]{3}) To ([A-Z]{3})\)$/.exec(clean(remarks, 500));
  return match && match[2] === officeAirport(office) ? match : null;
}

function flightDetails(providerCode: string, remarks: unknown, office: string): { description: string; airport: string } | null {
  if (providerCode !== TAKE_OFF_CODE && providerCode !== 'MailArrived') return null;
  const match = flightRoute(remarks, office);
  if (!match) return null;
  const airport = (code: string) => AIRPORT_PLACES[code] ? `${AIRPORT_PLACES[code].name} (${code})` : code;
  const departed = providerCode === TAKE_OFF_CODE;
  // MailArrived retains the sending office. Its flight route names the arrival airport.
  return {
    description: `Flight ${match[1]} ${departed ? 'departed' : 'arrived'}: ${airport(match[2]!)} → ${airport(match[3]!)}`,
    airport: match[departed ? 2 : 3]!,
  };
}

/**
 * The zone a take-off row's clock is kept in. Its `tracked_at` is the
 * departure airport's wall clock under a UTC label: a take-off was seen
 * recorded hours before its labelled time. The office names the airport first,
 * as in "Office - DEL 00000000". Null for every other row, for an airport
 * outside the table and for a value not labelled UTC: those are read as any
 * row is.
 */
function takeOffZone(providerCode: string, office: string, trackedAt: string): string | null {
  if (providerCode !== TAKE_OFF_CODE || !UTC_LABEL.test(trackedAt)) return null;
  const airport = officeAirport(office);
  return airport ? AIRPORT_ZONES[airport] ?? null : null;
}

/**
 * An office and its PIN, as a scan's location. India Post writes "Office -" and
 * at most a code ("Office - 00000001", "Office - FRA") for an office it does
 * not name: the code is left out, and so is the PIN when the code names an
 * airport abroad, as the office of exchange there carries an Indian office's
 * PIN. A PIN starting with 9 is the Army Postal Service's, which India Post
 * also gives foreign mail, and places no office.
 */
function officeLocation(office: string, pincode: string): string {
  const pin = /^[1-8]/.test(pincode) ? pincode : '';
  const placeholder = /^Office -(?: (?:[A-Z]{2})?([A-Z]{3}))?(?: \d+)?$/.exec(office);
  if (!placeholder) return [office, pin].filter(Boolean).join(' ');
  return !placeholder[1] || airportCountry(placeholder[1]) === 'IN' ? pin : '';
}

/**
 * The office's point from MySpeedPost's pincode directory. It is looked up by
 * pincode, not by office: "KOLKATA FOREIGN LCAO 900056" comes back as an office
 * in Delhi. Only a verified entry for the scan's own office is kept.
 */
function officePoint(rawEvent: JsonObject, office: string): EventPoint | null {
  const info = rawEvent.pincode_info;
  if (!isRecord(info) || info.is_verified !== true) return null;
  const name = (value: unknown) => clean(value, 120).toLocaleUpperCase('en-US').replace(/[^A-Z0-9]+/g, ' ').trim();
  if (!office || name(info.office_name) !== name(office)) return null;
  const point = eventPoint(info.latitude, info.longitude);
  // India's mainland and islands; anything else is a bad directory entry.
  if (!point || point.latitude < 6 || point.latitude > 37 || point.longitude < 68 || point.longitude > 98) return null;
  return point;
}

interface Destination {
  code: string | null;
  name: string;
}

/**
 * A value on one of MySpeedPost's booking cards: a heading, then label and
 * value pairs. The cards are absent when MySpeedPost has no booking details.
 * A longer value is dropped rather than cut.
 */
function cardValue($: CheerioAPI, heading: string, label: string, max: number): string {
  const card = $('h3').filter((_, element) => clean($(element).text(), 40) === heading).first().closest('[x-data]');
  for (const element of card.find('p').toArray()) {
    if (clean($(element).text(), 40).toLowerCase() !== label) continue;
    const value = clean($(element).next('p').text(), max + 1);
    return value.length <= max ? value : '';
  }
  return '';
}

/** The country on the Destination card; only "Country" is read there. */
function destinationOf($: CheerioAPI): Destination | null {
  const name = cardValue($, 'Destination', 'country', 80);
  return /^\p{L}[\p{L} .,'()&-]*$/u.test(name) ? { code: countryCode(name), name } : null;
}

/** The product India Post booked the item as, such as "Inland Speed Post". */
function articleTypeOf($: CheerioAPI): string {
  const value = cardValue($, 'Consignment Details', 'article type', 80);
  return /^\p{L}[\p{L}\d .,'()&/-]*$/u.test(value) ? value : '';
}

// UPU's marks for a scan by the destination's post ("Item received at office
// of exchange (Inb)") and by the origin's ("Transfer to OOE (Otb)"). Another
// reply for the same item can carry bare codes ("ITEM_RECEIVE") instead.
const INBOUND = /\(Inb\)/i;
const OUTBOUND = /\(Otb\)/i;
// India Post's code for a transfer to the office of exchange, in either reply.
const TRANSFER_CODE = 'ItemTransfered';
// The codes of a bag's arrival, with the flight's route in the remark.
const ARRIVAL_CODES = new Set(['MailArrived', 'BagUnloaded']);

/** The airport a flight relayed on an arrival row lands at. */
function arrivalAirport(row: JsonObject): string | null {
  return ARRIVAL_CODES.has(clean(row.event_type, 100)) ? flightRoute(row.remarks, clean(row.office, 120))?.[3] ?? null : null;
}

function airportCountry(airport: string): string | null {
  const place = AIRPORT_PLACES[airport];
  return place ? countryCode(place.country) : timeZoneCountry(AIRPORT_ZONES[airport] ?? '');
}

/**
 * Rows the destination's post scanned abroad, which India Post relays with
 * the office's wall clock labelled as India's. They start with an inbound
 * mark or with a flight's arrival in the destination country, whichever is
 * labelled first, so a reply in bare codes picks the same rows as one in
 * prose. Flight rows keep their own reading. An outbound mark, a transfer to
 * the office of exchange or an arrival in another country after that starts
 * a way back, which may be in India again, so it and what follows keep
 * India's clock. Take-offs are not compared: their labels are airport clocks.
 */
function scannedAbroad(events: readonly JsonObject[], destination: Destination | null): Set<number> {
  const abroad = new Set<number>();
  if (!destination || destination.code === 'IN') return abroad;
  const marked = (row: JsonObject, mark: RegExp) => mark.test(clean(row.event)) || mark.test(clean(row.remarks));
  const code = (row: JsonObject) => clean(row.event_type, 100);
  const labelled = events.map((row) => isoTime(row.tracked_at, INDIA_ZONE, 100)?.timestamp ?? Number.NaN);
  // The country each arrival row lands in: '' where the airport's is unknown.
  const landed = events.map((row) => {
    const airport = arrivalAirport(row);
    return airport === null ? null : airportCountry(airport) ?? '';
  });
  const entered = Math.min(...events.flatMap((row, index) => (
    marked(row, INBOUND) || (destination.code !== null && landed[index] === destination.code) ? [labelled[index]!] : [])));
  const wayBack = Math.min(...events.flatMap((row, index) => (labelled[index]! > entered && (
    marked(row, OUTBOUND) || code(row) === TRANSFER_CODE || (landed[index] && landed[index] !== destination.code))
    ? [labelled[index]!] : [])));
  events.forEach((row, index) => {
    if (labelled[index]! >= entered && labelled[index]! < wayBack && landed[index] === null
      && code(row) !== TAKE_OFF_CODE) abroad.add(index);
  });
  return abroad;
}

/**
 * A clock relayed from abroad, read in the destination's zone when the
 * country keeps one. Elsewhere it stays an offset-less wall time: India's
 * label would place it hours off, and the office's zone is unknown.
 */
function foreignClock(trackedAt: unknown, zone: string | null): { time: ParsedTime } | { local: string; timestamp: number } | null {
  const labelled = isoTime(trackedAt, INDIA_ZONE, 100);
  if (!labelled) return null;
  const wall = DateTime.fromMillis(labelled.timestamp, { zone: INDIA_ZONE })
    .toISO({ includeOffset: false, suppressMilliseconds: true });
  if (!wall) return null;
  const time = zone ? isoTime(wall, zone) : null;
  // The local wall time still orders the row among India's labels.
  return time ? { time } : zone ? null : { local: wall, timestamp: labelled.timestamp };
}

export function parseIndiaPostTrackingHtml(
  html: string,
  trackingNumber: string,
): CarrierResult {
  const requested = normalizeIndiaPostTrackingNumber(trackingNumber);
  const $ = load(html);
  const returned = clean($('#consignment_search').first().attr('value'), 64)
    .toLocaleUpperCase('en-US')
    .replace(/[\s.-]/g, '');
  if (returned !== requested) throw new SchemaError('India Post', 'India Post returned a different shipment');

  const trackingRequest = parseTrackingRequest(html);
  if (trackingRequest.tracking_status !== 'Completed') {
    throw new SchemaError('India Post', 'India Post returned an incomplete tracking response');
  }
  if (!Array.isArray(trackingRequest.tracking_events)) {
    throw new SchemaError('India Post', 'India Post returned invalid tracking events');
  }
  const rawEvents = trackingRequest.tracking_events;
  const events = rawEvents.filter(isRecord);
  if (events.length !== rawEvents.length || events.length === 0) {
    throw new SchemaError('India Post', 'India Post returned invalid tracking events');
  }

  const parsed: ParsedEvent[] = [];
  const seen = new Set<string>();
  const destination = destinationOf($);
  const service = articleTypeOf($);
  const rows = events.slice(0, 500);
  const abroad = scannedAbroad(rows, destination);
  const destinationZone = destination ? countryTimeZone(destination.code) : null;
  rows.forEach((rawEvent, index) => {
    const office = clean(rawEvent.office, 120);
    const providerCode = clean(rawEvent.event_type, 100);
    // tracked_at is ISO; offset-less values are read as Asia/Kolkata, the zone
    // every India Post office stamps. A take-off is read on its airport's clock,
    // and a scan abroad on the destination's.
    const zone = takeOffZone(providerCode, office, clean(rawEvent.tracked_at, 100));
    const foreign = abroad.has(index) ? foreignClock(rawEvent.tracked_at, destinationZone) : null;
    const time = foreign ? ('time' in foreign ? foreign.time : null) : zone
      ? mislabeledLocalTime(rawEvent.tracked_at, zone, 100)
      : isoTime(rawEvent.tracked_at, INDIA_ZONE, 100);
    const local = foreign && 'local' in foreign ? foreign : null;
    const takeOff = providerCode === TAKE_OFF_CODE;
    const flight = flightDetails(providerCode, rawEvent.remarks, office);
    const description = flight?.description ?? (takeOff ? 'Aircraft Departure' : indiaPostEventText(clean(rawEvent.event)));
    if (!(time || local) || !description) return;
    const pincode = /^\d{6}$/.test(clean(rawEvent.pincode, 6))
      ? clean(rawEvent.pincode, 6)
      : '';
    const airportCode = flight?.airport ?? (takeOff ? officeAirport(office) : undefined);
    const point = airportCode ? null : officePoint(rawEvent, office);
    const airport = airportCode ? AIRPORT_PLACES[airportCode] : undefined;
    const identity = JSON.stringify([time?.iso ?? local?.local, description, office, pincode, providerCode]);
    if (seen.has(identity)) return;
    seen.add(identity);
    const classified = classifyIndiaPostEvent(
      rawEvent.event_type,
      rawEvent.event,
      rawEvent.remarks,
    );
    parsed.push({
      // Office plus pincode is an operational location. Recipient identity,
      // contact numbers and address blocks travel on the row and are
      // deliberately never retained.
      event: {
        ...(time ? { time: time.iso } : { local_time: local!.local }),
        location: airport ? `${airport.name} (${airportCode}), ${airport.country}`
          : flight && !takeOff ? `${flight.airport} Airport` : officeLocation(office, pincode),
        description,
        stage: classified.stage,
        ...(providerCode ? { provider_code: providerCode } : {}),
        ...(point ? { point } : {}),
      },
      classified,
      timestamp: time?.timestamp ?? local!.timestamp,
      index,
    });
  });
  parsed.sort((left, right) => right.timestamp - left.timestamp || right.index - left.index);
  const latest = parsed[0];
  if (!latest) throw new SchemaError('India Post', 'India Post returned no usable tracking events');
  const classified = latest.classified.status === 'unknown'
    ? { status: 'in_transit' as const, stage: 'in_transit' }
    : latest.classified;
  const syncedAt = isoTime(trackingRequest.synced_at, 'UTC', 100);
  return {
    status: classified.status,
    current_stage: classified.stage,
    last_status_text: latest.event.description,
    last_update: latest.event.time ?? null,
    ...(typeof latest.event.local_time === 'string' ? { last_update_local: latest.event.local_time } : {}),
    expected_delivery: null,
    timezone: INDIA_ZONE,
    ...(service ? { service_name: service } : {}),
    // When MySpeedPost last asked India Post; an old value means stale history.
    ...(syncedAt ? { source_synced_at: syncedAt.iso } : {}),
    // Only the country: a S10 item goes on to that country's post, which the
    // host may confirm with its own lookup.
    ...(destination?.code ? { destination_country: destination.code }
      : destination ? { destination_country_name: destination.name } : {}),
    events: parsed.slice(0, 100).map((item) => item.event),
  };
}

function enumValue(value: unknown): string {
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : '';
}

/**
 * A component state other than Processing or Completed, without a rate limit
 * or Turnstile check to explain it. It says nothing about the shipment, so a
 * completed history the HTML still carries is used, and otherwise the lookup
 * is inconclusive.
 */
function otherState(status: string, html: string, trackingNumber: string): CarrierResult {
  try {
    return parseIndiaPostTrackingHtml(html, trackingNumber);
  } catch {
    const state = /^[A-Za-z_]{1,40}$/.test(status) ? status : 'unrecognised';
    throw new IndeterminateError('India Post', `India Post tracking is in the ${state} state`);
  }
}

function parseTrackSnapshot(snapshot: string, trackingNumber: string): TrackComponent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot);
  } catch (error) {
    throw new SchemaError('India Post', 'India Post returned invalid Livewire state', { cause: error });
  }
  if (!isRecord(parsed) || !isRecord(parsed.data) || !isRecord(parsed.memo)
    || parsed.memo.name !== 'track-consignment') {
    throw new SchemaError('India Post', 'India Post returned invalid Livewire state');
  }
  const returned = clean(parsed.data.consignment_number, 64)
    .toLocaleUpperCase('en-US')
    .replace(/[\s.-]/g, '');
  if (returned !== trackingNumber) throw new SchemaError('India Post', 'India Post returned a different shipment');
  const status = enumValue(parsed.data.status);
  if (!status) throw new SchemaError('India Post', 'India Post returned an invalid tracking status');
  return { snapshot, data: parsed.data, status };
}

function initialTrackComponent(html: string, trackingNumber: string): TrackComponent {
  const $ = load(html);
  for (const element of $('[wire\\:snapshot]').toArray()) {
    const snapshot = $(element).attr('wire:snapshot');
    if (!snapshot) continue;
    try {
      const parsed: unknown = JSON.parse(snapshot);
      if (isRecord(parsed) && isRecord(parsed.memo) && parsed.memo.name === 'track-consignment') {
        return parseTrackSnapshot(snapshot, trackingNumber);
      }
    } catch {
      // A page can contain several unrelated Livewire components.
    }
  }
  throw new SchemaError('India Post', 'India Post did not return its tracking component');
}

function csrfToken(html: string): string {
  const token = clean(load(html)('meta[name="csrf-token"]').attr('content'), 512);
  if (!/^[A-Za-z0-9_-]{20,512}$/.test(token)) {
    throw new SchemaError('India Post', 'India Post did not issue a tracking session token');
  }
  return token;
}

function parseLivewireUpdate(payload: unknown, trackingNumber: string): LivewireUpdate {
  if (!isRecord(payload) || !Array.isArray(payload.components) || payload.components.length !== 1
    || !isRecord(payload.components[0])) {
    throw new SchemaError('India Post', 'India Post returned an invalid Livewire response');
  }
  const rawComponent = payload.components[0];
  if (typeof rawComponent.snapshot !== 'string') {
    throw new SchemaError('India Post', 'India Post returned an invalid Livewire response');
  }
  return {
    component: parseTrackSnapshot(rawComponent.snapshot, trackingNumber),
    effects: isRecord(rawComponent.effects) ? rawComponent.effects : {},
  };
}

/** Names of the analytics events a reply logs, such as `tracking_rate_limited`. */
function loggedEvents(effects: JsonObject): Set<string> {
  if (!Array.isArray(effects.dispatches)) return new Set();
  return new Set(
    effects.dispatches
      .filter(isRecord)
      .filter((dispatch) => dispatch.name === 'log_event' && isRecord(dispatch.params))
      .map((dispatch) => clean((dispatch.params as JsonObject).name, 100))
      .filter(Boolean),
  );
}

const TURNSTILE_REQUIRED = 'India Post tracking asks for a Turnstile check';

/** Once it rate-limits a client, MySpeedPost puts a Turnstile widget on the form. */
function turnstileRequired(html: string): boolean {
  return load(html)('.cf-turnstile').length > 0;
}

function dispatchNames(effects: JsonObject): Set<string> {
  if (!Array.isArray(effects.dispatches)) return new Set();
  return new Set(
    effects.dispatches
      .filter(isRecord)
      .map((dispatch) => clean(dispatch.name, 100))
      .filter(Boolean),
  );
}

// Since 2026-09-24 Cloudflare also injects its passive detection loader
// (/cdn-cgi/challenge-platform/scripts/jsd/main.js) into ordinary answers, so
// only the interstitial's own markers count as a challenge.
function challengePage(status: number, html: string, headers: Headers): boolean {
  return [401, 403, 419, 429].includes(status)
    || headers.get('cf-mitigated') === 'challenge'
    || /Just a moment|Enable JavaScript and cookies|cf-chl-|_cf_chl_opt/i.test(html);
}

/** The poll interval, cut short as soon as the lookup's signal aborts. */
async function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export class IndiaPostTracker {
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
  readonly maxPollAttempts: number;
  readonly fetcher: typeof fetch;
  readonly now: () => Date;

  constructor(options: IndiaPostTrackerOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxPollAttempts = options.maxPollAttempts ?? DEFAULT_MAX_POLL_ATTEMPTS;
    this.fetcher = options.fetcher ?? fetch;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new TypeError('India Post timeout must be positive');
    }
    if (!Number.isFinite(this.pollIntervalMs) || this.pollIntervalMs < 0) {
      throw new TypeError('India Post poll interval cannot be negative');
    }
    if (!Number.isInteger(this.maxPollAttempts) || this.maxPollAttempts < 1) {
      throw new TypeError('India Post poll attempts must be positive');
    }
  }

  private async request(
    fetcher: typeof fetch,
    budget: LookupBudget,
    url: string,
    init: RequestInit,
  ): Promise<{ bytes: Uint8Array; html: string }> {
    const result = await fetchBounded(url, { ...init, signal: budget.signal }, {
      provider: 'India Post tracking',
      timeoutMs: Math.min(this.timeoutMs, budget.remainingMs()),
      maxBytes: MAX_RESPONSE_BYTES,
      redirect: 'manual',
      fetcher,
      allowHttpError: true,
    });
    const html = decodeText(result.bytes);
    if (challengePage(result.response.status, html, result.response.headers)) {
      throw new IndiaPostChallengeError();
    }
    if (!result.response.ok) {
      throw new UpstreamHttpError('India Post tracking', result.response.status);
    }
    return { bytes: result.bytes, html };
  }

  private async update(
    fetcher: typeof fetch,
    budget: LookupBudget,
    trackingNumber: string,
    pageUrl: string,
    token: string,
    snapshot: string,
    calls: JsonObject[],
    updates: JsonObject = {},
  ): Promise<LivewireUpdate> {
    const result = await this.request(fetcher, budget, LIVEWIRE_UPDATE, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Content-Type': 'application/json',
        Origin: 'https://myspeedpost.com',
        Referer: pageUrl,
        'User-Agent': USER_AGENT,
        'X-Livewire': '',
      },
      body: JSON.stringify({
        _token: token,
        components: [{ snapshot, updates, calls }],
      }),
    });
    return parseLivewireUpdate(
      parseJsonBytes(result.bytes, 'India Post tracking'),
      trackingNumber,
    );
  }

  async fetch(trackingNumber: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const normalized = normalizeIndiaPostTrackingNumber(trackingNumber);
    const pageUrl = indiaPostTrackingUrl(normalized);
    // The default budget covers the page, the first update, then every poll
    // after its pause.
    const budget = lookupBudget(
      context,
      (this.maxPollAttempts + 2) * this.timeoutMs + this.maxPollAttempts * this.pollIntervalMs,
    );
    // The Livewire flow is stateful: the session cookie issued with the page
    // must travel with every /livewire/update call, so the jar is per lookup.
    const fetcher = makeFetchCookie(this.fetcher, new CookieJar());
    const page = await this.request(fetcher, budget, pageUrl, {
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': USER_AGENT,
      },
    });
    const initial = initialTrackComponent(page.html, normalized);
    if (initial.status === 'Completed') {
      const cached = parseIndiaPostTrackingHtml(page.html, normalized);
      const syncedAt = typeof cached.source_synced_at === 'string' ? Date.parse(cached.source_synced_at) : NaN;
      if (Number.isFinite(syncedAt) && this.now().getTime() - syncedAt < REFRESH_AFTER_MS) return cached;
      // Without a Turnstile token, Refresh would only reset the widget.
      if (turnstileRequired(page.html)) return cached;
      // What the page's Refresh button sends. A failed refresh still leaves
      // the cached history, which is better than no answer.
      try {
        return await this.complete(fetcher, budget, normalized, pageUrl, csrfToken(page.html), initial.snapshot, [{
          path: '',
          method: '__dispatch',
          params: ['refresh_consignment', { userTimezone: USER_TIMEZONE }],
        }], { userTimezone: USER_TIMEZONE });
      } catch {
        // A caller that cancelled is not waiting for an answer; one whose
        // deadline passed still takes the history already in hand.
        const reason: unknown = context.signal?.reason;
        if (context.signal?.aborted && !(reason instanceof DOMException && reason.name === 'TimeoutError')) throw reason;
        return cached;
      }
    }
    if (!['New', 'Processing'].includes(initial.status)) return otherState(initial.status, page.html, normalized);
    // Submitting without a token only resets the widget.
    if (initial.status === 'New' && turnstileRequired(page.html)) throw new IndiaPostChallengeError(TURNSTILE_REQUIRED);

    const token = csrfToken(page.html);
    return initial.status === 'Processing'
      ? this.complete(fetcher, budget, normalized, pageUrl, token, initial.snapshot, [{
        path: '',
        method: 'fetchStatus',
        params: [],
      }])
      : this.complete(fetcher, budget, normalized, pageUrl, token, initial.snapshot, [{
        path: '',
        method: '__dispatch',
        params: ['set_consignment_number', { consignment_number: normalized }],
      }, {
        path: '',
        method: 'submit',
        params: [USER_TIMEZONE],
      }], { userTimezone: USER_TIMEZONE });
  }

  /** Send the first calls, then poll `fetchStatus` until the component completes. */
  private async complete(
    fetcher: typeof fetch,
    budget: LookupBudget,
    normalized: string,
    pageUrl: string,
    token: string,
    snapshot: string,
    calls: JsonObject[],
    updates: JsonObject = {},
  ): Promise<CarrierResult> {
    let update = await this.update(fetcher, budget, normalized, pageUrl, token, snapshot, calls, updates);
    for (let attempt = 0; attempt <= this.maxPollAttempts; attempt += 1) {
      const names = dispatchNames(update.effects);
      if (names.has('consignment_not_found')) throw new NotFoundError('India Post');
      if (loggedEvents(update.effects).has('tracking_rate_limited')) throw new RateLimitedError('India Post');
      if (names.has('turnstile-reset')) throw new IndiaPostChallengeError(TURNSTILE_REQUIRED);
      const html = typeof update.effects.html === 'string' ? update.effects.html : '';
      if (update.component.status === 'Completed') {
        if (!html) throw new SchemaError('India Post', 'India Post returned an empty completed response');
        return parseIndiaPostTrackingHtml(html, normalized);
      }
      if (update.component.status !== 'Processing') return otherState(update.component.status, html, normalized);
      if (attempt === this.maxPollAttempts) break;
      await pause(this.pollIntervalMs, budget.signal);
      update = await this.update(
        fetcher,
        budget,
        normalized,
        pageUrl,
        token,
        update.component.snapshot,
        [{ path: '', method: 'fetchStatus', params: [] }],
      );
    }
    // The backend kept saying "Processing": it answered, but it proved nothing
    // about the shipment, so this must not become a not-found cooldown.
    throw new IndeterminateError('India Post', 'India Post tracking did not complete in time');
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new IndiaPostTracker({ fetcher: environment.fetcher });
  return {
    id: 'india-post',
    // The Livewire submit-and-poll cycle is part of the direct call: it is one
    // stateful conversation with one host, not a fallback tier.
    steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
