
/**
 * 17TRACK (t.17track.net), a universal aggregator with richer China Post history.
 *
 * Transport: the browser service loads the public tracking page and captures
 * the page's own `restapi` response; unsigned direct probes answer HTTP 200
 * with a rejection code instead of history (verified 2026-09-10). The parser
 * keeps only history whose shipment number equals the requested one, and turns
 * the provider's own rejection codes into typed errors so routing can tell a
 * verification wall from an outage.
 */
import { DateTime } from 'luxon';
import type { AdapterFactory } from '../../core/adapter/index.js';
import { carrierIdFromName } from '../../core/catalog/hints.js';
import { isValidS10TrackingNumber } from '../../core/detection/s10.js';
import { ChallengeError, IndeterminateError, InputRequiredError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import type { StepRecorder } from '../../core/telemetry/index.js';
import { countryTimeZone, firstOccurrence } from '../../core/time/index.js';
import type { TrawlClient } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { trackingPlace } from '../../places/trackingLocation.js';
import { chinaPostEnglish, chinaPostLabelPlace } from '../../carriers/china-post/status.js';
import { agencyIntake, cttSiteZone, isCttExpressAgency } from '../../carriers/ctt/clock.js';
import { correosOriginZone } from '../../carriers/correos-spain/clock.js';
import { daiPostRelayZone } from '../../carriers/dai-post/clock.js';
import { HYWL_CHINA_ZONE, hywlInChina } from '../../carriers/hywl/clock.js';
import { placedInIndia } from '../../carriers/shiprocket/clock.js';
import { swissPostDestinationZone } from '../../carriers/swiss-post/clock.js';
import { uspsScanZone } from '../../carriers/usps/clock.js';
import { universalCarrierHints } from '../shared/hints.js';
import { capturedBodies, captureFailure, loadCapture, type CaptureSpec } from '../shared/capture.js';
import { facilityZone, LatestScan, relaysFacilityClock } from '../shared/facilityClock.js';
import { numberOf, place, result, text, trailingPlace, type UniversalSource } from '../shared/result.js';
import { seventeenTrackCarrierKeys } from './carriers.js';
import { seventeenTrackEvent, undatedScan } from './events.js';

const SOURCE: UniversalSource = '17TRACK';
const API_URL = 'https://t.17track.net/track/restapi';
/** Codes the provider returns when it wants an interactive verification. */
const VERIFICATION_CODES = [-11, -13, -14];
const MAX_PROVIDERS = 20;
const MAX_EVENTS = 1000;

/** The provider answered, but its lookup did not produce history for this shipment. */
export class SeventeenTrackLookupError extends TransportError {
  constructor(
    override readonly reason: 'lookup_unavailable' | 'lookup_pending',
    readonly providerCode: number,
    readonly providerMessage?: string,
  ) {
    super(SOURCE, describeLookup(reason, providerCode, providerMessage));
    this.name = 'SeventeenTrackLookupError';
  }
}

/** A matching code-400/null-shipment reply supplies no history, not a network failure or a proven invalid number. */
export class SeventeenTrackNoHistoryError extends NoHistoryError {
  override readonly reason = 'no_history';
  readonly providerCode = 400;

  constructor() {
    super(SOURCE, describeLookup('no_history', 400));
    this.name = 'SeventeenTrackNoHistoryError';
  }
}

/** The provider asked for an interactive verification the unattended lookup cannot pass. */
export class SeventeenTrackVerificationError extends ChallengeError {
  override readonly reason = 'verification_required';

  constructor(readonly providerCode: number, readonly providerMessage?: string) {
    super(SOURCE, describeLookup('verification_required', providerCode, providerMessage));
    this.name = 'SeventeenTrackVerificationError';
  }
}

function describeLookup(reason: string, providerCode: number, providerMessage?: string): string {
  return `${SOURCE}: ${reason} (code ${providerCode}${providerMessage ? `: ${providerMessage}` : ''})`;
}

/**
 * Shipment code 402, the cap 17TRACK puts on one address's USPS lookups. It
 * answered, about no shipment and no other carrier, so it is no outage either:
 * a host that cooled the provider down for it would lose it for every carrier.
 */
export class SeventeenTrackQuotaError extends IndeterminateError {
  override readonly reason = 'usps_quota';
  readonly providerCode = 402;
  constructor() {
    super(SOURCE, '17TRACK has spent its USPS lookups for this address');
    this.name = 'SeventeenTrackQuotaError';
  }
}

/** Structured replies without usable history; polling may still produce a later success. */
export function isSeventeenTrackLookupError(error: unknown): error is SeventeenTrackLookupError | SeventeenTrackNoHistoryError | SeventeenTrackQuotaError | SeventeenTrackVerificationError {
  return error instanceof SeventeenTrackLookupError || error instanceof SeventeenTrackNoHistoryError
    || error instanceof SeventeenTrackQuotaError || error instanceof SeventeenTrackVerificationError;
}

function lookupError(code: number, providerMessage?: string): Error {
  return VERIFICATION_CODES.includes(code)
    ? new SeventeenTrackVerificationError(code, providerMessage)
    : new SeventeenTrackLookupError('lookup_unavailable', code, providerMessage);
}

/** A scan's clock as the carrier wrote it, without any offset. */
function rawClock(raw: Record<string, unknown>): string | null {
  const clock = isRecord(raw.time_raw) ? raw.time_raw : null;
  return clock && typeof clock.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(clock.date)
    && typeof clock.time === 'string' && /^\d{2}:\d{2}:\d{2}$/.test(clock.time) ? `${clock.date}T${clock.time}` : null;
}

/** A scan's clock as the carrier wrote it, read as UTC only to compare it with another's. */
function wallMillis(raw: Record<string, unknown>): number {
  const wall = rawClock(raw);
  return wall ? Date.parse(`${wall}Z`) : Number.NaN;
}

/** The offset-less clock of a scan whose offset 17TRACK added itself. */
function facilityWall(raw: Record<string, unknown>): string | null {
  return isRecord(raw.time_raw) && raw.time_raw.timezone === null ? rawClock(raw) : null;
}

/**
 * 17TRACK labels such a clock with a zone it gives the carrier, at that zone's
 * offset on the day it looks rather than on the scan's: after October's change
 * it put +01:00 on BRT's July scans and on DPD Germany's and Correos Spain's
 * September scans, which it had labelled +02:00 in summer (checked 2026-10-25).
 * The zone is the leg's country's when that keeps one clock, but GLS's: 17TRACK
 * names Great Britain for GLS and labels its scans on Central European time.
 */
const LABEL_ZONES: Record<number, string> = { 100005: 'Europe/Berlin' };

function labelZone(provider: Record<string, unknown>): string | null {
  return typeof provider.key === 'number' && Object.hasOwn(LABEL_ZONES, provider.key)
    ? LABEL_ZONES[provider.key]! : countryTimeZone(provider.country);
}

/**
 * `zone` when 17TRACK labelled the scan's clock with the zone's offset `now`
 * and the scan's own date keeps another, so it is read on that zone's clock at
 * its own date. A label the zone does not keep now is someone else's and stays.
 */
function seasonZone(raw: Record<string, unknown>, zone: string | null, now: DateTime): string | null {
  const wall = facilityWall(raw);
  if (!wall || !zone || typeof raw.time_iso !== 'string') return null;
  const shown = DateTime.fromISO(raw.time_iso, { setZone: true });
  const own = firstOccurrence(DateTime.fromISO(wall, { zone }));
  return shown.isValid && own.isValid && shown.toFormat("yyyy-MM-dd'T'HH:mm:ss") === wall
    && shown.offset === now.setZone(zone).offset && shown.offset !== own.offset ? zone : null;
}

/**
 * 17TRACK's carrier 100016, Asendia USA, relays A1's tracking: A1 dates every
 * scan in UTC, its partners' too. A Swiss Post scan at 18:20 +02:00 is A1's
 * 16:20, a German delivery round 09:07 local is its 07:07. 17TRACK labels
 * those digits with US Eastern time (checked 2026-10-10).
 */
function relaysUtcClock(key: unknown): boolean {
  return key === 100016;
}

/**
 * 17TRACK's carrier 19031, Correo El Salvador, relays Correos de El Salvador's
 * tracker, which dates its own scans in UTC and keeps the origin post's, which
 * it receives by EDI and marks outbound, at that office's wall clock: its
 * arrival in San Salvador at 21:30:17 is UPU's 15:30 local, and its copy of
 * Swiss Post's departure from Geneva keeps Geneva's 12:20. 17TRACK labels them
 * all with -05:00 (checked 2026-10-11). The copies are read on the clock of
 * the origin an S10 suffix names; from a country on several clocks they keep
 * 17TRACK's reading, the last guess.
 */
const CORREO_EL_SALVADOR = 19031;
/** The origin post's scans, in Correos de El Salvador's words: "(salida)", "(recibido por EDI)". */
const OUTBOUND = /\((?:salida|recibido por EDI)\)$/i;

/**
 * 17TRACK's carrier 19181, Correos Spain, shows Correos's wall clocks, worded
 * "PHASE, summary, details", and puts Madrid's offset on them. On an item from
 * abroad, Correos lists the origin post's scans at that post's wall clock
 * (carriers/correos-spain/clock.ts): they are read on the clock of the country
 * the S10 code's suffix names, as Correos's adapter reads them, and from a
 * country on several clocks they keep their wall clock.
 */
const CORREOS_SPAIN = 19181;

/**
 * 17TRACK's carrier 16101, CTT, shows CTT's wall clocks and puts Portugal's
 * offset on them. A CTT Express agency's scan in Spain, and the acceptance CTT
 * records with no place as the agency takes the parcel in, came on Lisbon's
 * clock, an hour after CTT's own tracker dates them on Madrid's. A row is read
 * on the clock its place names, as CTT's adapter reads it (carriers/ctt/clock.ts).
 */
const CTT = 16101;

/**
 * 17TRACK's carrier 19251, Swiss Post, whose leg relays the destination post's
 * scans as Swiss Post does (carriers/swiss-post/clock.ts).
 */
const SWISS_POST = 19251;

/**
 * 17TRACK's carrier 100662, Shiprocket, shows the wall clocks of its rows,
 * India's for those of the hubs in India, and 17TRACK labels them with US
 * Eastern time: each Delhi hub scan came with the clock Shiprocket's own page
 * shows on India's time, under -04:00, so nine and a half hours late. A row
 * placed in India is read on India's clock. Any other keeps its wall clock,
 * as Shiprocket's adapter keeps a row abroad's or a partner's.
 */
const SHIPROCKET = 100662;

/**
 * 17TRACK's carrier 192109, Huiyi Logistics, keeps the "+00:00" of its rows,
 * whose digits are the line's wall clocks. Read as labeled, most of its rows
 * in China fell between midnight and 06:00 there; on Beijing's clock all fell
 * in the day (checked 2026-10-21). A row placed in China or Hong Kong is read on
 * Beijing's clock, as Huiyi Logistics' adapter reads it; any other keeps its
 * wall clock, as that adapter keeps it. An Italian dispatch scan came with
 * the line's own wall clock under "+00:00", so read as labeled it stood two
 * hours from the line's copy of the same scan (checked 2026-10-25).
 */
const HYWL = 192109;

/**
 * 17TRACK's carrier 100790, DAI Post, shows the tracker's clocks, each the
 * scan's local time without an offset, and 17TRACK puts one offset on all of
 * them: a parcel from London came with +01:00 on its Singapore and Brisbane
 * scans too, 7 and 9 hours late (checked 2026-10-21). A scan is read as DAI
 * Post's adapter reads it, in its country's zone where that keeps one clock
 * (carriers/dai-post/clock.ts). One it cannot place, in Australia or the US,
 * is counted, not dated, as DHL Express's are.
 */
const DAI_POST = 100790;

/**
 * 17TRACK's carrier 101309, Quick Rabbit, shows the clocks Quick Rabbit's page shows, Madrid's,
 * and labels them -04:00: a delivery the page shows at 23:07 came as 23:07-04:00, five hours
 * late. Its rows are read on Madrid's clock, as Quick Rabbit's adapter reads them.
 */
const QUICK_RABBIT = 101309;

/**
 * 17TRACK's carrier 21051, USPS, shows USPS's wall clocks, each the scanning
 * facility's. A row given to the second can name USPS's zone in `time_raw`,
 * and keeps it. A row given to the minute has no zone, and 17TRACK puts on it
 * an offset it guesses from the scan's state: Arizona's came right, but a distribution center in
 * Indiana, on Eastern time, came under -05:00, an hour late against USPS's own
 * page (checked 2026-10-22). A row whose place names its state, or gives a ZIP
 * code, is read in that state's zone, as USPS's adapter reads it
 * (carriers/usps/clock.ts). A row with no place, such as "In Transit, Arriving
 * On Time", or with the country alone, as 17TRACK labels some, gives no state
 * to guess from: it keeps USPS's wall clock as its local time, as USPS's
 * adapter gives it, so both copies are dated alike. A place that names neither
 * keeps 17TRACK's reading, the last guess.
 * A step USPS dates by its day alone, such as a label printed at a post office,
 * comes at midnight under 17TRACK's offset; it keeps its day, as on USPS's page.
 */
const USPS = 21051;
const USPS_UNPLACED = /^(?:|US|USA|United States)$/i;
/**
 * BRT's page gives its "FOR DELIVERY" round a date and no time, and 17TRACK's carrier 199997
 * shows it at midnight with an offset of its own: it keeps its day, as ParcelsApp's copy does.
 */
const BRT = 199997;
const BRT_ROUND = /^for\s+delivery$/i;
/**
 * DHL eCommerce US's Webtrack adds an EN ROUTE row without a place, stamped with each request,
 * which its adapter skips: it echoes the status. 17TRACK relays one each time it asks again.
 */
const DHL_ECOMMERCE_US = 7047;
const DHL_ECOMMERCE_EN_ROUTE = /^en\s+route$/i;

/** The day of a row 17TRACK shows at midnight, or without a clock, under an offset of its own. */
function dayAlone(raw: Record<string, unknown>): string | null {
  const clock = isRecord(raw.time_raw) ? raw.time_raw : null;
  if (!clock || clock.timezone !== null || typeof clock.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(clock.date)) return null;
  return clock.time == null || clock.time === '00:00:00' ? clock.date : null;
}

/**
 * The day of a row the carrier dates by its day alone, on any leg: its raw clock has a date and
 * no time, which 17TRACK still shows at midnight; or it is the sender's information
 * (`InfoReceived`) at midnight, as Swiss Post's "Creation date" and GLS Italy's
 * "created by the sender" come, which GLS Italy's own page dates by its day.
 */
function undatedClock(raw: Record<string, unknown>): string | null {
  const clock = isRecord(raw.time_raw) ? raw.time_raw : null;
  if (!clock || typeof clock.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(clock.date)) return null;
  if (clock.time == null || clock.time === '') return clock.date;
  return clock.time === '00:00:00' && raw.sub_status === 'InfoReceived' ? clock.date : null;
}

/**
 * 17TRACK's carrier 3101, Correos de Chile, shows Correos de Chile's wall
 * clocks (`time_raw` has no zone) and labels them -04:00, Chile's offset
 * outside summer time, in summer too: a scan Correos de Chile's page shows at
 * 10:43 on 11 September came as 10:43-04:00, an hour after Correios Brazil's
 * copy of it at 10:43-03:00 (checked 2026-10-22). A row is read on Santiago's
 * clock, the catalog's for Correos de Chile, unless its place names a country
 * on one clock.
 */
const CORREOS_CHILE = 3101;

/** The recipient's or the sender's country, the only field of the address read. */
function recipientCountry(shipment: Record<string, unknown>, address = 'recipient_address'): string | null {
  const country = isRecord(shipment.shipping_info) && isRecord(shipment.shipping_info[address])
    ? shipment.shipping_info[address].country : null;
  return typeof country === 'string' && /^[A-Z]{2}$/.test(country) ? country : null;
}

/**
 * 17TRACK's carrier 16081, Poland Post, shows Poczta Polska's wall clocks (`time_raw` has no zone)
 * and labels them with Poland's offset on the day it looks: after October's change it put +01:00 on
 * July scans, so a departure from Poland at 10:02 came an hour late (checked 2026-10-25). A row is
 * read on Warsaw's clock at its own date. A row after the departure from Poland is a partner post's
 * scan the tracker relays on its own clock: it is read in the recipient country's zone, as Poczta
 * Polska's adapter reads it (carriers/poczta-polska/parser.ts), where 17TRACK names a country on one
 * clock, and otherwise keeps 17TRACK's reading.
 */
const POLAND_POST = 16081;
const POLISH_DEPARTURE = /^departure from poland\b/i;

/** The wall clock of the latest departure from Poland on Poland Post's leg, or '' without one. */
function polishDeparture(events: unknown[]): string {
  return events.reduce<string>((latest, raw) => {
    const clock = isRecord(raw) && POLISH_DEPARTURE.test(text(raw.description)) ? rawClock(raw) ?? '' : '';
    return clock > latest ? clock : latest;
  }, '');
}

/** The clock of the partner post abroad that Poland Post's leg relays, as Poczta Polska's adapter picks it. */
function polishPartnerZone(shipment: Record<string, unknown>): string | null {
  const country = recipientCountry(shipment);
  return country && !['PL', 'ES', 'PT'].includes(country) ? countryTimeZone(country) : null;
}

/**
 * 17TRACK's carrier 100222, FedEx International Connect, shows FIC's own scans at its British hubs
 * and, from "RECEIVED BY PARTNER CARRIER" on, the scans of the carrier that delivers in the
 * recipient's country, without a place and on that carrier's clock. 17TRACK labels them all with
 * London's offset: a Dutch post's scans came on the post's summer time under London's, an hour after
 * the post's own times. A row from the handover on that is not placed in Britain is read in the
 * recipient country's zone where 17TRACK names a country on one clock, and otherwise keeps
 * 17TRACK's reading.
 */
const FIC = 100222;
const FIC_HANDOVER = /^received by partner carrier$/i;

/** The wall clock of the first handover to the partner carrier on FIC's leg, or '' without one. */
function ficHandover(events: unknown[]): string {
  return events.reduce<string>((first, raw) => {
    const clock = isRecord(raw) && FIC_HANDOVER.test(text(raw.description).trim()) ? rawClock(raw) ?? '' : '';
    return clock && (!first || clock < first) ? clock : first;
  }, '');
}

/** 17TRACK's carrier 14061, NZ Post. */
const NZ_POST = 14061;
const NZ_DEPARTURE = /^international departure\b/i;
const NZ_AIRLINE = /^in transit with airline\b/i;

/** The country a scan's location names, if any. */
function locationCountry(location: unknown): string | null {
  return typeof location === 'string' && location.trim() ? trackingPlace(location).country : null;
}

/**
 * NZ Post's leg shows NZ Post's wall clocks, and 17TRACK labels them with New
 * Zealand's offset on the day it looks: in October it put +13:00 on August
 * scans, when New Zealand kept +12:00, so an Auckland departure at 13:55 came
 * an hour early (checked 2026-10-10). They are read on Auckland's clock at
 * their own date. On an item NZ Post sends abroad (an S10 number ending NZ), a
 * scan after the international departure, but an airline's, shows the clock
 * where it happened: a Guangzhou customs scan at 12:47 local, which UPU dates
 * the same. Such a scan is read in a borrowed country's zone, as a guess: the
 * country its own location names, else that of the nearest earlier scan after
 * the departure that names one (an airline's included), else the nearest
 * later one's, else `destination`. The guess can be a transit hub's country;
 * Hong Kong, Singapore and China all keep +08:00. A country on several clocks
 * lends none, and the scan stays a wall time. With no country named at all,
 * NZ Post's Auckland reading stays, the last guess: hours off, but the scan
 * keeps its place, and a delivery its instant.
 * Returns the zone, or null for a wall time, of each scan placed abroad, by its index in the leg.
 */
function nzPostAbroad(events: unknown[], number: string, destination: string | null): Map<number, string | null> {
  const abroad = new Map<number, string | null>();
  if (!/^[A-Z]{2}\d{9}NZ$/.test(number)) return abroad;
  const scans = events.map((raw, index) => isRecord(raw) ? { index, raw, wall: facilityWall(raw) } : null)
    .filter((scan) => scan !== null);
  const departure = scans.filter(({ raw, wall }) => wall && NZ_DEPARTURE.test(text(raw.description)))
    .map(({ wall }) => wall!).sort()[0];
  if (!departure) return abroad;
  // A scan whose location names New Zealand is back home, on Auckland's clock.
  const after = scans.map(({ index, raw, wall }) => ({ index, wall, airline: NZ_AIRLINE.test(text(raw.description)),
    country: locationCountry(raw.location) }))
    .filter((scan): scan is typeof scan & { wall: string } => scan.wall !== null && scan.wall > departure && scan.country !== 'NZ')
    .sort((a, b) => a.wall < b.wall ? -1 : a.wall > b.wall ? 1 : 0);
  after.forEach((scan, position) => {
    if (scan.airline) return;
    const country = scan.country ?? after.slice(0, position).reverse().find((other) => other.country)?.country
      ?? after.slice(position + 1).find((other) => other.country)?.country ?? destination;
    if (country) abroad.set(scan.index, countryTimeZone(country));
  });
  return abroad;
}

/**
 * The country an NZ Post item is bound for, when the reply names one: the
 * recipient's country (only that field of the address is read), else the
 * country of the one other post whose leg the reply carries, such as China
 * Post's CN.
 */
function nzPostDestination(shipment: Record<string, unknown>, providers: unknown[]): string | null {
  const recipient = recipientCountry(shipment);
  if (recipient && recipient !== 'NZ') return recipient;
  const others = new Set(providers.map((leg) => isRecord(leg) && isRecord(leg.provider) && leg.provider.key !== NZ_POST
    ? leg.provider.country : null).filter((country): country is string =>
    typeof country === 'string' && /^[A-Z]{2}$/.test(country) && country !== 'NZ'));
  return others.size === 1 ? [...others][0]! : null;
}

/** 17TRACK's carrier 3011, China Post. */
const CHINA_POST = 3011;
/** China Post's leg and those of forwarders that relay its labels: JHGJ (九好国际, 192049 in 17TRACK's carrier list). */
const CHINA_POST_LABELS: ReadonlySet<unknown> = new Set([CHINA_POST, 192049]);
/** Legs whose English wording ends with the place in brackets: Pengyou (捧友, 191878 in 17TRACK's carrier list). */
const BRACKETED_PLACES: ReadonlySet<unknown> = new Set([191878]);
/** China Post's mirror of the origin post's outward exchange office: "arrived at" or "left the exchange office abroad". */
const ORIGIN_EXCHANGE = /^(?:到达|离开)境外出口互换局/;

/**
 * China Post's leg mirrors the origin post's outward exchange scans on that
 * post's wall clock (foreign posts scan on their own local time, see
 * [China Post](../../carriers/china-post/README.md)), and 17TRACK labels them
 * with China's +08:00: an NZ Post arrival at 06:09 Auckland time showed four
 * hours late (checked 2026-10-10). On an S10 number from a country on one
 * clock, or from New Zealand, whose exchange scans NZ Post dates on Auckland's
 * clock, they are read on that clock; elsewhere 17TRACK's reading stays.
 */
function originZone(number: string): string | null {
  const origin = isValidS10TrackingNumber(number) ? number.slice(-2) : null;
  return origin === 'NZ' ? 'Pacific/Auckland' : origin && origin !== 'CN' ? countryTimeZone(origin) : null;
}

/**
 * An India Post take-off, which India Post dates with the departure airport's
 * wall clock labelled UTC, and 17TRACK takes the label at its word: it showed
 * a Mumbai take-off 5.5 hours late and one from Frankfurt 2 hours late
 * (checked 2026-10-08). India Post's own adapter places them in the airport's
 * zone; 17TRACK's row says nothing reliable about when the flight left.
 */
function misdatedTakeOff(carrierName: unknown, raw: Record<string, unknown>): boolean {
  return typeof carrierName === 'string' && carrierIdFromName(carrierName) === 'india-post'
    && /^(?:aircraft departure|uplift)$/i.test(text(raw.description));
}

/** A field 17TRACK's form will not submit empty: its pattern, if any, rejects an empty value. */
function requiresValue(pattern: unknown): boolean {
  if (typeof pattern !== 'string') return true;
  try { return !new RegExp(pattern).test(''); } catch { return true; }
}

/**
 * The fields 17TRACK lists for the carrier it picked are that carrier's form,
 * not a diagnosis: for PostNL it asks for a destination country, which its
 * pattern requires, beside an optional postcode (checked 2026-10-10). Only a
 * postcode the form requires, and the only field it requires, is a prompt.
 * An optional one is no prompt: on the benchmark's four (DPD France, GEODIS,
 * The Courier Guy under GLS), no source had the parcel, and 17TRACK returns
 * those carriers' history without a postcode when it has it.
 */
function requestsPostcode(shipment: Record<string, unknown>): boolean {
  const fields = Array.isArray(shipment.params_v2)
    ? shipment.params_v2.filter(isRecord).map(p => ({ postcode: p.key === 'postal_code', pattern: p.regex }))
    : [shipment.param, ...Array.isArray(shipment.params) ? shipment.params as unknown[] : []].filter(isRecord)
      .map(p => ({ postcode: p.type === 'PostalCode', pattern: p.format }));
  return fields.some(field => field.postcode && requiresValue(field.pattern))
    && !fields.some(field => !field.postcode && requiresValue(field.pattern));
}

export function parse17TrackResponse(payload: unknown, trackingNumber: string, postcode: string | null = null): CarrierResult {
  const number = numberOf(trackingNumber);
  if (!isRecord(payload) || !isRecord(payload.meta) || !Number.isInteger(payload.meta.code)) {
    throw new SchemaError(SOURCE, '17TRACK lookup unavailable');
  }
  if (payload.meta.code !== 200) {
    const code = Number(payload.meta.code);
    // Keep the provider's short reason (e.g. for the intermittent code 400) visible in Sentry.
    const message = typeof payload.meta.message === 'string' ? text(payload.meta.message).slice(0, 120) : undefined;
    throw lookupError(code, message);
  }
  if (!Array.isArray(payload.shipments)) throw new SchemaError(SOURCE, '17TRACK lookup unavailable');
  const matches = payload.shipments.filter((s) => isRecord(s) && s.number === number);
  if (matches.length === 1 && isRecord(matches[0]) && Number.isInteger(matches[0].code) && matches[0].code !== 200) {
    // A shipment-level code is the lookup's own progress, never a verification wall.
    const code = Number(matches[0].code);
    // Observed repeatedly for valid references whose other providers have history.
    // Scope this to the matching shipment; envelope errors and unknown shapes remain failures.
    if (code === 400 && matches[0].shipment === null) {
      if (!postcode && requestsPostcode(matches[0])) throw new InputRequiredError(SOURCE, 'postcode');
      throw new SeventeenTrackNoHistoryError();
    }
    if (code === 402) throw new SeventeenTrackQuotaError();
    throw new SeventeenTrackLookupError(code === 100 ? 'lookup_pending' : 'lookup_unavailable', code);
  }
  if (matches.length !== 1 || !isRecord(matches[0]) || matches[0].code !== 200 || !isRecord(matches[0].shipment)) {
    throw new SchemaError(SOURCE, '17TRACK has no matching shipment history');
  }
  const shipment = matches[0].shipment;
  const tracking = shipment.tracking;
  if (!isRecord(tracking) || !Array.isArray(tracking.providers) || tracking.providers.length > MAX_PROVIDERS) {
    throw new SchemaError(SOURCE, '17TRACK returned invalid providers');
  }
  const events: CarrierEvent[] = [];
  let count = 0;
  let undated = 0;
  const latest = new LatestScan(SOURCE);
  const now = DateTime.now();
  for (const provider of tracking.providers) {
    if (!isRecord(provider) || !Array.isArray(provider.events)) throw new SchemaError(SOURCE, '17TRACK returned invalid provider history');
    const reported = isRecord(provider.provider) ? provider.provider : {};
    const name = universalCarrierHints([reported.name]).reported_carriers[0];
    const operator = { ...(name ? { reporting_carrier: name } : {}),
      ...(typeof reported.key === 'number' && Number.isSafeInteger(reported.key) ? { reporting_carrier_key: reported.key } : {}) };
    const utc = relaysUtcClock(reported.key);
    const nz = reported.key === NZ_POST;
    const abroad = nz && provider.events.length <= MAX_EVENTS
      ? nzPostAbroad(provider.events, number, nzPostDestination(shipment, tracking.providers)) : new Map<number, string | null>();
    const origin = reported.key === CHINA_POST ? originZone(number) : null;
    const salvador = reported.key === CORREO_EL_SALVADOR;
    const sender = salvador && isValidS10TrackingNumber(number) ? countryTimeZone(number.slice(-2)) : null;
    const bound = reported.key === SWISS_POST ? recipientCountry(shipment) : null;
    const shiprocket = reported.key === SHIPROCKET;
    const hywl = reported.key === HYWL;
    const daiPost = reported.key === DAI_POST;
    const quickRabbit = reported.key === QUICK_RABBIT;
    const usps = reported.key === USPS;
    const brt = reported.key === BRT;
    const chile = reported.key === CORREOS_CHILE;
    const correos = reported.key === CORREOS_SPAIN;
    const poland = reported.key === POLAND_POST;
    const departed = poland ? polishDeparture(provider.events) : '';
    const partner = poland ? polishPartnerZone(shipment) : null;
    const handedOver = reported.key === FIC ? ficHandover(provider.events) : '';
    const delivering = handedOver ? countryTimeZone(recipientCountry(shipment)) : null;
    const labelled = labelZone(reported);
    const ctt = reported.key === CTT;
    const countries = ctt ? [recipientCountry(shipment, 'shipper_address'), recipientCountry(shipment)] : [];
    const agencyScans = ctt ? provider.events.flatMap((raw: unknown) => isRecord(raw) && isCttExpressAgency(text(raw.location))
      ? [wallMillis(raw)] : []) : [];
    for (const [index, raw] of provider.events.entries()) {
      if (++count > MAX_EVENTS || !isRecord(raw)) throw new SchemaError(SOURCE, '17TRACK returned invalid events');
      if (undatedScan(raw)) undated++;
      const exchange = origin !== null && ORIGIN_EXCHANGE.test(text(raw.description));
      const own = !salvador ? null : OUTBOUND.test(text(raw.description)) ? sender : 'UTC';
      // The destination post's scan Swiss Post relays, its wall clock under Swiss Post's offset, or Huiyi Logistics' row in China under "+00:00".
      const relayed = bound ? swissPostDestinationZone(text(raw.description), text(raw.location), bound)
        : hywl && hywlInChina(text(raw.location)) ? HYWL_CHINA_ZONE : null;
      // A USPS facility's clock in its state's zone, where its place names one.
      const facility = usps ? uspsScanZone(text(raw.location)) : null;
      // Correos's copy of the origin post's scan on an item from abroad: that post's zone, or null for its wall clock.
      const sent = correos ? correosOriginZone(number, { wording: text(raw.description) }) : undefined;
      // Poland Post's scan on Warsaw's clock, or a partner's after the departure from Poland on the recipient's.
      const polish = !poland ? null : departed && (rawClock(raw) ?? '') > departed ? partner : 'Europe/Warsaw';
      // FIC's partner's scan from the handover on, unless placed in Britain, on the recipient's clock.
      const handed = delivering && (rawClock(raw) ?? '') >= handedOver && locationCountry(raw.location) !== 'GB' ? delivering : null;
      // CTT's scan on the clock its place names, or Madrid's for the acceptance as a CTT Express agency takes the parcel in.
      const site = !ctt ? null : cttSiteZone(text(raw.location), countries)
        ?? (!text(raw.location) && agencyIntake(wallMillis(raw), agencyScans) ? 'Europe/Madrid' : null);
      // A facility's clock, CTT's, A1's UTC, NZ Post's, Poland Post's, FIC's partner's, Correos de El Salvador's, Correos de Chile's, Shiprocket's, DAI Post's, Quick Rabbit's or an origin post's, on which 17TRACK puts one offset for the whole parcel.
      const read = facility || site || relaysFacilityClock(name) || utc || nz || polish || handed || exchange || own || chile || shiprocket || daiPost || quickRabbit
        || sent !== undefined;
      // Any other row 17TRACK labelled with its zone's offset on the day it looks, not on the scan's.
      const season = relayed || hywl || read || poland ? null : seasonZone(raw, labelled, now);
      const wall = relayed || hywl ? rawClock(raw) : read || season ? facilityWall(raw) : null;
      const zone = !wall ? null : season ?? (hywl ? relayed : relayed ?? facility ?? site ?? own ?? (sent !== undefined ? sent : abroad.has(index) ? abroad.get(index) ?? null
        : exchange ? origin : utc ? 'UTC' : polish ? polish : handed ? handed
        : nz ? 'Pacific/Auckland' : quickRabbit ? 'Europe/Madrid' : chile ? facilityZone(text(raw.location)) ?? 'America/Santiago'
        : shiprocket ? (placedInIndia(text(raw.location)) ? 'Asia/Kolkata' : null)
        : daiPost ? daiPostRelayZone(text(raw.description), text(raw.location)) : facilityZone(text(raw.location))));
      const placed = wall && zone ? firstOccurrence(DateTime.fromISO(wall, { zone })) : null;
      let parsed: CarrierEvent | null;
      try { parsed = seventeenTrackEvent(raw, operator, placed?.isValid ? placed.toUTC().toISO() ?? undefined : undefined); }
      catch (cause) { throw new SchemaError(SOURCE, '17TRACK returned an invalid tracking event', { cause }); }
      if (!parsed || (reported.key === DHL_ECOMMERCE_US && !parsed.location && DHL_ECOMMERCE_EN_ROUTE.test(parsed.description ?? ''))) continue;
      // China Post words its labels in Chinese only, on its own leg and on a forwarder's that relays them: they
      // show in English where it is known, staged as the Chinese was, with the place left to the location, or
      // taken from the label's 【】 where none is given.
      const english = CHINA_POST_LABELS.has(reported.key) && parsed.description ? chinaPostEnglish(parsed.description) : undefined;
      if (english) {
        const named = parsed.location ? '' : place(chinaPostLabelPlace(parsed.description ?? '') ?? '');
        parsed.description = english;
        if (named) parsed.location = named;
      }
      // The place such a leg writes after its wording is the location where 17TRACK gives none.
      const trailing = !english && !parsed.location && BRACKETED_PLACES.has(reported.key) ? trailingPlace(parsed.description ?? '') : undefined;
      if (trailing) Object.assign(parsed, { description: trailing.wording, location: trailing.place });
      const day = undatedClock(raw) ?? (usps ? dayAlone(raw) ?? (USPS_UNPLACED.test(text(raw.location)) ? facilityWall(raw) : null)
        : brt && BRT_ROUND.test(text(raw.description).trim()) ? dayAlone(raw) : null);
      if (day) {
        const local: CarrierEvent = { ...parsed, local_time: day };
        delete local.time;
        events.push(local);
        latest.see(day, false);
        continue;
      }
      if (wall && (abroad.has(index) || shiprocket || hywl || sent !== undefined) && !zone) {
        // A scan NZ Post dated abroad or an origin post's that Correos relays, in a country on several clocks, a Shiprocket row outside India or a Huiyi Logistics row outside China, keeps its description as a wall time.
        const local: CarrierEvent = { ...parsed, local_time: wall };
        delete local.time;
        events.push(local);
        latest.see(wall, false);
        continue;
      }
      const unplaced = wall !== null && !placed?.isValid;
      latest.see(wall ?? String(raw.time_iso ?? raw.time_utc).slice(0, 19), unplaced, daiPost ? 'DAI Post' : undefined);
      // With no zone for the facility it is a wall time, counted like a row without a date.
      // A take-off is counted the same way, but the scans before it still say where the parcel is.
      if (unplaced || misdatedTakeOff(name, raw)) undated++;
      else events.push(parsed);
    }
  }
  latest.check();
  if (count === 0 && isRecord(shipment.latest_status) && shipment.latest_status.status === 'NotFound') {
    throw new NotFoundError(SOURCE);
  }
  return { ...result(events, SOURCE), ...(undated ? { undated_event_count: undated } : {}),
    ...universalCarrierHints(tracking.providers.map((provider) =>
    isRecord(provider) && isRecord(provider.provider) ? provider.provider.name : undefined), number) };
}

export interface SeventeenTrackOptions {
  trawl?: TrawlClient | null;
  fetcher?: typeof fetch;
  recorder?: StepRecorder;
  timeoutMs?: number;
}

/** Below this, a second browser lookup cannot finish: one takes seconds even when 17TRACK answers at once. */
const MIN_CARRIER_LOOKUP_MS = 5_000;

type Outcome = { result: CarrierResult } | { error: unknown };

const settled = (outcome: Outcome): CarrierResult => {
  if ('error' in outcome) throw outcome.error;
  return outcome.result;
};

const datedScans = (result: CarrierResult): number => result.events?.filter((event) => event.time).length ?? 0;

/**
 * Whether 17TRACK's own detection left the carrier out: no history, still
 * polling when the page settled, or scans from other carriers only.
 */
function missesCarrier(outcome: Outcome, keys: readonly number[]): boolean {
  if ('error' in outcome) {
    const { error } = outcome;
    return error instanceof NotFoundError || error instanceof SeventeenTrackNoHistoryError
      || (error instanceof SeventeenTrackLookupError && error.reason === 'lookup_pending');
  }
  return !outcome.result.events?.some(({ reporting_carrier_key: key }) => typeof key === 'number' && keys.includes(key));
}

export class SeventeenTrackTracker {
  constructor(readonly options: SeventeenTrackOptions = {}) {}

  /**
   * `carrier` is the catalog carrier the parcel is filed under. When 17TRACK's own
   * detection finds no history, is still polling, or finds only another carrier's,
   * the lookup is asked again for that carrier, as a visitor picks one on the page. That answer wins
   * when it has at least as many dated scans.
   */
  async fetch(trackingNumber: string, budgetMs = this.options.timeoutMs ?? 30_000, signal?: AbortSignal, postcode: string | null = null,
    carrier: string | null = null): Promise<CarrierResult> {
    const number = numberOf(trackingNumber);
    postcode = postcode?.trim().replace(/\s+/g, ' ').toUpperCase() || null;
    if (postcode && (postcode.length < 2 || postcode.length > 15 || !/^[A-Z0-9]+(?:[ -][A-Z0-9]+)*$/.test(postcode))) {
      throw new InvalidInputError(SOURCE, '17TRACK delivery postcode has an invalid format');
    }
    const keys = seventeenTrackCarrierKeys(carrier);
    return runSteps({ carrier: SOURCE, budgetMs, signal, recorder: this.options.recorder }, [{
      id: 'trawl',
      run: async ({ remainingMs, signal }) => {
        const started = performance.now();
        const detected: Outcome = await this.lookup(number, postcode, null, remainingMs, signal)
          .then((result) => ({ result }), (error: unknown) => ({ error }));
        const left = remainingMs - (performance.now() - started);
        if (!keys || !missesCarrier(detected, keys) || left < MIN_CARRIER_LOOKUP_MS || signal.aborted) return settled(detected);
        try {
          const hinted = await this.lookup(number, postcode, keys[0], left, signal);
          if (datedScans(hinted) > 0 && ('error' in detected || datedScans(hinted) >= datedScans(detected.result))) return hinted;
        } catch {
          // The carrier's own answer adds nothing; the first one stands.
        }
        return settled(detected);
      },
    }]);
  }

  /** One page load, with 17TRACK's carrier `key` chosen or left to its detection. */
  private async lookup(number: string, postcode: string | null, key: number | null, remainingMs: number, signal: AbortSignal): Promise<CarrierResult> {
    const capture: CaptureSpec = {
      source: SOURCE, apiUrl: API_URL, budgetMs: remainingMs, fetcher: this.options.fetcher, signal,
      url: `https://t.17track.net/en#nums=${number}${key ? `&fc=${key}` : ''}${postcode ? `&trawl-postcode=${encodeURIComponent(postcode)}` : ''}`,
    };
    const page = await loadCapture(this.options.trawl ?? null, capture);
    let pending: Error | undefined;
    for (const body of capturedBodies(page, capture)) {
      try {
        const payload: unknown = JSON.parse(body);
        // Old browser-service builds ignore the private input marker. Never
        // report that a supplied postcode was tried without a bound request.
        const submitted = page.capturedResponses.some(entry => entry.body === body && entry.postcodeSubmitted === true);
        if (postcode && !submitted) {
          try { return parse17TrackResponse(payload, number); }
          catch (error) {
            if (error instanceof InputRequiredError || error instanceof SeventeenTrackNoHistoryError) {
              throw new TransportError(SOURCE, '17TRACK browser service did not submit the delivery postcode', { reason: 'postcode_not_submitted' });
            }
            throw error;
          }
        }
        return parse17TrackResponse(payload, number, postcode);
      } catch (error) {
        // Continue past polling replies and unrelated/demo numbers, but retain
        // the latest structured failure if no matching history follows.
        if (isSeventeenTrackLookupError(error) || error instanceof NotFoundError || error instanceof SchemaError
          || error instanceof InputRequiredError || error instanceof TransportError) pending ??= error;
      }
    }
    throw pending ?? captureFailure(page, capture);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new SeventeenTrackTracker({
    trawl: environment.trawl, fetcher: environment.fetcher, recorder: environment.recorder,
  });
  return {
    id: SOURCE,
    steps: ['trawl'],
    track: (input, context) => tracker.fetch(input.number, context?.budgetMs, context?.signal, input.postcode, input.carrier),
  };
};
