
/**
 * Ship24 (ship24.com), a universal aggregator and the first discovery
 * provider.
 *
 * Two tiers: `direct` is one signed anonymous JSON POST per lookup (see
 * http.ts), `browser` loads the public tracking page in a local Chromium
 * session and reads the same API response from it. The browser tier only runs
 * when a Chromium is configured and the direct tier failed for a reason a
 * browser can repair: a rate limit or a server outage is reported as it is, so
 * the router's backoff is not amplified into a second request, and a number
 * the aggregator does not know stays unknown to the page that asks the same
 * API.
 */
import { DateTime } from 'luxon';
import type { AdapterFactory } from '../../core/adapter/index.js';
import { carrierIdFromName } from '../../core/catalog/hints.js';
import { carrierDefinition } from '../../core/catalog/index.js';
import { IndeterminateError, NoHistoryError, NotFoundError, SchemaError, UpstreamHttpError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import type { StepRecorder } from '../../core/telemetry/index.js';
import { scrapeUniversalPage, type UniversalBrowserOptions } from '../../core/transport/browser.js';
import {
  canadaProvinceTimeZone, countryCode, countryTimeZone, EXPLICIT_OFFSET_PATTERN, firstOccurrence, regionHasTown, sharedClockZone,
  timeZoneCountry, usStateTimeZone,
} from '../../core/time/index.js';
import { isRecord } from '../../core/types.js';
import { correosOriginZone } from '../../carriers/correos-spain/clock.js';
import { seventeenFeiaCopyZone } from '../../carriers/17feia/clock.js';
import { cttSiteZone, portugalZone } from '../../carriers/ctt/clock.js';
import { gofoScanZone } from '../../carriers/gofo/clock.js';
import { swissPostDestinationZone } from '../../carriers/swiss-post/clock.js';
import { trackingPlace } from '../../places/trackingLocation.js';
import { courierZone, universalCarrierHints } from '../shared/hints.js';
import { localEvent, numberOf, place, result, type UniversalSource } from '../shared/result.js';
import { ship24CourierCode } from './couriers.js';
import { Ship24HttpClient } from './http.js';

const SOURCE: UniversalSource = 'Ship24';
const MAX_EVENTS = 1000;
const MAX_COURIERS = 20;
/**
 * What the browser keeps of the budget when the direct tier fails: enough to
 * load the page and read a parcel Ship24 already holds. A slow direct answer
 * is Ship24 querying the carriers, which the page would only start again.
 */
const BROWSER_RESERVE_MS = 10_000;
/** How long a refresh may keep a stored history waiting; most take a few seconds, a stuck carrier query 30. */
const REFRESH_MS = 15_000;
/** The least time left worth asking again with the courier named; most such answers take a second or two. */
const NAMED_COURIER_MIN_MS = 2_000;

const POSTAL_CODE = /\s*\b(?:\d{5}(?:-\d{4})?|[A-Z]\d[A-Z] ?\d[A-Z]\d)$/i;

/**
 * The clock of the US state or Canadian province a location names ("NORTH
 * YORK, ON", "Des Plaines, IL 12345", "Chicago, IL, US"). A code that is also
 * a country's ("IL" is Israel) needs the town to lie in the state, or the
 * country named after it. Any other code needs a scan in North America: an
 * Italian province ("MILANO MI") is no state.
 */
function regionZone(location: string, northAmerican: boolean): string | null {
  const parts = location.split(',').map((part) => part.trim()).filter(Boolean);
  const last = parts.at(-1) ?? '';
  // "CA" after a province is Canada; after a town it is California.
  const country = parts.length > 1 && /^(?:us|usa|united states(?: of america)?)$/i.test(last) ? 'US'
    : (parts.length > 1 && /^canada$/i.test(last)) || (parts.length > 2 && /^ca$/i.test(last)) ? 'CA' : null;
  if (country) parts.pop();
  if (parts.length > 1 && !parts.at(-1)!.replace(POSTAL_CODE, '')) parts.pop();
  const words = (parts.at(-1) ?? '').replace(POSTAL_CODE, '').split(/\s+/);
  const code = parts.length > 1 ? (words.length === 1 ? words[0]! : '') : words.length > 1 ? words.at(-1)! : '';
  const town = parts.length > 1 ? parts.at(-2)! : words.slice(0, -1).join(' ');
  const zone = (country === 'CA' ? null : usStateTimeZone(code)) ?? (country === 'US' ? null : canadaProvinceTimeZone(code));
  if (!zone) return null;
  return country || regionHasTown(code, town) || (northAmerican && !countryCode(code)) ? zone : null;
}

/** 4PX's way of writing a scan abroad: country, state and town ("US  NY  EXAMPLE TOWN 12345"). */
const COUNTRY_STATE_TOWN = /^([A-Z]{2})\s{2,}([A-Z]{2})\s{2,}(\S.*)$/;

/**
 * A scan location's clock: the single clock of the country it names, else of
 * its US state or Canadian province. A feed's one `country` stands for any
 * country the words name.
 */
function locationZone(location: unknown, northAmerican: boolean, country: string | null = null): string | null {
  if (typeof location !== 'string' || !location.trim()) return null;
  const parts = COUNTRY_STATE_TOWN.exec(location.trim());
  if (parts) return countryTimeZone(parts[1]) ?? regionZone(`${parts[3]}, ${parts[2]}, ${parts[1]}`, northAmerican);
  const named = country ?? trackingPlace(location).country;
  return (named ? countryTimeZone(named) : null) ?? regionZone(location, northAmerican);
}

/** Whether a scan's courier works in the US or Canada only, so its state and province codes are theirs. */
function northAmericanCourier(scan: Record<string, unknown>): boolean {
  const courier = isRecord(scan.courier) ? scan.courier : {};
  const country = replyCountry(courier.country_code);
  if (country === 'US' || country === 'CA') return true;
  const name = isRecord(courier.translation) ? courier.translation.name : null;
  const carrier = typeof name === 'string' ? carrierIdFromName(name) : undefined;
  const countries = carrier ? carrierDefinition(carrier).countries ?? [] : [];
  return countries.length > 0 && countries.every((code) => code === 'US' || code === 'CA');
}

/** A country code Ship24 gives, which can be the retired "UK". */
function replyCountry(value: unknown): string | null {
  return typeof value === 'string' ? countryCode(value.trim().toUpperCase() === 'UK' ? 'GB' : value) : null;
}

/** A town and a country code in brackets: "Example Town (DE)". */
const TOWN_CODE = /^[^()]+\(([A-Z]{2})\)$/;

/**
 * The clock of a scan located as a town and a code in brackets, when the code
 * is the country Ship24 gives for the scan's courier and that country keeps
 * one clock. Alone, "(DE)" could be Delaware's. DPD Germany's feed writes its
 * scans so, without an offset, on the digits DPD Germany's own tracker dates
 * on Berlin's clock.
 */
function courierCountryZone(scan: Record<string, unknown>, location: string): string | null {
  const code = TOWN_CODE.exec(location)?.[1];
  const country = isRecord(scan.courier) ? replyCountry(scan.courier.country_code) : null;
  return code && country && replyCountry(code) === country ? countryTimeZone(country) : null;
}

/**
 * UPU events (EMSEVT) by the side of the border they happen on: the origin
 * post's until the item leaves its outward office of exchange, the
 * destination post's from its inward office on. National posts report them in
 * these words too, and EMS's feed in its own ("Posted", "Departed from export
 * office"), at a place written as a code ("GZSGJHHJ").
 */
const UPU_ORIGIN = new Set(['posting/collection', 'arrival at outward office of exchange', 'departure from outward office of exchange',
  'dispatch from outward office of exchange', 'item held at outward office of exchange', 'item presented to export customs/security',
  'item held by export customs/security', 'item returned from export customs/security',
  'posted', 'arrived at export office', 'presented to export customs and security', 'released from export customs and security',
  'departed from export office']);
const UPU_DESTINATION = new Set(['arrival at inward office of exchange', 'item held at inward office of exchange',
  'departure from inward office of exchange', 'item presented to import customs', 'held by import customs', 'held by customs',
  'item returned from customs (import)', 'item into sorting centre', 'item out of sorting centre', 'item held at delivery depot',
  'arrival at delivery office', 'item out for physical delivery', 'item arrival at collection point for pick-up', 'final delivery']);
const RETURNED = /\breturn(?:ed)? to sender\b/i;

/** Where the reply says the parcel travels, for the clocks its scans may keep. */
interface Journey {
  number: string;
  couriers: string[];
  origin: string | null;
  destination: string | null;
  /**
   * The origin, when an S10 suffix does not name another post: Asendia's
   * Swiss numbers are posted at Swiss Post's offices of exchange abroad.
   */
  postOrigin: string | null;
  /** The one country of a parcel that starts and ends there. */
  domestic: string | null;
  /** Whether the parcel crosses a border, so a relay can name a scan abroad as its own. */
  international: boolean;
  /** Whether the parcel starts or ends in the US or Canada. */
  northAmerican: boolean;
  /** The first wall time the item was sent back, after which its UPU events run the other way. */
  returned: string | null;
  fallback: string | null;
}

/**
 * A courier feed Ship24 relays with an offset its scans never had, by Ship24's
 * crawler code. The digits are the scan's wall clock, placed like an
 * offset-less scan's. Checked against each carrier's own data (2026-10-10):
 * - Canada Post's say -05:00 on every scan, where Canada Post says -04:00 for
 *   Ottawa in October;
 * - UniUni's say Z on the depot's clock, which UniUni's own `pathTime` does too;
 * - GOFO's US feed puts GOFO's -07:00 on the clock GOFO gives the scan
 *   (`processTimeZone`), and names its station (`processLocation`) without a state;
 * - PostNL's say Z on postnl.post's `datetime_local`;
 * - Amazon UK's say Z on the marketplace's clock, which Amazon shows without one;
 * - CTT's say Z, as CTT's own tracker does (carriers/ctt/clock.ts);
 * - 17FEIA's say Z on the wall clocks its own rows keep, and drop the country
 *   of its order data and warehouse steps (carriers/17feia/clock.ts).
 */
interface Feed {
  /** Ship24's crawler code, which keeps one feed's scans together. */
  code: string;
  /** The zone the feed read the wall clock in to make its instant: 4PX's `tkDate` reads it on China's. */
  shift?: string;
  /**
   * The one country the feed's scans are in, whatever their locations' words:
   * GOFO's US feed names towns without a state, and "Jamaica" is one.
   */
  country?: string;
  /** The clock a scan's location and wording name, before any other reading. */
  place?: (location: string, journey: Journey, status: string) => string | null;
  /** Where the feed's scans are, for a parcel that stays in one country, when nothing else places them. */
  home?: (location: string) => string | null;
  /** The last guess for a scan nothing else places: Ship24's own label, Pacific time, for GOFO's. */
  own?: string;
  /** The feed's scans whose offset is real after all, by their wording and an empty location. */
  stated?: (status: string) => boolean;
  /** A scan nothing places keeps its wall clock instead of borrowing a neighbour's or the courier's. */
  walls?: true;
}

const RELABELLED_FEEDS: Readonly<Record<string, Omit<Feed, 'code'>>> = {
  'canada-post-tracking': {},
  'uniuni-tracking': {},
  'gofo-express-tracking': { country: 'US', place: (location, _journey, status) => gofoScanZone(location, status), own: 'America/Los_Angeles' },
  // PostNL's label creation and processing record name no country and keep UTC (carriers/spring-gds).
  'postnl-tracking': { stated: (status) => /^(?:The shipping label has been created|The item is being processed)$/i.test(status.trim()) },
  'amazon-uk-tracking': { home: () => 'Europe/London' },
  'portugal-ctt-tracking': { place: (location, journey) => cttSiteZone(location, [journey.origin, journey.destination]), home: portugalZone },
  '4px-tracking': { shift: 'Asia/Shanghai' },
  // A status is 17FEIA's words, then its label or "OTHER".
  'feia-tracking': { place: (location, _journey, status) => seventeenFeiaCopyZone(status.replace(/,\s*[^,]*$/, ''), location), walls: true },
};

function feedOf(scan: Record<string, unknown>): Feed | null {
  const code = isRecord(scan.courier) ? scan.courier.crawler_code : null;
  return typeof code === 'string' && Object.hasOwn(RELABELLED_FEEDS, code) ? { code, ...RELABELLED_FEEDS[code] } : null;
}

/**
 * Feeds whose offset-less timestamps are UTC instants, not wall clocks. InPost
 * UK's give the instants InPost's hub dates with an offset, which Collect+'s
 * copies of the same scans date "+01:00" on London's summer clock (2026-10-16).
 */
const UTC_FEEDS = new Set(['inpost-uk-tracking']);

function utcClock(scan: Record<string, unknown>): unknown {
  const code = isRecord(scan.courier) ? scan.courier.crawler_code : null;
  return typeof code === 'string' && UTC_FEEDS.has(code) && typeof scan.timestamp === 'string'
    && !EXPLICIT_OFFSET_PATTERN.test(scan.timestamp) ? `${scan.timestamp}Z` : scan.timestamp;
}

/**
 * Mainfreight's air and ocean jobs list planned milestones beside those that happened, and its
 * own tracker marks them "(Estimated)" (carriers/mainfreight). Its feed here drops the mark, so a
 * milestone whose clock has yet to come anywhere on Earth is a plan, not a scan.
 */
const PLANNING_FEEDS = new Set(['mainfreight-tracking']);

/**
 * The milestones of a Mainfreight air or ocean job, as its feed words them. The job's scans are
 * the port's or site's wall clock, wherever that is (carriers/mainfreight), so a job with one
 * leaves its unplaced scans on their wall clocks rather than on Mainfreight's catalog clock or
 * routing's, New Zealand's, which only its transport scans there keep.
 */
const FORWARDING_MILESTONES = /^(?:booking confirmation sent|pick ?up cartage (?:advised|complete)|origin customs cleared|departure from first load port|arrival at final discharge port|customs clearance (?:commenced|finalised)|cargo (?:available|delivered))$/i;

function forwardingJob(scans: unknown[]): boolean {
  return scans.some((scan) => isRecord(scan) && isRecord(scan.courier) && scan.courier.crawler_code === 'mainfreight-tracking'
    && typeof scan.status === 'string' && FORWARDING_MILESTONES.test(scan.status.trim()));
}

function planned(scan: Record<string, unknown>, event: CarrierEvent, now: number): boolean {
  const code = isRecord(scan.courier) ? scan.courier.crawler_code : null;
  if (typeof code !== 'string' || !PLANNING_FEEDS.has(code)) return false;
  const moment = event.time ? DateTime.fromISO(event.time)
    : typeof event.local_time === 'string' ? firstOccurrence(DateTime.fromISO(event.local_time, { zone: 'UTC+14' })) : null;
  return Boolean(moment?.isValid && moment.toMillis() > now);
}

/** A relabelling feed's timestamp as the scan's wall clock; any other is left as Ship24 sent it. */
function feedClock(timestamp: unknown, feed: Feed | null, scan: Record<string, unknown>): unknown {
  if (!feed || typeof timestamp !== 'string' || !EXPLICIT_OFFSET_PATTERN.test(timestamp)) return timestamp;
  if (feed.stated && !place(scan.location) && typeof scan.status === 'string' && feed.stated(scan.status)) return timestamp;
  if (!feed.shift) return timestamp.replace(EXPLICIT_OFFSET_PATTERN, '');
  const shifted = DateTime.fromISO(timestamp, { setZone: true }).setZone(feed.shift);
  return shifted.isValid ? shifted.toISO({ includeOffset: false, suppressMilliseconds: true }) : timestamp;
}

/**
 * The zone of a scan Swiss Post's feed relays from the destination post: the
 * feed keeps Swiss Post's offset, on digits that are that office's wall clock
 * (carriers/swiss-post/clock.ts). Null for any other scan.
 */
function swissPostRelayZone(scan: Record<string, unknown>, journey: Journey): string | null {
  if (!isRecord(scan.courier) || scan.courier.crawler_code !== 'swiss-post-tracking') return null;
  return swissPostDestinationZone(typeof scan.status === 'string' ? scan.status : '',
    typeof scan.location === 'string' ? scan.location : '', journey.destination);
}

/**
 * Correos's copy of the origin post's scan on an item from abroad
 * (carriers/correos-spain/clock.ts): that post's zone, or null for a country on
 * several clocks, whose wall clock it keeps. Undefined for any other scan. The
 * courier is the scan's, else the reply's only one.
 */
function correosOriginCopy(scan: Record<string, unknown>, journey: Journey): string | null | undefined {
  const named = isRecord(scan.courier) && isRecord(scan.courier.translation) ? scan.courier.translation.name : undefined;
  const name = named ?? (journey.couriers.length === 1 ? journey.couriers[0] : undefined);
  return typeof name === 'string' && carrierIdFromName(name) === 'correos-spain' && typeof scan.status === 'string'
    ? correosOriginZone(journey.number, { wording: scan.status }) : undefined;
}

function journeyOf(data: Record<string, unknown>, events: unknown[], number: string, couriers: string[], fallback: string | null): Journey {
  // An S10 item's suffix is its origin post's country.
  const suffix = /^[A-Z]{2}\d{9}[A-Z]{2}$/.test(number) ? replyCountry(number.slice(-2)) : null;
  const origin = replyCountry(data.origin_country_code) ?? suffix;
  const destination = replyCountry(data.destination_country_code);
  const returned = events.flatMap((scan) => isRecord(scan) && typeof scan.status === 'string' && RETURNED.test(scan.status)
    && typeof scan.timestamp === 'string' ? [scan.timestamp.slice(0, 19)] : []).sort()[0] ?? null;
  return { number, couriers, origin, destination, fallback, returned,
    postOrigin: !suffix || suffix === origin ? origin : null,
    domestic: origin && origin === destination ? origin : null,
    international: Boolean(origin && destination && origin !== destination),
    northAmerican: [origin, destination].some((country) => country === 'US' || country === 'CA') };
}

/** The clock of the country a UPU event's words place it in, for an item on its way out. */
function upuZone(journey: Journey, scan: Record<string, unknown>, wall: string): string | null {
  if (!journey.international || typeof scan.status !== 'string' || (journey.returned && wall > journey.returned)) return null;
  const status = scan.status.trim().toLowerCase();
  const country = UPU_ORIGIN.has(status) ? journey.postOrigin
    : UPU_DESTINATION.has(status) || status.startsWith('unsuccessful delivery') ? journey.destination : null;
  return country ? countryTimeZone(country) : null;
}

/**
 * The zone of a scan whose timestamp names no offset, or a relabelling
 * feed's: it is the scanning carrier's wall clock. Its location's clock comes
 * first (as the feed reads its own sites and stations, then by the names it holds,
 * then a bracketed code its courier's country confirms), then
 * the country of a parcel that never leaves it, then the side of the border a
 * UPU event's words name. A courier name is the feed that relayed the scan,
 * not where it happened: a national post relays the destination's scans under
 * its own name. So for a parcel that crosses a border, those are all.
 * Otherwise the feed's home clock follows. Null when none of them places it.
 */
function placedZone(journey: Journey, scan: Record<string, unknown>, wall: string, feed: Feed | null): string | null {
  const location = typeof scan.location === 'string' ? scan.location.trim() : '';
  const located = feed?.place?.(location, journey, typeof scan.status === 'string' ? scan.status : '')
    ?? locationZone(location, journey.northAmerican || northAmericanCourier(scan), feed?.country ?? null)
    ?? courierCountryZone(scan, location) ?? (journey.domestic ? countryTimeZone(journey.domestic) : null) ?? upuZone(journey, scan, wall);
  return located || journey.international ? located : feed?.home?.(location) ?? null;
}

/**
 * For a parcel that stays in one country, the clock every courier the reply
 * names keeps at that moment (La Poste and its Chronopost leg), else the zone
 * routing passes for the parcel's carrier.
 */
function namedZone(journey: Journey, wall: string): string | null {
  if (journey.international) return null;
  const zones = journey.couriers.map((name) => courierZone(name, journey.number, wall));
  const named = zones.length && zones.every((zone): zone is string => zone !== null) ? sharedClockZone(zones, wall) : null;
  return named ?? journey.fallback;
}

/** The country a scan's location names ("USA", "US  NY  EXAMPLE TOWN"), or null. */
function locationCountry(location: unknown): string | null {
  if (typeof location !== 'string' || !location.trim()) return null;
  return COUNTRY_STATE_TOWN.exec(location.trim())?.[1] ?? trackingPlace(location).country;
}

const CODES = Array.from({ length: 26 * 26 }, (_, index) => String.fromCharCode(65 + Math.floor(index / 26), 65 + (index % 26)));
const US_ZONES = new Set(CODES.map(usStateTimeZone).filter(Boolean));
const CANADA_ZONES = new Set(CODES.map(canadaProvinceTimeZone).filter(Boolean));

/** The country whose clock a placed scan was read on, when only one keeps that zone. */
function zoneCountry(zone: string): string | null {
  return timeZoneCountry(zone) ?? (US_ZONES.has(zone) ? 'US' : CANADA_ZONES.has(zone) ? 'CA' : null);
}

/** A scan read so far: a wall clock, with its feed, the country it names and the zone that places it. */
interface Reading { event: CarrierEvent; wall: string | null; feed: Feed | null; country: string | null; zone: string | null }

/**
 * The zone a relabelling feed's scan borrows when nothing places it, a guess:
 * the zone of the nearest earlier scan of the same feed that is placed, else
 * of the nearest later one. The scans of one feed are mostly one network's,
 * which rarely changes clocks between two of them. A scan whose location
 * names a country only borrows from one in the same: Canada Post relays
 * USPS's scans ("CHICAGO,USA"), which a Toronto scan's clock does not place.
 * On a parcel that crosses a border, a scan before every placed one only
 * borrows from one in the origin country: the parcel may not have left it,
 * and the destination's pre-advice (4PX's USPS label) can come first.
 */
function borrowedZone(readings: readonly Reading[], reading: Reading, journey: Journey): string | null {
  let earlier: Reading | null = null, later: Reading | null = null;
  for (const other of readings) {
    if (!other.zone || !other.wall || other.feed?.code !== reading.feed?.code || !reading.wall) continue;
    const country = other.country ?? zoneCountry(other.zone);
    if (reading.country && country !== reading.country) continue;
    if (other.wall <= reading.wall) {
      if (!earlier || other.wall > earlier.wall!) earlier = other;
    } else if ((reading.country || !journey.international || country === journey.origin) && (!later || other.wall < later.wall!)) {
      later = other;
    }
  }
  return earlier?.zone ?? later?.zone ?? null;
}

export function parseShip24Response(payload: unknown, trackingNumber: string, timezone: string | null = null, now = Date.now()): CarrierResult {
  const number = numberOf(trackingNumber);
  const data = isRecord(payload) && isRecord(payload.data) ? payload.data : null;
  if (!data || data.tracking_number !== number || data.error
    || (data.events !== undefined && (!Array.isArray(data.events) || data.events.length > MAX_EVENTS))) {
    throw new SchemaError(SOURCE, 'Ship24 has no matching shipment history');
  }
  // Ship24 knows the parcel but holds no scan: it has yet to query the
  // carriers (`to_updated`), or it did and they had nothing.
  if (!Array.isArray(data.events) || !data.events.length) {
    if (data.to_updated === true) throw new IndeterminateError(SOURCE, 'Ship24 has not queried the carriers for the shipment yet');
    throw new NoHistoryError(SOURCE, 'Ship24 found the shipment but no scans for it yet');
  }
  // The public frontend renders couriers[].translation.name. Keep names only;
  // website/phone fields and alternate numbers are not needed for discovery.
  const couriers = Array.isArray(data.couriers) ? data.couriers.slice(0, MAX_COURIERS) : [];
  const names = universalCarrierHints(couriers.map((courier) =>
    isRecord(courier) && isRecord(courier.translation) ? courier.translation.name : undefined), number);
  const journey = journeyOf(data, data.events, number, names.reported_carriers, timezone);
  const forwarding = forwardingJob(data.events);
  const readings: Reading[] = [];
  for (const raw of data.events) {
    if (!isRecord(raw)) throw new SchemaError(SOURCE, 'Ship24 returned an invalid event');
    // A scan dated without a time (GLS Italy's announcement) has no place
    // among the others; it is left out rather than failing the history.
    if (typeof raw.timestamp === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.timestamp)) continue;
    // datetime can end in Z while still containing the carrier's local time.
    // timestamp carries the real offset (verified against the public web app),
    // except for some carrier legs (Chronopost) that omit it entirely, the
    // feeds that relabel the carrier's wall clock or leave UTC unlabelled, and
    // Swiss Post's relays.
    const feed = feedOf(raw);
    const relayed = swissPostRelayZone(raw, journey);
    const clock = relayed && typeof raw.timestamp === 'string' ? raw.timestamp.replace(EXPLICIT_OFFSET_PATTERN, '') : feedClock(utcClock(raw), feed, raw);
    const parsed = localEvent(clock, raw.status, raw.dispatch_code_id === 7 ? 'Delivered' : undefined);
    if (!parsed || planned(raw, parsed, now)) continue;
    const location = place(raw.location);
    if (location) parsed.location = location;
    const wall = typeof parsed.local_time === 'string' ? parsed.local_time : null;
    // Another feed's offset-less scan takes the parcel's named clock at once;
    // a relabelling feed's first borrows from its neighbours (below), and a
    // forwarding job's keeps its wall clock.
    const unnamed = feed || (forwarding && isRecord(raw.courier) && raw.courier.crawler_code === 'mainfreight-tracking');
    // Correos's copy of an origin post's scan takes that post's clock, or keeps its wall clock.
    const sent = wall ? correosOriginCopy(raw, journey) : undefined;
    readings.push({ event: parsed, wall, feed, country: feed?.country ?? locationCountry(raw.location),
      zone: wall ? relayed ?? (sent !== undefined ? sent : placedZone(journey, raw, wall, feed) ?? (unnamed ? null : namedZone(journey, wall))) : null });
  }
  const events = readings.map((reading): CarrierEvent => {
    const { event, wall, feed } = reading;
    const zone = reading.zone ?? (wall && feed && !feed.walls ? borrowedZone(readings, reading, journey) ?? namedZone(journey, wall) ?? feed.own ?? null : null);
    const instant = wall && zone ? firstOccurrence(DateTime.fromISO(wall, { zone })) : null;
    if (!instant?.isValid) return event;
    const timed: CarrierEvent = { ...event, time: instant.toUTC().toISO() };
    delete timed.local_time;
    return timed;
  });
  return { ...result(events, SOURCE), ...names };
}

/**
 * A browser cannot repair a rate limit or a server outage: keep the original
 * status and Retry-After for the router's backoff instead of asking twice.
 * Nor can it find a parcel the API answered 404 for, show a courier Ship24
 * keeps for subscribers, or find scans Ship24 said it has none of: the page
 * asks the same API and shows the same answer.
 */
function browserCanRecover(error: unknown): boolean {
  return !(error instanceof NoHistoryError) && !(error instanceof NotFoundError) && !(error instanceof UpstreamHttpError
    && (error.status === 404 || error.status === 410 || error.status === 429 || error.status >= 500));
}

/**
 * The parcel as the web app shows it: the stored record, refreshed when it
 * says `to_updated`. The refresh is Ship24 querying the carriers again. If it
 * fails or is slow, a stored history stands, as on the website; a record with
 * no scans yet is no answer, so the refresh's failure is.
 *
 * Ship24 answers 404 for some couriers' parcels until the visitor names the
 * courier, as the page's "Add details" dialog does. With the code of the
 * carrier the parcel is filed under, a 404 is asked once more naming it. A
 * 404 to that keeps the first; any other failure, a rate limit included, is
 * the answer.
 */
async function currentParcel(http: Ship24HttpClient, number: string, budgetMs: number, signal?: AbortSignal, courier?: string): Promise<unknown> {
  const deadline = performance.now() + budgetMs;
  const left = () => Math.max(1, Math.floor(deadline - performance.now()));
  const stored = await http.fetch(number, left(), signal).catch((error: unknown) => {
    if (!courier || !(error instanceof UpstreamHttpError) || error.status !== 404 || signal?.aborted || left() < NAMED_COURIER_MIN_MS) throw error;
    return http.fetch(number, left(), signal, courier).catch((named: unknown) => {
      throw named instanceof UpstreamHttpError && named.status === 404 ? error : named;
    });
  });
  const data = isRecord(stored) && isRecord(stored.data) && stored.data.tracking_number === number ? stored.data : null;
  if (data?.to_updated !== true || typeof data._id !== 'string') return stored;
  const scanned = Array.isArray(data.events) && data.events.length > 0;
  try {
    const fresh = await http.refresh(data._id, number, scanned ? Math.min(left(), REFRESH_MS) : left(), signal);
    const current = isRecord(fresh) && isRecord(fresh.data) && fresh.data.tracking_number === number ? fresh.data : null;
    // A refresh that brings back no scans, or an error, does not unsay the stored ones.
    const usable = current && (!scanned || (!current.error && Array.isArray(current.events) && current.events.length > 0));
    return usable ? fresh : stored;
  } catch (error) {
    if (signal?.aborted || !scanned) throw error;
    return stored;
  }
}

export interface Ship24Options extends Omit<UniversalBrowserOptions, 'signal'> {
  /** The signed HTTP client for the direct tier; without one the browser tier runs alone. */
  httpClient?: Ship24HttpClient | null;
  recorder?: StepRecorder;
}

export class Ship24Tracker {
  constructor(readonly options: Ship24Options = {}) {}

  /** `carrier` is the catalog id the parcel is filed under, a hint for the lookup. */
  async fetch(trackingNumber: string, budgetMs?: number, timezone: string | null = null, signal?: AbortSignal,
    carrier: string | null = null): Promise<CarrierResult> {
    const number = numberOf(trackingNumber);
    const timeoutMs = budgetMs ?? this.options.timeoutMs ?? 45_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) throw new TypeError('Ship24 timeout must be between 1 and 60000 ms');
    const http = this.options.httpClient ?? null;
    const browser = http === null || Boolean(this.options.executablePath);
    const courier = ship24CourierCode(carrier);
    return runSteps({ carrier: SOURCE, budgetMs: timeoutMs, signal, recorder: this.options.recorder }, [
      {
        id: 'direct',
        enabled: http !== null,
        run: async ({ remainingMs, signal }) => ({
          ...parseShip24Response(await currentParcel(http!, number, browser
            ? Math.max(remainingMs / 2, remainingMs - BROWSER_RESERVE_MS) : remainingMs, signal, courier), number, timezone),
          tracking_source: 'structured-web-response',
        }),
      },
      {
        id: 'browser',
        // Without a Chromium this tier could only replace the direct failure
        // with its own configuration error. Alone, it still runs to report it.
        enabled: browser,
        recovers: browserCanRecover,
        run: async ({ remainingMs, signal }) => ({
          ...await scrapeUniversalPage({ executablePath: this.options.executablePath, timeoutMs: Math.max(1, Math.floor(remainingMs)), signal }, {
            name: SOURCE, url: `https://www.ship24.com/tracking?p=${number}`,
            responseUrl: `https://api.ship24.com/api/parcels/${number}?lang=en`,
          }, (payload) => parseShip24Response(payload, number, timezone)),
          tracking_source: 'browser-session-response',
        }),
      },
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new Ship24Tracker({
    httpClient: new Ship24HttpClient(environment.fetcher, environment.userAgent),
    executablePath: environment.browserExecutablePath ?? undefined,
    recorder: environment.recorder,
  });
  return {
    id: SOURCE,
    steps: ['direct', 'browser'],
    track: (input, context) => tracker.fetch(input.number, context?.budgetMs, input.timezone ?? null, context?.signal, input.carrier ?? null),
  };
};
