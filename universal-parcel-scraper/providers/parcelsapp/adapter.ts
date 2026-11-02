
/**
 * ParcelsApp (parcelsapp.com), a universal aggregator used as the second
 * discovery provider.
 *
 * Transport: a scoped anonymous POST reproduces the public frontend checksum
 * and submits the stored delivery postcode. Browser capture remains recovery
 * for protocol challenges. Numberless direct replies belong to their single
 * POST; captured replies still require the rendered result's identity.
 */
import { load } from 'cheerio';
import { DateTime } from 'luxon';
import timers from 'node:timers/promises';
import type { AdapterFactory } from '../../core/adapter/index.js';
import { carrierDefinition, carrierTimezone } from '../../core/catalog/index.js';
import {
  brandCarrierIds, brandTimeZones, carrierBrand, carrierIdFromName, carrierNameCountryZone, isCarrierFeedName, isKnownCarrierName,
} from '../../core/catalog/hints.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { CarrierError, carrierErrorKind, ChallengeError, IndeterminateError, InputRequiredError, NoHistoryError, SchemaError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import type { StepRecorder } from '../../core/telemetry/index.js';
import {
  canadaProvinceTimeZone, countryCode, countryTimeZone, mislabeledLocalTime, mislabeledWallTime, regionHasTown, sharedClockZone,
  timeZoneCountry, usStateTimeZone, usZipState,
} from '../../core/time/index.js';
import type { TrawlClient } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { countryName, militaryPostOffice } from '../../places/trackingLocation.js';
import { hasSeveralClocks, keepsZone, mainZone } from '../../places/zones.js';
import { captureFailure, capturedBodies, loadCapture, type CaptureSpec } from '../shared/capture.js';
import { CAINIAO_CHINA_LEG, CAINIAO_CHINA_ZONE } from '../../carriers/aliexpress/clock.js';
import { correosOriginZone } from '../../carriers/correos-spain/clock.js';
import { cttSiteZone, portugalZone } from '../../carriers/ctt/clock.js';
import { DHLINK_RECORD_ZONE, usClockCopy } from '../../carriers/dhlink/clock.js';
import { FIRST_LINE_CHINA_ZONE, firstLineInChina } from '../../carriers/first-line/clock.js';
import { hrvatskaPostaForeignZone } from '../../carriers/hrvatska-posta/parser.js';
import { jsExpressChinaClock } from '../../carriers/js-express/clock.js';
import { pitneyBowesPlatformClock, pitneyBowesPostalRelay } from '../../carriers/pitney-bowes/clock.js';
import { pocztaPolskaPartnerClock } from '../../carriers/poczta-polska/clock.js';
import { facilityZone, LatestScan, relaysFacilityClock } from '../shared/facilityClock.js';
import { CHINESE_CITIES, CHINESE_PROVINCES } from '../shared/china.js';
import { brandCarrierForNumber, universalCarrierHints } from '../shared/hints.js';
import { event, isNotice, localEvent, numberOf, place as reportedPlace, result, type UniversalSource } from '../shared/result.js';
import { carrierScan, markLaterReceipts, markReturnLeg, type CarrierScan } from '../shared/scans.js';
import { PARCELSAPP_API, ParcelsAppHttpClient } from './http.js';

const SOURCE: UniversalSource = 'ParcelsApp';
const MAX_EVENTS = 1000;
export const PARCELSAPP_BUDGET_MS = 45_000;
const DIRECT_BUDGET_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
// How long before every other scan a 1 January 00:00 must lie to be a placeholder.
const PLACEHOLDER_LEAD_DAYS = 60;

// ParcelsApp's response omits the number. Bind it to the rendered result's
// tracking-number row, never merely to the input field or the requested URL.
function parcelsIdentity(html: string, number: string): boolean {
  const $ = load(html);
  const rows = $('.tracking-info .parcel .parcel-attributes tr').filter((_, row) =>
    $(row).children('td').first().text().trim() === 'Tracking number');
  return rows.length === 1 && rows.first().children('td').eq(1).text().trim() === number;
}

/** ParcelsApp's results without a shipment: its empty view, with no shipment's rows. */
function emptyView(html: string): boolean {
  const $ = load(html);
  return $('.tracking-info.empty').length === 1 && !$('.tracking-info .parcel .parcel-attributes tr').length;
}

export function parseParcelsAppResponse(payload: unknown, trackingNumber: string, html: string, timezone: string | null = null,
  readAt = Date.now()): CarrierResult {
  if (!parcelsIdentity(html, numberOf(trackingNumber))) throw new SchemaError(SOURCE, 'ParcelsApp shipment identity missing');
  return parseHistory(payload, trackingNumber, timezone, readAt);
}

/**
 * ParcelsApp's `date` is the scan's local clock, labeled as UTC or shifted
 * into an offset of its own: a DPD scan at 14:05+02:00 arrives as
 * "14:05+00:00", a Swiss Post delivery at 11:30 local as "13:30+02:00"
 * (both shapes checked 2026-09-22). Its UTC digits are re-read in the zone
 * of the scan's carrier, else its location's country, else the country the
 * carrier name ends with ("DPD UK"), else, for a scan with no location, the
 * clock that all catalog networks of a bare brand share at that moment
 * ("GLS"), or that the network which labelled the parcel shares with its
 * destination ("DPD Group", `brandNetworkZones`), else the zone routing passes
 * for the parcel. Without one it stays as labeled, as it does when the name's
 * country or the parcel's zone meets a location in another country, unless
 * nothing knows its network (`unknownNetwork`), it is a bare brand whose
 * networks all keep local clocks (`localClockBrand`) or it is at a US
 * military post office: it then keeps its wall clock. TNT's
 * international scans stay as labeled too: tnt.com gives them offsets, and
 * ParcelsApp's UTC matches them. So do Asendia USA's, wherever they happened:
 * their dates are the UTC instants of Asendia's A1 feed, and Swiss Post's own
 * scans of the same item agree (checked 2026-09-30). So do Paack's: its
 * timeline gives instants, and Paack's own lookup has ParcelsApp's UTC scan
 * for scan (checked 2026-10-07). So do Vinted Go's: its own instants, in the
 * Netherlands and Spain, have ParcelsApp's UTC digits to the second. So do
 * Austrian Post's: its own instants have ParcelsApp's UTC digits to the second
 * (checked 2026-10-16), while the EURODIS copies of the same scans carry the
 * wall clock. So do Straightship's: its page writes every clock in UTC, and
 * its own rows have ParcelsApp's UTC digits to the second; read on its
 * Vancouver clock they came out seven hours late (checked 2026-10-19).
 */
function stateCarrierName(payload: Record<string, unknown>, state: Record<string, unknown>): unknown {
  const carriers = Array.isArray(payload.carriers) ? payload.carriers : [];
  return typeof state.carrier === 'number' ? carriers[state.carrier] : undefined;
}

// The names ParcelsApp gives Asendia USA's scans.
const ASENDIA_USA = /^asendia\s+(?:usa|united\s+states)$/i;
/** A carrier name as the tables below key it: "GoFo Express" is "gofoexpress". */
const nameKey = (name: unknown) => typeof name === 'string' ? name.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
// Carriers whose ParcelsApp dates are a North American scan's local clock:
// UPS's own instants, FedEx's own page, UniUni's own feed and Ship24's offsets
// agree once they are read that way (checked 2026-09-30 on US scans; UPS's
// also in Germany, the Netherlands and Spain). So does DHL eCommerce's
// Webtrack, which names each scan's clock, on all 25 scans of three parcels
// in seven states and the UK (2026-10-11). OnTrac's are UTC and Landmark's
// keep its home clock everywhere (HOME_CLOCKS), so no other carrier gets this
// step beyond the ones below.
const LOCAL_CLOCK_CARRIERS = new Set(['ups', 'fedex', 'uniuni', 'uniexpress', 'easyship', 'dhlecommerce']);
/**
 * Of those, the carriers whose scans with no location are on a local clock
 * too, so that one nothing places is a wall time, not the label's instant.
 * Their own trackers date UPS's "Shipper created a label" and FedEx's "Order
 * Created" at the same digits, on a clock that is not always the pickup's
 * (Eastern time for a parcel picked up on Pacific time), and UPS's customs
 * scan at the clearing agency on the destination's: read as labeled, it came
 * 11 hours after UPS's own instant. UniUni's "UNI DATA CENTER" scans, by
 * contrast, have the UTC instants of UniUni's own feed.
 */
const UNLOCATED_LOCAL_CLOCKS = new Set(['ups', 'fedex']);
/**
 * The day of a step its carrier dates without a time, which ParcelsApp writes
 * at 00:00: FedEx's own feed sends its pickup ("Picked up", `PU`) with a date,
 * a 00:00:00 time and no offset, and every other scan with its offset.
 * ParcelsApp words it "Picked Up", with a no-break space. Read at midnight on
 * the pickup's clock, it took a time FedEx never gives; it keeps its day in
 * `local_time` instead. BRT's page gives its "FOR DELIVERY" step a date and
 * no time, and ParcelsApp writes it at 00:00 too. So does USPS's for its
 * pre-shipment notice and its place-less "In Transit to Next Facility" (worded
 * "In Transit, Arriving On Time" or "Arriving Late" while it is the newest):
 * read on the clock of a placed scan near it, it came at a US midnight.
 */
const USPS_UNTIMED = /^(?:in\s+transit(?:\s+to\s+next\s+facility|,\s*arriving\s+(?:on\s+time|late))|pre-shipment\s+info\s+sent\s+to\s+usps(?:,\s*usps\s+awaiting\s+item)?)$/i;
function datedOnly(name: unknown, status: string, date: unknown): string | null {
  const wall = mislabeledWallTime(date);
  const step = nameKey(name) === 'fedex' ? /^picked\s+up$/i : nameKey(name) === 'usps' ? USPS_UNTIMED
    : typeof name === 'string' && carrierIdFromName(name) === 'brt' ? /^for\s+delivery$/i : null;
  return step?.test(status.trim()) && wall && /T00:00:00(?:\.0+)?$/.test(wall) ? wall.slice(0, 10) : null;
}

/**
 * The networks a reply dates by their day alone: at least three scans of
 * theirs over two days or more, none with an offset of its own, on a clock
 * nobody scanned at (`dayClock`). ParcelsApp writes every scan of Shiprocket's
 * at 00:00:00, while Shiprocket's own tracker gives each of them its minute
 * (2026-10-17), and CDEK's and SEUR's on one minute with seconds that count
 * the scans (07:00:00, 07:00:01...), while CDEK's own lookup has each scan's
 * instant. A network with one scan at midnight keeps it. The rendered page
 * prints no seconds (`minutes`).
 */
function dayOnlyNetworks(entries: readonly { name: unknown; date: unknown; offset?: string | null }[], minutes = false): Set<string> {
  const walls = new Map<string, (string | null)[]>();
  for (const { name, date, offset } of entries) walls.set(nameKey(name), [...walls.get(nameKey(name)) ?? [], offset ? null : mislabeledWallTime(date)]);
  return new Set([...walls].filter(([, list]) => list.length >= 3 && dayClock(list, minutes)
    && new Set(list.map((wall) => wall!.slice(0, 10))).size >= 2).map(([key]) => key));
}

/**
 * Whether a network's wall clocks, in the reply's order, stand for no time:
 * all at 00:00:00, or all on one minute with whole seconds that step by one
 * from scan to scan, up or down. Real scans to the minute vary their minutes,
 * and real seconds do not count scans across days; seconds that skip or carry
 * milliseconds keep their times. Without seconds, one minute for all is enough.
 */
function dayClock(walls: readonly (string | null)[], minutes: boolean): boolean {
  const clocks = walls.map((wall) => wall ? /T(\d{2}:\d{2}):(\d{2})(?:\.0+)?$/.exec(wall) : null);
  if (!clocks.every((clock) => clock && clock[1] === clocks[0]![1])) return false;
  const seconds = clocks.map((clock) => Number(clock![2]));
  const step = seconds[1]! - seconds[0]!;
  return minutes || (clocks[0]![1] === '00:00' && seconds.every((second) => second === 0))
    || (Math.abs(step) === 1 && seconds.every((second, index) => !index || second - seconds[index - 1]! === step));
}

/**
 * The day of a scan whose network the reply dates by its day alone
 * (`dayOnlyNetworks`): that of ParcelsApp's digits, the network's own clock,
 * as the midnight rule takes it. The UTC day of the instant they read as can
 * be another: a count from 00:00:01 on Madrid's winter time is 23:00:01 UTC
 * the day before.
 */
function networkDay(networks: ReadonlySet<string>, name: unknown, date: unknown): string | null {
  return networks.has(nameKey(name)) ? mislabeledWallTime(date)?.slice(0, 10) ?? null : null;
}

/** A step dated by its day alone. */
function dayEvent(day: string, description: string): CarrierEvent | null {
  const parsed = localEvent(`${day}T00:00:00`, description);
  return parsed && { ...parsed, local_time: day };
}

/**
 * Carriers whose dates are each scan's local clock under a label that is
 * never its instant, checked scan for scan on 2026-10-10: USPS's own page,
 * and the "at 8:25 am" ParcelsApp relays in its text; Canada Post's digits;
 * GOFO's US feed, which gives the offsets; Orange Connex's times and offsets
 * for SpeedPAK; the EMS office clocks Parcelforce and NZ Post relay; Cainiao's
 * leg by leg, on GMT+8, +2 or +1, also under EcoScooting; 4PX's and
 * MailAmericas' (below). They are read in the state, province or single-clock
 * country their location names; `wallClockZones` reads the others.
 * FIRST LINE's ("1ST") rows abroad are its delivery partner's scans on their
 * facility's clock: a copy of a GOFO scan in California came at GOFO's digits,
 * and read on Beijing's clock, its arrival in Los Angeles came twelve minutes
 * after the flight left Shenzhen. Its rows in China, and its order data with
 * no place, are Beijing's (`carrierClock`).
 */
const WALL_CLOCKS = new Set(['usps', 'canadapost', 'gofoexpress', 'speedpak', 'ems', 'cainiao', 'ecoscooting', '4pxexpress', 'mailamericas', '1st']);
// Known clocks that are the destination or origin country's (`knownClock`).
const DESTINATION = 'destination';
const ORIGIN = 'origin';
const wordings = (list: readonly string[]) => new RegExp(`^(?:${list.join('|')})$`, 'i');
// Cainiao's last-mile scans, in its words or the local carrier's.
const CAINIAO_LAST_MILE = [
  'received by local\\s+delivery company', '(?:at|left) destination country/region(?: sorting center)?', 'arrived at local delivery center',
  'out for delivery', 'delivery failed(?:\\. not at home\\.)?', 'delivery attempt failure,.*', '(?:item )?delivered',
  'parcel is handled', 'your shipment has been delivered to the postal operator of the country.*',
  'first parcel scan along .+ logistic network', 'package arrived at facility of the local delivery company',
];
/**
 * The clocks of some wall-clock scans whatever their neighbours', from each
 * carrier's own offsets. GOFO's feed dates its labels on Pacific time
 * wherever the parcel is injected (a Florida parcel's at -07:00; 2026-10-10).
 *
 * Cainiao's own feed (checked 2026-10-11 on parcels to the UK, Belgium,
 * Spain, Italy, Japan, Brazil and the US) dates its origin leg on China time
 * (`CAINIAO_CHINA_LEG`), from the warehouse to the departing linehaul, and the return warehouse
 * too, the warehouse's own steps and the origin sorting center's among them:
 * AliExpress's feed dates those +08:00, at sorting centers in mainland China
 * and Hong Kong. "Carrier update" is not listed: besides its own notices, on
 * China time, Cainiao words its transit sorting centers' scans that way. The seller's step before the warehouse is on China time as well:
 * read as labeled, it comes after ParcelsApp first returns it. It dates
 * import customs on the destination's clock, and the last mile as well,
 * except the UK's, on GMT in July. Its transit hub, on GMT+2 for a
 * UK parcel, and "Arrived at linehaul office", on either side's clock, are
 * not listed: a parcel to Colombia reached that office four minutes before
 * MailAmericas' "Delivered by Airline" there. A
 * parcel bound for Portugal clears customs in Spain, on Madrid's clock:
 * AliExpress's own "Departed from customs" and the Madrid broker's scans have
 * the digits of Cainiao's import customs. The sorting-center sentences of
 * EcoScooting that Cainiao relays ("Your shipment has arrived at sorting
 * center") are on Madrid's clock as well, as EcoScooting's own are, also for a
 * parcel bound for Portugal.
 *
 * 4PX's page (2026-10-11, two parcels to the US) dates its scans up to the
 * departing flight on China time and the rest in the US. Its destination
 * partner's sorting center, which a parcel to France reaches before any
 * placed scan, is on the destination's clock there. EcoScooting's own
 * instants (two parcels) put its China leg on China time, its order and its
 * Spanish sorting center on Madrid's, and its last mile on the destination's:
 * Lisbon's for a "CNPRT" reference, otherwise Spain's.
 *
 * MailAmericas' older tracker gave each scan its site's offset, China's for
 * the origin leg and the Americas' after it. ParcelsApp relays the wall
 * clocks with no place before the destination's customs. Its Tax ID checks,
 * logged with the label, were dated up to six hours after ParcelsApp first
 * returned them on a parcel to Colombia, and come before that moment only on
 * China's clock, the parcel's origin (2026-10-16). Its scans in the
 * destination matched Cainiao's import customs to the minute on Colombia's,
 * and its "Container reception" AliExpress's own receipt by the local
 * delivery company, which states its offset.
 *
 * EMS's scans at the destination's office of exchange, from its arrival to its
 * departure, are on the destination's clock, as its origin leg is on the
 * origin's (`POSTAL_ORIGIN_LEG`): on a parcel from the UK to South Africa they
 * had the digits of the South African post's own copies, and its unplaced
 * "Held for customs inspection" those of UPU's "Held by customs" at the
 * Johannesburg office. Borrowed from the origin's scans before them, they came
 * an hour late. Its hold at that office ("Held at destination import office")
 * is the same office's scan.
 *
 * FIRST LINE's ("1ST") scans from its arrival at the destination airport are
 * on the destination's clock, as its partner's scans after them are (see
 * `WALL_CLOCKS`). Borrowed from its scans in Shenzhen, they came 15 hours
 * early on a parcel to California.
 *
 * A scan on a fixed clock borrows no neighbour's: borrowed from a GOFO
 * parcel's Florida scans, the label came 3 hours early and Cainiao's "Order
 * received" 12 hours after it, 19 seconds on China time. One in the
 * destination borrows only from a scan placed there, and otherwise takes its
 * single clock (`wallClockZones`).
 */
const KNOWN_CLOCKS: ReadonlyMap<string, readonly {
  wording: RegExp; zone: string; except?: string; otherwise?: string; via?: Readonly<Record<string, string>>;
}[]> = new Map([
  ['gofoexpress', [{ wording: /^shipping label created$/i, zone: 'America/Los_Angeles' }]],
  ['cainiao', [
    { wording: wordings(CAINIAO_CHINA_LEG), zone: CAINIAO_CHINA_ZONE },
    { wording: wordings(['import clearance start', 'import customs clearance complete', 'arrived at customs', 'leaving customs',
      'we\'re inspecting your order']), zone: DESTINATION, via: { PT: 'ES' } },
    { wording: wordings(['your shipment has arrived at sorting center', 'your shipment has been processed at sorting center and ready for shipping']),
      zone: 'Europe/Madrid' },
    { wording: wordings(CAINIAO_LAST_MILE), zone: DESTINATION, except: 'GB' },
  ]],
  ['mailamericas', [
    { wording: /^(?:order created|tax id|origin warehouse)\.|^transit to destination country\. (?:on the way to the airport|origin customs|flight)$/i,
      zone: ORIGIN },
    { wording: /^(?:arrived at destination country|destination customs|wi\s*[–-]\s*intermediate warehouse|receiving destination mail|received in destination office|delivery (?:branch|office)|finished)\.|^delivered\b|^container reception$/i,
      zone: DESTINATION },
  ]],
  ['4pxexpress', [
    { wording: wordings(['parcel information received', 'pickup scanned, in transit to warehouse', 'shipment picked up\\.?',
      'shipment arrived at facility and measured\\.?', 'depart from facility to service provider\\.?', 'hand over to airline\\.?',
      'departure from the original airport']), zone: 'Asia/Shanghai' },
    { wording: wordings(['arrival to the destination airport', 'arrived at warehouse', 'released from customs: customs cleared\\.?',
      'customs clearance agent received the shipment in destnation country\\.?', 'in transit, it\'s progressing through post network',
      'handed over to last mile', 'your shipment has been processed at sorting center and ready for shipping']), zone: DESTINATION },
  ]],
  ['1st', [
    { wording: wordings(['arrived at destination airport', 'import scan', 'released from customs: customs cleared\\.?',
      'departed from destination facility']), zone: DESTINATION },
  ]],
  ['ems', [
    { wording: wordings(['arrived at destination import office', 'held at destination import office', 'held for customs inspection',
      'presented to import customs', 'released from import customs', 'departed from destination import office']), zone: DESTINATION },
  ]],
  ['ecoscooting', [
    { wording: /^(?:shipment data information received|shipment has left cainiao express's partner facility|shipment is in transit to cainiao express)$/i,
      zone: 'Asia/Shanghai' },
    { wording: /^(?:create|sorting center (?:inbound|outbound))\./i, zone: 'Europe/Madrid' },
    { wording: /^(?:accepted by last mile|out for delivery|delivery attempt failure|delivery success|pudo inbound success|delivered to pudo)\./i,
      zone: DESTINATION, otherwise: 'Europe/Madrid' },
  ]],
]);

/**
 * A scan's known clock: its zone, null when the destination or origin has
 * several, and for a scan in the destination, that country, or the one `via`
 * names for it.
 */
function knownClock(name: unknown, status: string, destination: string | null, origin: string | null = null): { zone: string | null; country?: string } | null {
  const known = KNOWN_CLOCKS.get(nameKey(name))?.find(({ wording }) => wording.test(status.trim()));
  if (known?.zone === ORIGIN) return origin ? { zone: countryTimeZone(origin) } : null;
  if (!known || known.zone !== DESTINATION) return known ? { zone: known.zone } : null;
  if (!destination) return known.otherwise ? { zone: known.otherwise } : null;
  if (destination === known.except) return null;
  const country = known.via?.[destination] ?? destination;
  return { zone: countryTimeZone(country), country };
}
/**
 * Networks whose dates are their home clock wherever the scan was: their own
 * instants or labels shown on that clock, checked on 2026-10-10. Italy Post's
 * are Poste Italiane's epoch milliseconds on Rome time. New Zealand Post's
 * are NZ Post's UTC instants on Auckland time, also for the scans it relays
 * from abroad ("Hong Kong"). Singapore Post's are SingPost's "+08:00" digits,
 * also for its scans in China, and SunYou's those of its feed's origin leg,
 * on "+08:00". Landmark Global's are its tracking page's US Central clock,
 * also for the delivery partner's scans it relays: guessed from the check's
 * zone instead, the same scan moved by two hours. Royal Mail's and
 * Parcelforce's are the labels of Royal Mail's tracker on London time, at
 * home and beyond Europe: a South African office's scans have the instants of
 * the South African post's own clock that way. Their European partners'
 * relays keep another clock (`royalMailRelay`).
 */
const HOME_CLOCKS: Readonly<Record<string, string>> = {
  italypost: 'Europe/Rome', landmarkglobal: 'America/Chicago', newzealandpost: 'Pacific/Auckland', singaporepost: 'Asia/Singapore',
  sunyousytrack: 'Asia/Shanghai', royalmail: 'Europe/London', parcelforce: 'Europe/London', parcelforceworldwide: 'Europe/London',
};
/**
 * Correios Brazil's dates, under any of its names, are Brasília's clock
 * wherever the scan was: its own tracker gives its rows America/Sao_Paulo,
 * and 17TRACK's -03:00 copies of the same scans, in Curitiba and in the origin
 * country, have ParcelsApp's digits. Brazil keeps several zones, so its scans
 * otherwise kept the UTC label.
 */
const CORREIOS_BRAZIL_CLOCK = 'America/Sao_Paulo';
/**
 * SunYou's feed dates its destination leg, from the arrival at the
 * destination's airport, on the destination's clock: "+02:00" for a parcel to
 * Spain, where ParcelsApp has the same digits and EcoScooting's own instants
 * agree. Those scans take the destination's single clock, or else only a guess.
 */
const SUNYOU_DESTINATION_LEG = /^(?:arrived at destination country airport|customs clearance\b|hand over to last mile|arrived at the processing center of the last mile provider|out for delivery|delivery in progress|delivery failed|delivered\b)/i;
/**
 * Speedaf's own feed dates each scan on its site's clock: China's up to the
 * departing flight ("Cargo flight departured"), then the destination's.
 * ParcelsApp keeps the digits under a UTC label, and its Cainiao copies of the
 * same scans agree once read that way. A scan whose digits come after the
 * flight's is in the destination, which gives it a zone if it has one clock.
 */
function speedafDeparture(payload: Record<string, unknown>): string | undefined {
  return (Array.isArray(payload.states) ? payload.states : []).flatMap((raw: unknown) => {
    const name = isRecord(raw) ? stateCarrierName(payload, raw) : undefined;
    return isRecord(raw) && typeof name === 'string' && carrierIdFromName(name) === 'speedaf' && typeof raw.status === 'string'
      && /^cargo flight depart(?:ed|ured)$/i.test(raw.status.trim()) ? [mislabeledWallTime(raw.date) ?? ''] : [];
  }).sort().at(-1) || undefined;
}
function speedafZone(payload: Record<string, unknown>, date: unknown, destination: string | null): string | undefined {
  const wall = mislabeledWallTime(date);
  const departed = speedafDeparture(payload);
  if (!wall || !departed || wall <= departed) return 'Asia/Shanghai';
  return countryTimeZone(destination) ?? undefined;
}
/**
 * SwiftX's dates are its sites' wall clocks: its own tracker gives each scan
 * its site's offset, which follows daylight saving time (carriers/swiftx).
 * ParcelsApp keeps the digits under a UTC label and writes the site after the
 * country and town, with no state ("US, EXAMPLE TOWN, EWR HUB"). SwiftX names
 * its sites by airport code, and a site listed here gives its zone: its EWR
 * hub's digits, read on Eastern time, have to the second the instants of
 * DHLink's copies of the same scans, which DHLink dates on China's clock, and
 * its New Jersey warehouse's those SwiftX's own tracker gives. Its ORD hub,
 * at Chicago O'Hare, is on Central time: KTD files its scans at the same
 * digits under the hub's town and state. A delivery or
 * failed delivery names the recipient's town and no site ("US, EXAMPLE TOWN"):
 * SwiftX's tracker gives it the offset of the warehouse that sent the parcel
 * out, so it takes the zone of the newest listed site scanned before it.
 * Other sites keep SwiftX's catalog zone, Pacific. Its labels ("Shipping Label
 * Created", at "US, SYSTEM, SYSTEM") carry GMT-07:00 in every season in its
 * own tracker, and keep that clock wherever they are.
 */
const SWIFTX_SITES: ReadonlyMap<string, string> = new Map([
  ['EWR HUB', 'America/New_York'], ['EWR_NJ WAREHOUSE', 'America/New_York'], ['ORD HUB', 'America/Chicago'],
]);
const SWIFTX_LABEL = /^shipping label created$/i;
const SWIFTX_LABEL_CLOCK = 'UTC-7';
function swiftxListedZone(location: string): string | null {
  const site = location.split(',').at(-1)?.trim().replace(/\s+/g, ' ').toUpperCase();
  return (site && SWIFTX_SITES.get(site)) || null;
}
function swiftxSiteZone(payload: Record<string, unknown>, state: Record<string, unknown>, location: string): string | null {
  const listed = swiftxListedZone(location);
  if (listed || location.split(',').length !== 2) return listed;
  const at = Date.parse(String(state.date));
  let newest: { at: number; zone: string } | null = null;
  for (const raw of Array.isArray(payload.states) ? payload.states : []) {
    if (!isRecord(raw) || raw === state) continue;
    const name = stateCarrierName(payload, raw);
    const zone = typeof name === 'string' && carrierIdFromName(name) === 'swiftx' ? swiftxListedZone(scanLocation(name, raw.location)) : null;
    const scanned = Date.parse(String(raw.date));
    if (zone && scanned <= at && (!newest || scanned > newest.at)) newest = { at: scanned, zone };
  }
  return newest?.zone ?? null;
}
// A UPU office of exchange in Portugal leading a CTT location: "PTLISB - (OUTRO) LISBON PROV".
const CTT_HOME_OFFICE = /^PT[A-Z0-9]{4}\s+-\s/;
/**
 * CTT's copies keep the digits of CTT's own tracker, whose Z is no offset:
 * the wall clock where the scan happened (carriers/ctt/clock.ts). ParcelsApp
 * drops CTT's event codes, so its offices of exchange tell the side of the
 * border: an office or a CTT site names its own clock; on mail from abroad, a
 * scan before the first at a Portuguese office is the origin post's, and on a
 * parcel bound abroad, one after the last is the destination post's; any
 * other is on Portugal's clock.
 */
function cttZone(payload: Record<string, unknown>, location: string, date: unknown, number: string, destination: string | null): string | undefined {
  const origin = replyOrigin(payload, number);
  const site = cttSiteZone(location, [origin, destination]);
  if (site) return site;
  const wall = mislabeledWallTime(date);
  const home = (Array.isArray(payload.states) ? payload.states : []).flatMap((raw: unknown) => {
    const name = isRecord(raw) ? stateCarrierName(payload, raw) : undefined;
    return isRecord(raw) && typeof name === 'string' && carrierIdFromName(name) === 'ctt' && typeof raw.location === 'string'
      && CTT_HOME_OFFICE.test(raw.location.trim()) ? [mislabeledWallTime(raw.date) ?? ''] : [];
  }).filter(Boolean).sort();
  const partner = !wall ? null : origin && origin !== 'PT' && (!home.length || wall < home[0]!) ? origin
    : origin === 'PT' && destination && destination !== 'PT' && home.length && wall > home.at(-1)! ? destination : null;
  return (partner ? countryTimeZone(partner) : portugalZone(location)) ?? undefined;
}
/**
 * Networks whose dates are their scans' local clocks, checked at home only
 * (2026-10-10): Korea Post's page and Bring's offsets (in Denmark too);
 * Japan Post's, which its portal gives as local times, at 10:27 for a delivery
 * in Japan that Cainiao dates 10:27 GMT+9 and Ship24 01:27Z (2026-10-11). Pekaes' are the offset-less digits its own
 * history gives and its page labels Polish time (2026-10-13). Yodel's, InPost's
 * UK network, are London's: InPost's own offsets give the same instants
 * (2026-10-16), as they do for Collect+'s, Yodel's shop network, which Ship24
 * dates "+01:00" in summer. XZG's, a Shenzhen line provider's, are China's:
 * XZG's own tracker and DHLink's, which relays it, give the same digits, and
 * DHLink records its warehouse scans within seconds on its system clock,
 * which is China's. On that clock XZG's scans stay one with DHLink's copies,
 * which take DHLink's catalog zone, whether or not a reply has them and
 * whatever zone routing passes. Saudi Post's (SPL's) are Riyadh's at home and
 * their place's abroad: its own tracker dates an origin post's scans and an EMS
 * partner's on their own place's clock (carriers/saudi-post), and its copy of
 * a departure from Sydney has the digits of EMS's there. "BRT Bartolini"'s,
 * with or without the identifier type in brackets, are Rome's: they have the
 * digits of BRT's own page, which writes its depots' Italian wall clocks
 * (2026-10-21). The South African post's are Johannesburg's at home and their
 * place's abroad: on a parcel from the UK, its copy of the departure from the
 * British office of exchange had the digits of Royal Mail's own scan on London
 * time, and read on Johannesburg's, its arrival there came at the instant of
 * Parcelforce's label read on London's. Their home clock is a guess, which a
 * location in another country rules out.
 */
const HOME_COUNTRIES: Readonly<Record<string, string>> = {
  southkoreapost: 'Asia/Seoul', postennorgenorwaypost: 'Europe/Oslo', japanpost: 'Asia/Tokyo',
  pekaes: 'Europe/Warsaw', yodel: 'Europe/London', inpostuk: 'Europe/London', collect: 'Europe/London', xzg: 'Asia/Shanghai',
  spl: 'Asia/Riyadh', saudipost: 'Asia/Riyadh',
  brtbartolini: 'Europe/Rome', brtbartoliniparcelid: 'Europe/Rome', brtbartolinidpd: 'Europe/Rome',
  southafricapostoffice: 'Africa/Johannesburg', southafricapost: 'Africa/Johannesburg',
};
/**
 * Royal Mail relays its partners' scans abroad on Central European time,
 * whatever the country's own clock. On a parcel to France, its receipt and
 * departure at the French office of exchange had the digits of La Poste's own
 * scans, Paris time; on one to Portugal, its "Item Received" and customs scans
 * came an hour after CTT's own digits, Lisbon time, at the same minute. A scan
 * located in another European country is such a relay, and so is one with no
 * place in Royal Mail's words for the destination ("Your item is currently with
 * Customs in the destination country.") on a parcel bound there. Beyond
 * Europe, the label is on London time (`HOME_CLOCKS`).
 */
const ROYAL_MAIL_RELAY_CLOCK = 'Europe/Brussels';
const ROYAL_MAIL_NAMES = new Set(['royalmail', 'parcelforce', 'parcelforceworldwide']);
const ROYAL_MAIL_HOME = new Set(['GB', 'JE', 'GG', 'IM']);
const ROYAL_MAIL_ABROAD = /\bin the destination country\b/i;
const europeanAbroad = (country: string | null) => Boolean(country && !ROYAL_MAIL_HOME.has(country)
  && countryTimeZone(country)?.startsWith('Europe/'));
function royalMailRelay(location: string, status: string, destination: string | null): boolean {
  const country = countryCode(lastPlace(location));
  if (country) return europeanAbroad(country);
  return !location && europeanAbroad(destination) && ROYAL_MAIL_ABROAD.test(status);
}
/**
 * Pitney Bowes's catalog clock, London's, is only its UK hub's. Its tracker
 * writes the other scans as Pitney Bowes's own adapter reads them:
 * - Interpost's import declaration and clearance, with the country they name
 *   alone as their place ("Customs Clearance" at "IT", "B2C ClearanceStatus4"
 *   at "NL"), on that country's clock;
 * - the platform's scans with no place at the hub's processing ("In Transit",
 *   "Item processed at Interpost", the hand-over), on their own fixed clocks
 *   (`pitneyBowesPlatformClock`);
 * - the destination post's scans it relays with no place
 *   (`pitneyBowesPostalRelay`), on that post's clock: the destination's single
 *   clock, else their wall clock. Its copies of Poste Italiane's delivery have
 *   the digits of Poste's own instant on Rome time.
 * Read on London's clock, all of them were an hour or two off Pitney Bowes's
 * own rows. TrackYourParcel, B2C Europe's tracker, relays the same scans at the
 * same digits in its own words and with no place ("Customs Clearance. Customs
 * Import submitted", "Shipped. Departure to country of destination"), so its
 * copy takes the clock of Pitney Bowes's scans at the same minute, when they
 * agree. Undefined leaves a scan to the hub's clock, or for TrackYourParcel to
 * the steps; a null zone keeps the wall clock.
 */
const INTERPOST_CUSTOMS = /^(?:customs clearance|b2c clearance ?(?:status ?)?\d{1,3})\b/i;
function pitneyBowesOwnClock(state: Record<string, unknown>, status: string, destination: string | null): { zone: string | null } | undefined {
  const location = typeof state.location === 'string' ? state.location.trim() : '';
  const country = /^[A-Z]{2}$/.test(location) && INTERPOST_CUSTOMS.test(status) ? countryCode(location) : null;
  const declared = country ? mainZone(country) : null;
  if (declared) return { zone: declared };
  if (location) return undefined;
  const platform = pitneyBowesPlatformClock(status);
  if (platform) return { zone: platform };
  return pitneyBowesPostalRelay(status) ? { zone: countryTimeZone(destination) } : undefined;
}
function pitneyBowesClock(payload: Record<string, unknown>, state: Record<string, unknown>, status: string,
  destination: string | null): { zone: string | null } | undefined {
  const network = nameKey(stateCarrierName(payload, state));
  if (network === 'pitneybowes') return pitneyBowesOwnClock(state, status, destination);
  if (network !== 'trackyourparcel') return undefined;
  const wall = mislabeledWallTime(state.date);
  const clocks = new Set((Array.isArray(payload.states) ? payload.states : []).flatMap((scan: unknown) => {
    if (!isRecord(scan) || wall === null || mislabeledWallTime(scan.date) !== wall || nameKey(stateCarrierName(payload, scan)) !== 'pitneybowes') return [];
    const clock = pitneyBowesOwnClock(scan, relayedLabel(scan.status), destination);
    return clock ? [clock.zone] : [];
  }));
  const [zone] = [...clocks];
  return clocks.size === 1 ? { zone: zone ?? null } : undefined;
}
const UNITED_STATES = /^(?:us|usa|united states(?: of america)?)$/i;
const POSTAL_CODE = /\s*\b(?:\d{5}(?:-\d{4})?|[A-Z]\d[A-Z] ?\d[A-Z]\d)$/i;
// A country's code before a postcode, as FedEx ends a location: "EXAMPLE TOWN, RR, IT 12345".
const COUNTRY_POSTCODE = /^([A-Z]{2})\s+(?=[A-Z\d -]*\d)[A-Z\d][A-Z\d -]{1,9}$/;
// USPS facilities: "EXAMPLE CITY IL DISTRIBUTION CENTER", "ISC EXAMPLE CITY IL (USPS)".
const US_FACILITY = /\s+(?:\(USPS\)|(?:(?:NETWORK|REGIONAL|INTERNATIONAL)\s+)?DISTRIBUTION\s+CENTER)$/i;
// States written out, as Orange Connex does for SpeedPAK ("Example City Minnesota, United States").
const US_STATE_NAMES: ReadonlyMap<string, string> = new Map(Object.entries({
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT',
  delaware: 'DE', districtofcolumbia: 'DC', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL',
  indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT',
  nebraska: 'NE', nevada: 'NV', newhampshire: 'NH', newjersey: 'NJ', newmexico: 'NM', newyork: 'NY',
  northcarolina: 'NC', northdakota: 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA',
  rhodeisland: 'RI', southcarolina: 'SC', southdakota: 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT',
  vermont: 'VT', virginia: 'VA', washington: 'WA', westvirginia: 'WV', wisconsin: 'WI', wyoming: 'WY',
}));

/**
 * The zone of the US state or Canadian province a location names ("Riverside,
 * CA, US", "Charlotte, NC", "Linden, NJ 12345", "Scranton PA", "Mississauga,
 * ON, CA", "Example City, IN, US 12345"). It is `certain` when the location
 * names the country, the code is no country's, or the town lies in that state
 * or province ("Chicago, IL" is not in Israel); "Atlanta, GA" could still be
 * in Gabon. A state written out counts only after the country ("Example City
 * Minnesota, United States"): Georgia is a country too.
 */
function regionClock(location: string): { zone: string; certain: boolean } | null {
  const parts = location.split(',').map((part) => part.trim()).filter(Boolean);
  const last = parts.at(-1) ?? '';
  const coded = parts.length > 2 ? COUNTRY_POSTCODE.exec(last)?.[1] : undefined;
  // "CA" after a province is Canada; after a town it is California.
  const country = parts.length > 1 && UNITED_STATES.test(last.replace(POSTAL_CODE, '')) ? 'US'
    : (parts.length > 1 && /^canada$/i.test(last)) || (parts.length > 2 && /^ca$/i.test(coded ?? last)) ? 'CA' : null;
  if (country) parts.pop();
  if (parts.length > 1 && !parts.at(-1)!.replace(POSTAL_CODE, '')) parts.pop();
  // "Example City, BE, NL" and "EXAMPLE CITY, BE, NL 1234": a region, then some other country.
  if (!country && parts.length > 2 && [parts.at(-2)!, coded ?? parts.at(-1)!].every((part) => /^[A-Z]{2}$/i.test(part))) return null;
  const words = (parts.at(-1) ?? '').replace(POSTAL_CODE, '').replace(US_FACILITY, '').split(/\s+/);
  if (country === 'US') {
    const size = [3, 2, 1].find((count) => words.length >= count && US_STATE_NAMES.has(nameKey(words.slice(-count).join(''))));
    if (size) return { zone: usStateTimeZone(US_STATE_NAMES.get(nameKey(words.slice(-size).join(''))))!, certain: true };
  }
  const code = parts.length > 1 || words.length > 1 ? words.at(-1)! : '';
  const town = parts.length > 1 ? parts.at(-2)! : words.slice(0, -1).join(' ');
  const zone = (country === 'CA' ? null : usStateTimeZone(code)) ?? (country === 'US' ? null : canadaProvinceTimeZone(code));
  return zone ? { zone, certain: country !== null || !countryCode(code) || regionHasTown(code, town) } : null;
}

/**
 * The last part of a location that is not a bare postcode: "Example Town,
 * Denmark, 4600" is in Denmark. Orange Connex names China and the United
 * States in full for SpeedPAK, Canada Post writes "USA", 4PX "US 12345", and
 * Hong Kong is not the name Intl gives it. FedEx writes a town, its region and
 * the country's code before the postcode ("EXAMPLE TOWN, RR, IT 12345"); with
 * two parts, "EXAMPLE TOWN, IN 12345" is a US state and its ZIP code. A
 * US military post office ("Fpo, AE") has none (`militaryPostOffice`).
 */
function lastPlace(location: string): string | undefined {
  if (militaryPostOffice(location)) return undefined;
  const parts = location.split(',').map((part) => part.trim()).filter((part) => part && !/^\d[\d\s-]*$/.test(part));
  const place = parts.at(-1);
  if (!place) return place;
  const coded = parts.length > 2 ? COUNTRY_POSTCODE.exec(place)?.[1] : undefined;
  return /^people['’]?s republic of china$/i.test(place) ? 'CN' : UNITED_STATES.test(place.replace(POSTAL_CODE, '')) ? 'US'
    : /^hong\s*kong$/i.test(place) ? 'HK' : coded ?? place;
}

/**
 * The origin post's scans as the postal feeds word them, UPU's and EMS's,
 * from posting to departure from its office of exchange (UPU's EMA to EMC and
 * EXA to EXD). They happen at the origin post, on its wall clock, wherever
 * their place is written in a script or a code no step reads ("GZSGJHHJ",
 * Guangzhou's office of exchange, or a postcode).
 */
const POSTAL_FEEDS = new Set(['universalpostalunion', 'upu', 'ems']);
const POSTAL_ORIGIN_LEG = wordings([
  'posting/collection', 'posted', 'item presented to export customs/security', 'presented to export customs and security',
  'item held by export customs/security', 'item returned from export customs/security', 'released from export customs and security',
  'arrived at export office', 'departed from export office', 'departed country of origin',
  '(?:arrival at|departure from|dispatch from|item held at) outward office of exchange',
]);
// The posting itself, UPU's "Posting/Collection" and EMS's "Posted" (EMA).
const POSTAL_POSTING = wordings(['posting/collection', 'posted']);

/**
 * Whether a China Post scan is on Beijing's clock: its place is written in
 * Chinese ("示例市 12345678"), ends with a mainland province ("Example City,
 * Guangdong") or is one of the cities above alone ("Shenzhen"). China Post
 * dates those scans in China, as 17TRACK's "+08:00" copies of them show.
 */
function inChina(location: string): boolean {
  const place = nameKey(location.split(',').at(-1));
  return /\p{Script=Han}/u.test(location) || CHINESE_PROVINCES.has(place) || (!location.includes(',') && CHINESE_CITIES.has(place));
}

// China Post's own clock, Beijing's.
const CHINA_POST_ZONE = 'Asia/Shanghai';
// China Post's office abroad that hands it the destination post's scans.
const CHINA_POST_OFFICE_ABROAD = /境外经转局/u;

/**
 * Whether a China Post scan is the destination post's: its place or wording
 * names the destination by the start of its Chinese name ("哥伦" for 哥伦比亚,
 * Colombia), or its office abroad ("Departed from 境外经转局"), or its place is
 * in the destination: the country by name, or a state or province on an item
 * bound for the US or Canada ("EXAMPLE CITY, NV 12345"). China Post copies
 * those scans with the destination post's digits: UPU's copies of them at the
 * destination's office of exchange have the same, to the minute.
 */
function chinaPostAbroad(location: string, status: string, destination: string | null): boolean {
  if (CHINA_POST_OFFICE_ABROAD.test(status)) return true;
  if (!destination || destination === 'CN') return false;
  const country = countryName(destination, 'zh');
  return [location, status].some((text) => (text.match(/\p{Script=Han}{2,}/gu) ?? []).some((run) => country.startsWith(run)))
    || countryCode(lastPlace(location)) === destination || ((destination === 'US' || destination === 'CA') && regionClock(location) !== null);
}

/**
 * A scan's location as the zone steps read it. 4PX writes the country, state
 * and town in fixed fields ("US  NY  EXAMPLE CITY 12345", "US    EXAMPLE CITY
 * NY DISTRIBUTION CENTER"), read here as "EXAMPLE CITY 12345, NY, US". A
 * country of one clock that the scan reports only once its label or posting
 * postcode is read (`reportedPlace`: "Country: Poland", "PL99999") is read as
 * that country, so the clock agrees with the place the scan shows: read as no
 * place, La Poste's scans in Poland kept ParcelsApp's UTC label, two hours late.
 */
function scanLocation(name: unknown, location: unknown): string {
  const text = typeof location === 'string' ? location.trim() : '';
  const reported = reportedPlace(text);
  if (!countryCode(lastPlace(text)) && countryTimeZone(reported)) return reported;
  if (nameKey(name) !== '4pxexpress' || !/^[A-Z]{2}(?:\s{2}|$)/.test(text)) return text;
  const [country, ...fields] = text.split(/\s{2}/).map((field) => field.trim());
  return [...fields.reverse(), country].filter(Boolean).join(', ');
}

// Australia's states and territories by abbreviation, each on its capital's clock.
const AUSTRALIAN_STATE_ZONES: ReadonlyMap<string, string> = new Map([
  ['ACT', 'Australia/Sydney'], ['NSW', 'Australia/Sydney'], ['NT', 'Australia/Darwin'], ['QLD', 'Australia/Brisbane'],
  ['SA', 'Australia/Adelaide'], ['TAS', 'Australia/Hobart'], ['VIC', 'Australia/Melbourne'], ['WA', 'Australia/Perth'],
]);

// The countries of the US, Canadian and Australian zones a state or province gives.
const STATE_ZONES: ReadonlyMap<string, string> = new Map([
  ...[...US_STATE_NAMES.values()].map((code) => [usStateTimeZone(code)!, 'US'] as const),
  ...['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT'].map((code) => [canadaProvinceTimeZone(code)!, 'CA'] as const),
  ...[...AUSTRALIAN_STATE_ZONES.values()].map((zone) => [zone, 'AU'] as const),
]);

// Australia's state capitals, by which the postal feeds name its offices ("SYDNEY EMS").
const AUSTRALIAN_CAPITALS: ReadonlyMap<string, string> = new Map([
  ['adelaide', 'SA'], ['brisbane', 'QLD'], ['canberra', 'ACT'], ['darwin', 'NT'],
  ['hobart', 'TAS'], ['melbourne', 'VIC'], ['perth', 'WA'], ['sydney', 'NSW'],
]);

/**
 * The clock of a scan in Australia, which has several: that of the state its
 * location names ("EXAMPLE TOWN NSW 2000"), else, with `capitals`, of the
 * state capital it names ("SYDNEY EMS, Australia"). It is read only for a scan
 * known to be in Australia, since "WA" and "SA" name other places too.
 */
function australianZone(location: string, capitals = true): string | null {
  const words = location.split(/[^A-Za-z]+/).filter(Boolean);
  const state = words.find((word) => AUSTRALIAN_STATE_ZONES.has(word))
    ?? (capitals ? words.map((word) => AUSTRALIAN_CAPITALS.get(word.toLowerCase())).find(Boolean) : undefined);
  return state ? AUSTRALIAN_STATE_ZONES.get(state)! : null;
}

/**
 * Whether a scan is a postal feed's posting, whose place names the posting
 * office: in Australia that office's capital need not be the scan's state.
 */
function postalPosting(name: unknown, status: string): boolean {
  return POSTAL_FEEDS.has(nameKey(name)) && POSTAL_POSTING.test(status.trim());
}

/**
 * The clock of the capital a postal feed's posting in Australia names, which
 * is its office's and can be another state's than the scan's: UPU named
 * "BRISBANE" for the posting of an item Australia Post received in New South
 * Wales, at its "+11:00" there, Sydney's summer clock, where Brisbane keeps
 * "+10:00". EMS's copy, under the office's code, has the same digits. Such a
 * posting borrows its feed's clock first (`wallClockZones`), and only then
 * takes the capital's.
 */
function postingOffice(name: unknown, status: string, location: string, origin: string | null): string | null {
  const country = countryCode(lastPlace(location));
  return origin === 'AU' && (!country || country === 'AU') && postalPosting(name, status) ? australianZone(location) : null;
}

/**
 * A guessed zone, unless the location names a country it is not in: a guess
 * cannot put a scan in "Example City, South Africa" on Paris time. Guesses
 * from the name or from routing are single-clock countries' zones, so a
 * location in the US or Canada rules them out too. A borrowed zone can be a
 * state's or a province's, and must then be in the country the location names.
 * A US military post office can be anywhere in its region, so nothing fits it.
 */
function fitsPlace(zone: string | null, location: string, borrowed = false): string | null {
  if (militaryPostOffice(location)) return null;
  const country = countryCode(lastPlace(location));
  const zoneCountry = zone ? timeZoneCountry(zone) ?? (borrowed ? STATE_ZONES.get(zone) : undefined) : undefined;
  return zone && (!country || zoneCountry === country) ? zone : null;
}

/** Where a location puts a scan, for the reply-wide North America check. */
function placeKind(location: string): 'certain' | 'region' | 'abroad' | null {
  const region = regionClock(location);
  if (region?.certain) return 'certain';
  const place = lastPlace(location);
  if (countryTimeZone(place)) return 'abroad';
  if (region) return 'region';
  const country = countryCode(place);
  return country && country !== 'US' && country !== 'CA' ? 'abroad' : null;
}

/**
 * The state or province of a North American scan from a carrier whose dates
 * are local clocks. An uncertain one counts only in a reply that is in North
 * America.
 */
function regionScanZone(name: unknown, location: string, inNorthAmerica: boolean): { zone: string; certain: boolean } | null {
  const key = nameKey(name);
  const region = LOCAL_CLOCK_CARRIERS.has(key) || WALL_CLOCKS.has(key) ? regionClock(location) : null;
  return region && (region.certain || inNorthAmerica) ? region : null;
}

const POLAND_POST_RELAY = /^International Postal System$/i;

/**
 * The offset of a scan that carries one of its own. GOFO France's feed gives
 * the same instants, "+02:00" in summer (checked 2026-10-10); its US scans
 * come labeled UTC, on their local clock. Poland Post's scans at a place, a
 * Polish office or Poczta Polska's sender platform ("Electronic Sender"),
 * have the digits and offset of Poczta Polska's own tracker. Its relays from
 * abroad, with no place or at the "International Postal System", put
 * Poland's offset on the other country's clock, which its tracker leaves
 * without one. La Poste's scans it files at a country alone ("Country:
 * Poland", "PL99999") have La Poste's clock as UTC digits shifted into
 * Poland's offset: taken as given, they came two hours after La Poste's own.
 */
function ownOffset(name: unknown, date: unknown, location = ''): string | null {
  const key = nameKey(name);
  const own = key === 'gofoexpress'
    || (key === 'polandpost' && location !== '' && !POLAND_POST_RELAY.test(location) && !countryCode(location));
  const offset = own && typeof date === 'string' ? /[+-]\d{2}:\d{2}$/.exec(date.trim())?.[0] : undefined;
  return offset && !/^[+-]00:00$/.test(offset) ? offset : null;
}

/**
 * The clock of Poland Post's relay from abroad (`ownOffset`): the partner
 * post's, as Poczta Polska's own tracker reads it (`pocztaPolskaPartnerClock`),
 * with the digits as written. Taking Poland's offset off first put a Latvian
 * item's relayed scans two hours early on Riga's clock. With no partner clock
 * a relay keeps the reading it had.
 */
function polandPostRelay(name: unknown, date: unknown, location: string, number: string,
  destination: string | null): { zone: string; date: string } | null {
  if (nameKey(name) !== 'polandpost' || (location !== '' && !POLAND_POST_RELAY.test(location)) || typeof date !== 'string') return null;
  const written = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(?:Z|[+-]\d{2}:\d{2})?$/i.exec(date.trim())?.[1];
  const partner = written ? pocztaPolskaPartnerClock(number, destination) : null;
  return written && partner ? { zone: partner.zone, date: `${written}Z` } : null;
}

/**
 * The clock of the number's own network of a brand, when a country-qualified
 * name gives another: the depot prefix of a DPD UK number outweighs "DPD
 * France", the network ParcelsApp asked (checked 2026-10-10: DPD UK's own
 * page, Ship24 and 17TRACK put such scans on London time).
 */
function numberNetworkZone(carrier: string | undefined, number: string): string | null {
  const brand = carrier ? carrierBrand(carrier) : undefined;
  const own = brand ? brandCarrierForNumber(brand, number) : undefined;
  const zone = own && own !== carrier ? carrierTimezone(own) : 'UTC';
  return zone === 'UTC' ? null : zone;
}

/**
 * The clocks a bare brand's scan with no location can be on when its catalog
 * networks keep several (DPD's, with the UK's): the clock of the network that
 * labelled the parcel, which the number asked or a number ParcelsApp names
 * next for it (`next_tracking_ids`) gives by its depot range, with the
 * destination's and, where the brand has a network, the origin's. A line
 * carrier's parcel from China that DPD Switzerland delivers names DPD's number
 * next, and its "DPD Group" scan has the digits DPD Switzerland's own tracker
 * dates "+02:00". With no such number, or no destination with one clock, there
 * is none.
 */
function brandNetworkZones(payload: Record<string, unknown>, name: string, number: string, destination: string | null,
  origin: string | null): string[] {
  const next = Array.isArray(payload.next_tracking_ids) ? payload.next_tracking_ids : [];
  const numbers = [number, ...next.filter((id): id is string => typeof id === 'string' && id.length <= 40).slice(0, 10)];
  const labelled = new Set(numbers.flatMap((candidate) => brandCarrierForNumber(name, candidate) ?? []));
  const arrival = countryTimeZone(destination);
  if (!labelled.size || !arrival) return [];
  const departure = origin ? brandCarrierIds(name).filter((id) => carrierDefinition(id).countries?.includes(origin)) : [];
  return [...new Set([...[...labelled, ...departure].map((id) => carrierTimezone(id)), arrival])];
}

/**
 * Lines from China whose dates are the clock of each scan's place, China's at
 * home and the place's abroad, where the catalog gives them China's zone.
 * JS Express's own feed gives the digits ParcelsApp has with China's offset
 * at its Chinese warehouse, the Netherlands' at Schiphol and the destination
 * courier's at the courier's scans; read on China's clock, a parcel's scans at
 * Schiphol came six hours early, and another's landing at JFK under five
 * hours after its flight left China. ECMS's own tracker gives the digits
 * ParcelsApp has with each facility's offset, "+09:00" at Narita: read on
 * China's clock, they came an hour after ECMS's own rows. Not every line on
 * China's clock does this: Hualei's tenants (Mayi Yinfu) and DHLink date
 * their scans abroad on Beijing time. A scan of these lines takes Beijing's
 * clock in China (with JS Express's own rule for its flights there), else
 * that of the US state or Canadian province its place names for certain
 * ("New York, United States"), else the single clock of the country it
 * names. One with no place, only a town or a country of several clocks keeps
 * its wall clock. KTD's dates do this too: it files SwiftX's hub scans at
 * SwiftX's digits under the hub's town and state, and its flight's take-off
 * in Shanghai and landing in Chicago, which China's clock put 75 minutes apart.
 */
const PLACE_CLOCK_LINES = new Set(['js-express', 'ecms-express', 'ktd']);
function placeClockLine(carrier: string, status: string, location: string): string | null {
  const china = carrier === 'js-express' ? jsExpressChinaClock(status, location) : undefined;
  if (china !== undefined) return china;
  if (inChina(location)) return 'Asia/Shanghai';
  const region = regionClock(location);
  return region?.certain ? region.zone : countryTimeZone(lastPlace(location)) ?? null;
}

/**
 * The clock of a sending post's scan that Correo Uruguayo relays under the
 * country it names ("CHINA"): that country's, as on its own tracker, or null
 * when the country keeps several clocks. Read on Montevideo's clock, China
 * Post's posting came eleven hours after China Post's own row of it.
 * Undefined for a scan the place does not put abroad.
 */
function correoUruguayoRelayZone(location: string): string | null | undefined {
  const country = countryCode(lastPlace(location));
  return country && country !== 'UY' ? countryTimeZone(country) : undefined;
}

/**
 * The zone a scan's carrier gives it wherever it was: null for a date that is
 * its instant, and undefined for a scan its place dates (`siteZone`) or only a
 * guess does (`guessedZone`).
 */
function carrierClock(payload: Record<string, unknown>, state: Record<string, unknown>, number: string, status = '',
  destination: string | null = null): string | null | undefined {
  const name = stateCarrierName(payload, state);
  const key = nameKey(name);
  const carrier = typeof name === 'string' ? carrierIdFromName(name) : undefined;
  if (carrier === 'tnt' && /^\d{9}$/.test(number)) return null;
  if (typeof name === 'string' && ASENDIA_USA.test(name.trim())) return null;
  if (carrier === 'paack' || carrier === 'vinted-go' || carrier === 'austrian-post' || carrier === 'straightship'
    || ownOffset(name, state.date, scanLocation(name, state.location))) return null;
  // PostNL's scans in Britain have their UTC instants: FIC shows the same scans on Dutch time.
  if (carrier === 'spring-gds' && countryCode(lastPlace(scanLocation(name, state.location))) === 'GB') return null;
  if (key === 'sunyousytrack' && SUNYOU_DESTINATION_LEG.test(status.trim())) return countryTimeZone(destination) ?? undefined;
  if (carrier === 'imile') return countryTimeZone(destination);
  if (carrier === 'china-post' && chinaPostAbroad(scanLocation(name, state.location), status, destination)) return countryTimeZone(destination);
  // Cainiao's copies of Speedaf's scans keep Speedaf's digits, its arrival at the linehaul office too.
  if (carrier === 'speedaf' || (key === 'cainiao' && speedafDeparture(payload))) return speedafZone(payload, state.date, destination);
  // A SwiftX label keeps its own clock, and a listed SwiftX site dates its scans (`siteZone`).
  if (carrier === 'swiftx' && SWIFTX_LABEL.test(status.trim())) return SWIFTX_LABEL_CLOCK;
  if (carrier === 'swiftx' && swiftxSiteZone(payload, state, scanLocation(name, state.location))) return undefined;
  if (ROYAL_MAIL_NAMES.has(key) && royalMailRelay(scanLocation(name, state.location), status, destination)) return ROYAL_MAIL_RELAY_CLOCK;
  if (key === '1st') {
    const location = scanLocation(name, state.location);
    return !location || firstLineInChina(location) ? FIRST_LINE_CHINA_ZONE : undefined;
  }
  // Croatia Post relays a post abroad on that facility's clock, as its own tracker does. A scan
  // without an office can be that post's too, so it keeps its wall clock, as Hrvatska pošta's adapter reads it.
  if (carrier === 'hrvatska-posta' && !scanLocation(name, state.location)) return null;
  const abroad = carrier === 'hrvatska-posta' ? hrvatskaPostaForeignZone(scanLocation(name, state.location)) : undefined;
  if (abroad !== undefined) return abroad;
  // Correos relays an origin post's scans on an item from abroad on that post's clock, or keeps their wall clock (null).
  const sent = carrier === 'correos-spain' ? correosOriginZone(number, { wording: status }) : undefined;
  if (sent !== undefined) return sent;
  const relayed = carrier === 'correo-uruguayo' ? correoUruguayoRelayZone(scanLocation(name, state.location)) : undefined;
  if (relayed !== undefined) return relayed;
  if (carrier && PLACE_CLOCK_LINES.has(carrier)) return placeClockLine(carrier, status, scanLocation(name, state.location));
  if (Object.hasOwn(HOME_CLOCKS, key)) return HOME_CLOCKS[key]!;
  if (carrier === 'correios-br') return CORREIOS_BRAZIL_CLOCK;
  // A home clock stays a guess that a location abroad rules out, even when
  // the catalog gives the network that zone (GEODIS Poland for "Pekaes").
  const zone = carrier && !Object.hasOwn(HOME_COUNTRIES, key) ? carrierTimezone(carrier) : 'UTC';
  // A country-qualified routing name can identify a branch rather than the
  // scan location. Keep its clock as a guess even when the alias is catalogued.
  return zone !== 'UTC' && !(typeof name === 'string' && carrierNameCountryZone(name)) ? zone : undefined;
}

// Countries whose states or provinces the steps read, where a town alone can be hours from the main clock.
const REGIONAL_CLOCKS = new Set(['AU', 'CA', 'US']);

/**
 * The clock of a postal feed's scan that its place puts only in a country of
 * several clocks ("CURITIBA, Brazil", "SANTIAGO EXAMPLE, Chile"): the one most
 * of the country's people live on. UPU's and EMS's dates are the office's wall
 * clock under a UTC label: Correos Chile dates its posting and Correios Brazil
 * its arrival in Curitiba at the same digits, three hours later as instants.
 * A state or province's code ("EXAMPLE CITY, MN") is no country here.
 */
function postalCountryZone(name: unknown, location: string): string | null {
  const country = countryCode(lastPlace(location));
  return POSTAL_FEEDS.has(nameKey(name)) && country && hasSeveralClocks(country) && !REGIONAL_CLOCKS.has(country) && !regionClock(location)
    ? mainZone(country) : null;
}

// A UPU office code (IMPC): two letters for its country, three for its place and one more.
const POSTAL_OFFICE = /^([A-Z]{2})[A-Z]{3}[A-Z0-9]$/;

/**
 * Whether a postal feed's scan is placed only by the code of an office in the
 * destination. UPU's copies there have the destination post's digits under a
 * UTC label: 4-72 dates the delivery UPU copies at such an office at the same
 * digits, and read as UTC they came hours off China Post's copies of the same
 * scans. They keep their wall clock for the places step to date, which reads
 * a town's name first: "MADRID" is no Moroccan office. EMS's are wall clocks
 * already (`knownClock`).
 */
function destinationOffice(name: unknown, location: string, destination: string | null): boolean {
  return POSTAL_FEEDS.has(nameKey(name)) && destination !== null && POSTAL_OFFICE.exec(location)?.[1] === destination;
}

/**
 * The zone a scan's place gives it: null for a DHL Express facility the rule
 * cannot place, and undefined for a scan only a guess can place (`guessedZone`).
 * China Post's scans that no place dates, with none or one the steps cannot tell
 * ("Example Town ENG GB AB1"), are on its own clock, Beijing's: 17TRACK's
 * "+08:00" copies of its airline handovers and of such scans have their digits.
 */
function siteZone(payload: Record<string, unknown>, state: Record<string, unknown>, number: string, inNorthAmerica = false,
  status = '', destination: string | null = null): string | null | undefined {
  const name = stateCarrierName(payload, state);
  const key = nameKey(name);
  const carrier = typeof name === 'string' ? carrierIdFromName(name) : undefined;
  const location = scanLocation(name, state.location);
  if (carrier === 'ctt') return cttZone(payload, location, state.date, number, destination);
  if (carrier === 'swiftx') return swiftxSiteZone(payload, state, location) ?? undefined;
  // A facility's clock, whatever the label: no other step applies to it.
  if (relaysFacilityClock(name)) return facilityZone(location);
  if (carrier === 'china-post' && inChina(location)) return CHINA_POST_ZONE;
  const place = lastPlace(location);
  // A state or province the town confirms beats the country its code also
  // names ("Chicago, IL"); a merely possible one comes after ("Koeln, DE").
  const region = regionScanZone(name, location, inNorthAmerica);
  if (region?.certain) return region.zone;
  // A posting's capital names its office, not the scan's state (`postingOffice`).
  const capitals = !postalPosting(name, status);
  // A town of the state or province whose code a country shares is not in
  // that country: "Denver, CO" is not in Colombia, whoever scanned it.
  const located = regionClock(location)?.certain ? null
    : countryTimeZone(place) ?? (countryCode(place) === 'AU' ? australianZone(location, capitals) : null);
  if (located) return located;
  if (region) return region.zone;
  const postal = postalCountryZone(name, location);
  if (postal) return postal;
  if (POSTAL_FEEDS.has(key) && POSTAL_ORIGIN_LEG.test(status.trim())) {
    const origin = replyOrigin(payload, number);
    return countryTimeZone(origin) ?? (origin === 'AU' ? australianZone(location, capitals) : null) ?? undefined;
  }
  // A ZIP Code alone, on an item bound for the US, is the delivery office's, and UPU
  // dates its scans there on that office's clock: China Post's copy of the delivery
  // has the digits of UPU's, on the clock its place in the US gives it.
  const zip = POSTAL_FEEDS.has(key) && destination === 'US' ? usStateTimeZone(usZipState(location)) : null;
  if (zip) return zip;
  return carrier === 'china-post' ? CHINA_POST_ZONE : undefined;
}

/**
 * Whether a scan names no network that the catalog or the tables above know:
 * no carrier, or a name new to both ("Example Parcel Co"). Its date is still
 * ParcelsApp's wall clock under a UTC label, and nothing says on which clock,
 * so one that no step places has no instant.
 */
function unknownNetwork(name: unknown): boolean {
  if (typeof name !== 'string' || !name.trim()) return true;
  const key = nameKey(name);
  return !isKnownCarrierName(name) && !isCarrierFeedName(name) && !Object.hasOwn(HOME_CLOCKS, key) && !Object.hasOwn(HOME_COUNTRIES, key)
    && ![WALL_CLOCKS, LOCAL_CLOCK_CARRIERS, POSTAL_FEEDS].some((keys) => keys.has(key)) && !KNOWN_CLOCKS.has(key);
}

/**
 * Whether a scan names a bare brand all of whose catalog networks keep a local
 * clock ("DPD Group", "GLS"; `brandTimeZones`). Its date is the wall clock of
 * whichever network scanned it under a UTC label: DPD Germany's own tracker
 * dates a "DPD Group" handover two hours before ParcelsApp's label. So one
 * that no step places, where the networks keep different clocks or the scan's
 * location may be a network outside the catalog, has no instant. A brand with
 * a network on UTC (DHL's eCommerce network) keeps its label.
 */
function localClockBrand(name: unknown): boolean {
  return typeof name === 'string' && brandTimeZones(name).length > 0;
}

function guessedZone(payload: Record<string, unknown>, state: Record<string, unknown>, fallback: string | null, number: string,
  destination: string | null = null, origin: string | null = null): string | null {
  const name = stateCarrierName(payload, state);
  const key = nameKey(name);
  const carrier = typeof name === 'string' ? carrierIdFromName(name) : undefined;
  const location = scanLocation(name, state.location);
  // The zones below only guess where the scan was. A location in another
  // country, one with several clocks or none listed ("Example City, CA,
  // United States", "Example City, South Africa"), rules a guess out, and the
  // scan keeps its labeled instant, or its wall clock (`unknownNetwork`).
  const guess = (candidate: string | null) => fitsPlace(candidate, location);
  if (typeof name !== 'string') return guess(fallback);
  const nameZone = carrierNameCountryZone(name);
  const named = guess((nameZone && numberNetworkZone(carrier, number)) || nameZone || (HOME_COUNTRIES[key] ?? null));
  if (named) return named;
  // A location with no single-clock country ("Toronto, ON", "Chicago, US")
  // can be a network of the brand outside the catalog, on another clock.
  const brand = location ? [] : brandTimeZones(name);
  const wall = brand.length ? mislabeledWallTime(state.date) : null;
  return (wall ? sharedClockZone(brand, wall) ?? sharedClockZone(brandNetworkZones(payload, name, number, destination, origin), wall) : null)
    ?? guess(fallback);
}

/**
 * How to read a state: the zone its carrier or place gives (with the guesses of steps 3 to 5
 * for a network that is not a wall clock), whether its state or province
 * gave it, and for a wall-clock scan, routing's zone and any known clock,
 * which `wallClockZones` falls back on.
 */
function readState(payload: Record<string, unknown>, raw: Record<string, unknown>, status: string, fallback: string | null, number: string,
  inNorthAmerica = false, destination: string | null = null, origin: string | null = null) {
  const name = stateCarrierName(payload, raw);
  const location = scanLocation(name, raw.location);
  const offset = ownOffset(name, raw.date, location);
  const wallClock = WALL_CLOCKS.has(nameKey(name)) && !offset;
  const relay = polandPostRelay(name, raw.date, location, number, destination);
  const pitneyBowes = relay ? undefined : pitneyBowesClock(payload, raw, status, destination);
  const own = relay?.zone ?? (pitneyBowes ? pitneyBowes.zone : carrierClock(payload, raw, number, status, destination));
  // iMile's page writes every scan on the recipient country's clock, wherever it happened, and
  // ParcelsApp has its digits; read on iMile's catalog zone they came out early. A destination
  // of one zone places them, and without one they keep their wall clock. So do China Post's
  // copies of the destination post's scans (`chinaPostAbroad`), Croatia Post's scan without an
  // office or at a facility abroad whose office code names no single clock, Correos's and Correo
  // Uruguayo's copies of an origin post's scan from a country of several clocks, a scan of a
  // line on its place's clock that its place does not date (`PLACE_CLOCK_LINES`), and Pitney
  // Bowes's relay of a destination post's scan on a parcel bound for no single clock (`pitneyBowesClock`).
  const ownCarrier = typeof name === 'string' ? carrierIdFromName(name) ?? '' : '';
  const unplacedWall = own === null && !offset && (pitneyBowes?.zone === null
    || ['imile', 'china-post', 'hrvatska-posta', 'correos-spain', 'correo-uruguayo'].includes(ownCarrier) || PLACE_CLOCK_LINES.has(ownCarrier));
  const sited = own === undefined ? siteZone(payload, raw, number, inNorthAmerica, status, destination) : undefined;
  const placed = own !== undefined ? own : sited;
  // A posting that only its office's capital places borrows first (`postingOffice`).
  const office = placed === undefined ? postingOffice(name, status, location, replyOrigin(payload, number)) : null;
  const destinationCode = placed === undefined && !wallClock && destinationOffice(name, location, destination);
  const zone = placed !== undefined ? placed
    : wallClock || office || destinationCode ? null : guessedZone(payload, raw, fallback, number, destination, origin);
  const known = wallClock ? knownClock(name, status, destination, origin) : null;
  // A local clock that nothing places, in the US or Canada alone ("US 12345").
  const country = countryCode(lastPlace(location));
  const nationwide = placed === undefined && zone === null && LOCAL_CLOCK_CARRIERS.has(nameKey(name)) && (country === 'US' || country === 'CA');
  return { name, date: relay?.date ?? raw.date, zone, placed: placed ?? null, sited: sited ?? null, guessed: placed === undefined && !wallClock,
    offset, location, wallClock, nationwide, office,
    local: zone !== null && zone === regionScanZone(name, location, inNorthAmerica)?.zone,
    fallback: wallClock || office ? fitsPlace(fallback, location) : null, known: known?.zone ?? null, arrival: known?.country ?? null,
    // With no zone, a scan whose label nothing vouches for keeps its wall clock.
    wallOnly: unplacedWall || destinationCode || unknownNetwork(name) || localClockBrand(name) || militaryPostOffice(location) };
}

type ZoneStep = 'carrier' | 'place' | 'copy' | 'borrowed' | 'routing' | 'known' | 'labeled';

/**
 * The zone of each scan. One from a network that is not a wall clock keeps
 * the one it has. A wall-clock scan takes, in order:
 * 1. the zone of its place;
 * 2. that of another carrier's placed scan with the same digits and wording,
 *    which it copies (`copy`);
 * 3. as a guess, that of the scan of its network just before it by wall
 *    clock that steps 1 and 2 place, else of the one just after it; for a
 *    scan in the destination, only of one placed there;
 * 4. its known clock (`KNOWN_CLOCKS`): a fixed one, for a scan that skips
 *    step 3, or the destination's single clock;
 * 5. the zone routing passes for the parcel, which is another network's for
 *    a parcel filed under it: Lagos's for Cainiao's copies under Speedaf;
 * 6. none: it keeps ParcelsApp's label, as it did before these steps, the
 *    last guess.
 * A zone the scan's location rules out is skipped ("USA" takes no Canadian
 * zone). Step 3 holds when the scan happens where its neighbours do, and is
 * hours off when it does not. Checked on 2026-10-10 against the carriers'
 * own clocks: Canada Post's first scan and one in Chicago took the right
 * zone, and its last two, in Montana, the Chicago hub's, an hour off USPS's.
 * SpeedPAK's four took the right one, and a Chinese system event the US one,
 * 14 hours off. USPS's "In Transit to Next Facility" was not checked: no
 * source gives its clock. 4PX's scans between the departing flight and the
 * first US scan took China's until they were known to be in the destination
 * (2026-10-11); its US scans with no state take the right zone, or one an
 * hour off when the parcel changed zones around them.
 *
 * A scan of a carrier with local clocks (`LOCAL_CLOCK_CARRIERS`) that its
 * location places only in the US or Canada borrows as in step 3, from a scan
 * of its network that a place gives a zone, and otherwise keeps its label.
 * FedEx's "Shipment information sent to FedEx" under the shipper's ZIP code
 * took the zone of the pickup's state after it, as FedEx's own page dates it
 * (checked 2026-10-11).
 *
 * A postal feed's posting in Australia that only its office's capital places
 * (`postingOffice`) borrows as in step 3 too, and takes that capital's clock
 * after any known clock, before routing's.
 */
function wallClockZones(entries: readonly {
  name: unknown; date: unknown; location: string; zone: string | null; placed: string | null; copy: string | undefined;
  wallClock: boolean; nationwide: boolean; office: string | null; fallback: string | null; known: string | null; arrival: string | null;
}[]): { zone: string | null; step: ZoneStep }[] {
  const found = entries.map((entry): { zone: string | null; step: ZoneStep } | null => !entry.wallClock
    ? entry.zone || !(entry.nationwide || entry.office) ? { zone: entry.zone, step: 'carrier' } : null
    : entry.zone ? { zone: entry.zone, step: 'place' } : entry.copy ? { zone: entry.copy, step: 'copy' } : null);
  const walls = entries.map((entry) => mislabeledWallTime(entry.date) ?? '');
  return entries.map((entry, index) => {
    const own = found[index];
    if (own) return own;
    const key = nameKey(entry.name);
    const wall = walls[index]!;
    let before: { wall: string; zone: string } | undefined;
    let after: { wall: string; zone: string } | undefined;
    if (!entry.known || entry.arrival) {
      entries.forEach((other, at) => {
        const zone = other.wallClock !== entry.wallClock ? null : entry.wallClock ? found[at]?.zone : other.placed;
        const near = { wall: walls[at]!, zone: zone ?? '' };
        if (!zone || nameKey(other.name) !== key || !fitsPlace(zone, entry.location, true)) return;
        if (entry.arrival && (timeZoneCountry(zone) ?? STATE_ZONES.get(zone)) !== entry.arrival) return;
        if (near.wall <= wall) {
          if (!before || near.wall > before.wall) before = near;
        } else if (!after || near.wall < after.wall) after = near;
      });
    }
    const borrowed = (before ?? after)?.zone;
    const known = fitsPlace(entry.known, entry.location);
    return borrowed ? { zone: borrowed, step: 'borrowed' } : known ? { zone: known, step: 'known' }
      : entry.office ? { zone: entry.office, step: 'place' }
        : entry.fallback ? { zone: entry.fallback, step: 'routing' } : { zone: null, step: 'labeled' };
  });
}

/**
 * The zone of a scan that only a guess dates, or none, from another carrier's
 * scan at the same digits and place that its place dates (`siteZone`): the
 * same scan, relayed at the digits of where it happened. Saudi Post's copy of
 * a departure from Sydney, in SPL's words at its office "SYDNEY", has the
 * digits of EMS's "Departed from export office" at "Sydney". The place is the
 * location's first part, so "SYDNEY EMS, Australia" is another. Copies on
 * different clocks give none.
 */
function placeCopies(items: readonly { name: unknown; date: unknown; location: string; sited: string | null; guessed: boolean }[]): (string | null)[] {
  const site = ({ date, location }: typeof items[number]) => {
    const wall = mislabeledWallTime(date);
    const place = nameKey(location.split(',')[0]);
    return wall && place ? `${wall}|${place}` : '';
  };
  const sited = new Map<string, (readonly [string, string])[]>();
  for (const item of items) {
    const key = site(item);
    if (key && item.sited) sited.set(key, [...sited.get(key) ?? [], [nameKey(item.name), item.sited]]);
  }
  return items.map((item) => {
    const copies = item.guessed ? sited.get(site(item)) ?? [] : [];
    const zones = new Set(copies.filter(([network]) => network !== nameKey(item.name)).map(([, zone]) => zone));
    const [zone] = zones.size === 1 ? [...zones] : [];
    return zone ? fitsPlace(zone, item.location, true) : null;
  });
}

/**
 * The zone of China Post's copy of the destination post's scan that neither
 * its place nor its wording tells ("Final delivery" at a code of China Post's
 * own): that of another network's scan at the same minute whose zone is the
 * destination's, the post's own or UPU's copy of it. China Post's delivery on
 * an item to New Zealand had the minute of New Zealand Post's own delivery;
 * read on China's clock it came five hours later. China Post's own scans
 * abroad have no such twin and stay on China's clock.
 */
function chinaPostTwinZones(items: readonly { name: unknown; date: unknown; location: string }[], zones: readonly (string | null)[],
  destination: string | null): (string | null)[] {
  const minute = (date: unknown) => mislabeledWallTime(date)?.slice(0, 16) ?? '';
  const chinaPost = (name: unknown) => typeof name === 'string' && carrierIdFromName(name) === 'china-post';
  const twins = new Map<string, Set<string>>();
  items.forEach(({ name, date }, index) => {
    const zone = zones[index];
    const key = minute(date);
    if (destination && destination !== 'CN' && key && zone && !chinaPost(name) && keepsZone(destination, zone)) {
      twins.set(key, (twins.get(key) ?? new Set()).add(zone));
    }
  });
  return items.map(({ name, date, location }, index) => {
    const found = chinaPost(name) && zones[index] === CHINA_POST_ZONE && !inChina(location) ? twins.get(minute(date)) : undefined;
    return found?.size === 1 ? [...found][0]! : null;
  });
}

/**
 * The clock of a network that nothing places, as its copies show. A line
 * provider outside the catalog can file the same scans as the carrier that
 * relays it, at the same digits, with no place: under ParcelsApp's UTC label
 * each scan would come twice, hours apart. When every scan of a network has no
 * zone and the other carriers' copies of its scans, at the same digits and
 * wording, share one zone, that zone is the network's: its copies stay one
 * scan with theirs, and its own scans keep the same clock.
 */
function copiedNetworkZones(items: readonly { name: unknown; key: string; zone: string | null; fixed: boolean; location: string }[]): (string | null)[] {
  const zoned = new Map<string, string>();
  for (const { key, zone } of items) if (key && zone) zoned.set(key, zoned.has(key) && zoned.get(key) !== zone ? '' : zone);
  const unplaced = new Map<string, Set<string>>();
  for (const { name, key, zone, fixed } of items) {
    const network = nameKey(name);
    if (!network) continue;
    if (zone || fixed) unplaced.set(network, new Set(['']));
    else if (!unplaced.has(network)) unplaced.set(network, new Set());
    const copied = zoned.get(key);
    if (!zone && !fixed && copied !== undefined) unplaced.get(network)!.add(copied);
  }
  return items.map(({ name, zone, fixed, location }) => {
    const copies = unplaced.get(nameKey(name));
    const [clock] = copies?.size === 1 ? [...copies] : [];
    return !zone && !fixed && clock ? fitsPlace(clock, location) : null;
  });
}

const DAY_MS = 86_400_000;
const clockOf = (event: CarrierEvent): string => event.time ?? (typeof event.local_time === 'string' ? event.local_time : '');
/** An event's moment, a wall clock read as if UTC; a day alone is its start, or its end with `end`. */
function moment(event: CarrierEvent, end = false): number {
  if (event.time) return Date.parse(event.time);
  const local = clockOf(event);
  return local.length === 10 ? Date.parse(`${local}T00:00:00Z`) + (end ? DAY_MS : 0) : Date.parse(`${local}Z`);
}

/**
 * A carrier's acceptance after another carrier already moved the parcel is the
 * hand-over to it, as DPD's "parcel handed" is when it takes a cleared parcel
 * from the line carrier: the parcel moves on rather than starting over. A wall
 * clock is later only by more than a day, whatever its zone, except after a
 * dated move: an acceptance whose wall time would sort above that move, as the
 * result sorts it, is the hand-over too, so it does not stand as the parcel's
 * newest step over the move (a forwarder's "goods have been picked up from
 * warehouse" on its own clock, hours after DPD Poland's dated scans).
 */
function markHandovers(carried: readonly { event: CarrierEvent; carrier: string }[]): void {
  const moved = new Map<string, CarrierEvent>();
  for (const { event, carrier } of carried) {
    const earliest = moved.get(carrier);
    if (carrier && clockOf(event) && (event.stage === 'in_transit' || event.stage === 'customs')
      && (!earliest || moment(event) < moment(earliest))) moved.set(carrier, event);
  }
  const before = (earlier: CarrierEvent, later: CarrierEvent) => earlier.time && clockOf(later).length > 10
    ? moment(earlier) < moment(later) : moment(earlier, true) + DAY_MS < moment(later);
  for (const { event, carrier } of carried) {
    if (event.stage !== 'accepted' || !carrier || !clockOf(event)) continue;
    if ([...moved].some(([other, earlier]) => other !== carrier && before(earlier, event))) event.stage = 'in_transit';
  }
}

const BARE_DELIVERY = /^delivered[.!]?$/i;
const MOVEMENTS: ReadonlySet<string> = new Set(['accepted', 'in_transit', 'customs', 'out_for_delivery', 'failed_attempt']);
/**
 * The bare "Delivered" rows a scan of the reply moves the parcel past more
 * than a day later. ParcelsApp words a leg's end so: SEUR's on the day it
 * handed a parcel to BRT, five days before BRT's own scans of it, and
 * MailAmericas' "Delivered by Airline" before the destination's customs. A
 * day, as the clocks of a reply's networks can stand hours apart.
 */
function passedDeliveries(events: readonly CarrierEvent[]): CarrierEvent[] {
  const moves = events.filter((event) => event.stage_source !== 'none' && MOVEMENTS.has(event.stage ?? '')).map((event) => moment(event));
  return events.filter((event) => BARE_DELIVERY.test(event.description?.trim() ?? '') && moves.some((at) => at - moment(event, true) > DAY_MS));
}

/**
 * The steps dated by their day alone (`datedOnly`) that a timed scan of
 * another network shows at the same stage that day: BRT's "FOR DELIVERY" on a
 * parcel DPD Germany delivers, whose "Parcel out for delivery" ParcelsApp has
 * at its minute. With no time, the copy has no place among the day's scans. A
 * network's own scans are not copies of its step: USPS's "In Transit to Next
 * Facility" stays beside the day's facility scans.
 */
function timedTwins(carried: readonly { event: CarrierEvent; carrier: string }[], days: ReadonlySet<CarrierEvent>): CarrierEvent[] {
  return carried.filter(({ event: day, carrier }) => days.has(day) && day.stage_source !== 'none'
    && carried.some(({ event: other, carrier: network }) => network !== carrier && !days.has(other) && other.stage === day.stage
      && other.stage_source !== 'none' && clockOf(other).slice(0, 10) === day.local_time)).map(({ event }) => event);
}

// Russian Post's summary of a delivery, "Вручено 22 октября" (delivered on 22 October).
const RUSSIAN_POST_SUMMARY = /^вручено \d{1,2} \p{L}+[.!]?$/iu;

/**
 * ParcelsApp lists beside a Russian Post delivery its summary ("Вручено 22 октября"), at the
 * posting office, on the delivery office's wall clock with no carrier to place it: a delivery
 * in Abakan at 13:58 local, 06:58 UTC, came as 13:58. A summary in the delivered stage whose
 * clock is whole hours from a dated delivery's instant, to the second, from one to twelve as
 * Russia's clocks are, repeats that delivery and is left out.
 */
function dropRussianPostSummaries(events: CarrierEvent[], summaries: ReadonlySet<CarrierEvent>): void {
  const clock = (event: CarrierEvent) => Date.parse(event.time ?? (event.local_time ? `${event.local_time}Z` : ''));
  const repeats = [...summaries].filter((summary) => summary.stage === 'delivered' && events.some((scan) => !summaries.has(scan)
    && scan.stage === 'delivered' && scan.time && [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].includes(Math.abs(clock(summary) - clock(scan)) / 3_600_000)));
  for (const summary of repeats) events.splice(events.indexOf(summary), 1);
}

/** Leaves out the passed deliveries and the timed steps' untimed twins. */
function dropPassed(events: CarrierEvent[], carried: readonly { event: CarrierEvent; carrier: string }[], steps: ReadonlySet<CarrierEvent>): void {
  const dropped = new Set([...passedDeliveries(events), ...timedTwins(carried, steps)]);
  for (let index = events.length; index--;) if (dropped.has(events[index]!)) events.splice(index, 1);
}

/**
 * The country the parcel is bound for, as the reply names it, or for a reply
 * that does not, as an EcoScooting reference does ("CNPRT" for Portugal,
 * "CNESP" for Spain).
 */
function replyDestination(payload: Record<string, unknown>, number: string): string | null {
  const reference = /^CN(PRT|ESP)\d{20}$/.exec(number)?.[1];
  return statedDestination(payload) ?? (reference === 'PRT' ? 'PT' : reference === 'ESP' ? 'ES' : null);
}

/** The destination the reply names, which the result reports; a reference's country only dates scans. */
function statedDestination(payload: Record<string, unknown>): string | null {
  return countryCode(payload.destinationCode) ?? countryCode(payload.destination);
}

/**
 * The carrier ParcelsApp follows the parcel to and its number: a number it
 * names next (`next_tracking_ids`) that the own rule of the newest scan's
 * carrier claims, as DPD's number for a line's parcel DPD now carries. Only
 * one such pair names the partner. A number of a carrier with no later scan,
 * an earlier leg's for one, names none.
 */
function nextPartner(payload: Record<string, unknown>, events: readonly CarrierEvent[], names: ReadonlyMap<CarrierEvent, unknown>,
  number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const next = Array.isArray(payload.next_tracking_ids) ? payload.next_tracking_ids : [];
  const ids = next.filter((id): id is string => typeof id === 'string' && /^[A-Z0-9]{4,40}$/.test(id) && id !== number).slice(0, 10);
  const newest = events[0];
  if (!ids.length || !newest) return {};
  const pairs = new Map<string, { carrier: string; id: string }>();
  for (const event of events.filter((scan) => scan.time === newest.time && scan.local_time === newest.local_time)) {
    const name = names.get(event);
    if (typeof name !== 'string') continue;
    for (const id of ids) {
      const carrier = carrierIdFromName(name) ?? brandCarrierForNumber(name, id);
      if (carrier && (detectCarrierMatch(id).candidates as readonly string[]).includes(carrier)) pairs.set(`${carrier} ${id}`, { carrier, id });
    }
  }
  const [partner, ...others] = pairs.values();
  return partner && !others.length ? { delivery_carrier: partner.carrier, delivery_tracking_number: partner.id } : {};
}

/** The country the parcel comes from, as the reply names it, else the post that issued an S10 number. */
function replyOrigin(payload: Record<string, unknown>, number: string): string | null {
  return countryCode(payload.originCode) ?? countryCode(payload.origin) ?? countryCode(/^[A-Z]{2}\d{9}([A-Z]{2})$/.exec(number)?.[1]);
}

/**
 * ParcelsApp's own forecast, a row dated the expected day that the
 * destination's post names: no scan, and dated ahead of the read.
 */
const FORECAST = /^estimated delivery$/i;

// How far after the read a scan that only a guess dates may come out.
const GUESS_LEAD_MS = 60 * 60 * 1_000;

/**
 * Whether a scan with no place that only routing's zone or ParcelsApp's label
 * dates comes out more than an hour after the read. Its clock is another: a
 * Cainiao step on China's wall clock, read on the UTC of EcoScooting's catalog,
 * came out 7.6 hours ahead. It is held back until a read catches up with it.
 * A scan its carrier's clock or its place dates keeps its time, so that the
 * alert on scans dated ahead still shows a wrong clock there.
 */
function guessedAhead(event: CarrierEvent, location: string, zone: string | null, routing: string | null, readAt: number): boolean {
  return !location && (!zone || zone === routing) && typeof event.time === 'string' && Date.parse(event.time) > readAt + GUESS_LEAD_MS;
}

/**
 * GEODIS Poland's summary status before its first scan, which ParcelsApp
 * relays under "Pekaes" dated ten minutes after its own read on Warsaw's
 * clock, a new date each time it reads the tracker again: no scan.
 */
const PEKAES_SUMMARY = /^transferred data$/i;
const summaryRow = (name: unknown, status: string) => nameKey(name) === 'pekaes' && PEKAES_SUMMARY.test(status);

/**
 * ParcelsApp relays some carriers' labels twice over, TIPSA's as
 * "ENTREGADOENTREGADO". Only a label made of two identical halves is collapsed.
 */
function relayedLabel(value: unknown): string {
  const label = typeof value === 'string' ? value.trim() : '';
  const half = label.length / 2;
  return Number.isInteger(half) && label.slice(0, half) === label.slice(half) ? label.slice(0, half) : label;
}

/**
 * Mayi Yinfu's hand-over to the airport, "货物已交机场", which its own rows
 * translate as "The goods have been delivered to the airport". ParcelsApp has
 * relayed those rows as a bare "Delivered" placed in China, before the flight:
 * transit, not a delivery. The forwarder's rows of the delivery are the
 * delivering carrier's, worded in full and placed in the destination.
 */
function airportHandOver(carrier: string | undefined, status: string, location: string, destination: string | null): CarrierScan | undefined {
  return carrier === 'mayiyinfu' && destination !== 'CN' && /^delivered[.!]?$/i.test(status)
    && (countryCode(lastPlace(location)) === 'CN' || inChina(location))
    ? { stage: 'in_transit', wording: 'The goods have been delivered to the airport' } : undefined;
}

/**
 * The dates among a reply's that stand for none: 1 January at 00:00, more
 * than PLACEHOLDER_LEAD_DAYS before every other dated scan. ParcelsApp relays
 * the steps of DPD's progress bar and gives that date to those DPD leaves
 * undated, months before the parcel's scans. A real scan at that minute lies
 * among the scans of the turn of the year, and keeps its date.
 */
function placeholderDates(dates: readonly unknown[]): Set<string> {
  const walls = dates.map((date) => mislabeledWallTime(date));
  const newYear = (wall: string | null): wall is string => wall !== null && /^\d{4}-01-01T00:00:00(?:\.0+)?$/.test(wall);
  const others = walls.filter((wall): wall is string => wall !== null && !newYear(wall)).sort();
  if (!others.length) return new Set();
  const first = DateTime.fromISO(others[0]!, { zone: 'utc' });
  return new Set(walls.filter(newYear)
    .filter((wall) => first.diff(DateTime.fromISO(wall, { zone: 'utc' }), 'days').days > PLACEHOLDER_LEAD_DAYS));
}

/**
 * ParcelsApp's own lookup at the carrier failed: its page words these codes as the
 * carrier's website being down, busy, unreadable, under maintenance or refusing automated
 * tracking. The answer concerns that carrier, not the shipment or ParcelsApp's other
 * carriers, and the browser page would ask the same lookup.
 */
const CARRIER_FAILURES = new Set(['DOWN', 'BUSY', 'PARSER', 'CAPTCHA', 'MAINTENANCE']);

/**
 * On a parcel to the US, DHLink's feed holds a partner's scan twice: its own
 * row on China's clock and the partner's copy on the partner's US wall clock
 * (carriers/dhlink). ParcelsApp files both under DHLink, where the copy, read
 * on China's clock, would come hours early: it goes when a US reading of its
 * clock gives the instant of DHLink's row with the same wording, or when the
 * partner's own row, filed under the partner, has the same wording at the
 * same digits. The reply can hold the copy without DHLink's row.
 */
function dropDhlinkCopies(entries: { name: unknown; date: unknown; wording: string }[]): void {
  const fromDhlink = ({ name }: { name: unknown }) => typeof name === 'string' && carrierIdFromName(name) === 'dhlink';
  const dhlink = entries.filter(fromDhlink);
  const scanKey = (wall: string, wording: string) => `${wall}|${wording.replace(/\s+/g, ' ').trim().toLowerCase()}`;
  const partners = new Set(entries.filter((entry) => !fromDhlink(entry))
    .map(({ date, wording }) => scanKey(mislabeledWallTime(date) ?? '', wording)));
  const copies = new Set(dhlink.filter((copy) => {
    const wall = mislabeledWallTime(copy.date);
    return wall && (partners.has(scanKey(wall, copy.wording)) || dhlink.some((own) => {
      const time = own !== copy && own.wording === copy.wording ? mislabeledLocalTime(own.date, DHLINK_RECORD_ZONE) : null;
      return time && usClockCopy(wall, time.timestamp);
    }));
  }));
  if (copies.size) entries.splice(0, entries.length, ...entries.filter((entry) => !copies.has(entry)));
}

function parseHistory(payload: unknown, trackingNumber: string, timezone: string | null = null, readAt = Date.now()): CarrierResult {
  if (isRecord(payload) && payload.error === 'RELOAD') throw new ChallengeError(SOURCE);
  if (isRecord(payload) && (payload.error === 'NO_DATA' || payload.error === 'NO_TRACKER')) {
    throw new NoHistoryError(SOURCE, 'ParcelsApp has no usable shipment history');
  }
  if (isRecord(payload) && typeof payload.error === 'string' && CARRIER_FAILURES.has(payload.error)) {
    throw new IndeterminateError(SOURCE, `ParcelsApp's carrier lookup failed: ${payload.error}`, { reason: 'carrier_unavailable' });
  }
  if (!isRecord(payload) || payload.error || !Array.isArray(payload.states) || payload.states.length > MAX_EVENTS) {
    // An error code the adapter does not know is named, to tell drift from a new answer.
    const code = isRecord(payload) && typeof payload.error === 'string' && /^[A-Z][A-Z_]{0,39}$/.test(payload.error) ? `: ${payload.error}` : '';
    throw new SchemaError(SOURCE, `ParcelsApp lookup unavailable${code}`);
  }
  const number = numberOf(trackingNumber);
  const events: CarrierEvent[] = [];
  const carried: { event: CarrierEvent; carrier: string }[] = [];
  const scans: { event: CarrierEvent; scan: CarrierScan }[] = [];
  const scanCarriers = new Set<unknown>();
  const names = new Map<CarrierEvent, unknown>();
  const summaries = new Set<CarrierEvent>();
  let undated = 0;
  // The reply is in North America when a scan certainly is, or when a scan
  // names a state or province ("Atlanta, GA") and none names another country.
  const kinds = payload.states.flatMap((raw: unknown) => {
    const location = isRecord(raw) ? scanLocation(stateCarrierName(payload, raw), raw.location) : '';
    return location ? [placeKind(location)] : [];
  });
  const inNorthAmerica = kinds.includes('certain') || (kinds.includes('region') && !kinds.includes('abroad'));
  const destination = replyDestination(payload, number);
  const origin = countryCode(payload.originCode) ?? countryCode(payload.origin);
  const entries: (ReturnType<typeof readState> & { raw: Record<string, unknown>; scan: CarrierScan | undefined; wording: string })[] = [];
  const placeholders = placeholderDates(payload.states.flatMap((raw: unknown) => isRecord(raw) && !raw.require_fields && !raw.error ? [raw.date] : []));
  for (const raw of payload.states) {
    if (!isRecord(raw)) throw new SchemaError(SOURCE, 'ParcelsApp returned an invalid event');
    if (raw.require_fields || raw.error) continue;
    // A state can come without a date (an Asendia Spain leg), or with a
    // placeholder for one. It has no place among the dated scans, so it is
    // counted instead of read as the latest.
    if (raw.date == null || raw.date === '' || placeholders.has(mislabeledWallTime(raw.date) ?? '')) {
      undated++;
      continue;
    }
    const status = relayedLabel(raw.status);
    if (FORECAST.test(status) || summaryRow(stateCarrierName(payload, raw), status)) continue;
    const state = readState(payload, raw, status, timezone, number, inNorthAmerica, destination, origin);
    const carrier = typeof state.name === 'string' ? carrierIdFromName(state.name) : undefined;
    const scan = carrierScan(carrier, status) ?? airportHandOver(carrier, status, state.location, destination);
    entries.push({ ...state, raw, scan, wording: scan?.wording ?? status });
  }
  if (destination === 'US') dropDhlinkCopies(entries);
  // Another carrier's copy of a scan placed in its state or province (Cainiao
  // relaying UniUni's "Delivered" at the same minute, with no place) takes
  // that scan's zone, so the two stay one scan. A copy of a GOFO scan with an
  // offset of its own writes the same digits under a UTC label (YTO's, Cirro's
  // and EQuick's of GOFO France's), and takes that offset. A wall-clock scan
  // with no place copies any other carrier's placed scan this way.
  const copyKey = ({ date, wording }: typeof entries[number], wall = mislabeledWallTime(date)) => {
    const text = wall ? localEvent(date, wording)?.description : undefined;
    return wall && text ? `${wall}|${text}` : '';
  };
  const offsetClocks = entries.filter((entry) => entry.offset).map((entry) => [
    copyKey(entry, DateTime.fromISO(String(entry.date).trim(), { setZone: true }).toISO({ includeOffset: false })), `UTC${entry.offset}`] as const);
  const localClocks = new Map([
    ...entries.filter((entry) => entry.local).map((entry) => [copyKey(entry), entry.zone!] as const), ...offsetClocks,
  ].filter(([key]) => key));
  // Two placed scans with the same key on different clocks place no copy.
  const placedClocks = new Map<string, string>();
  for (const [key, zone] of [...entries.flatMap((entry) => entry.placed ? [[copyKey(entry), entry.placed] as const] : []), ...offsetClocks]) {
    if (key) placedClocks.set(key, placedClocks.has(key) && placedClocks.get(key) !== zone ? '' : zone);
  }
  // A placed scan written to the minute alone is copied by one that keeps its seconds: YFH's
  // scans come at :00 and Cainiao's copies of them, with no place, at the second. Cainiao's
  // own tracker gives those copies GMT+08:00, the clock YFH's are read on.
  const minuteKey = (entry: typeof entries[number]) => {
    const wall = mislabeledWallTime(entry.date);
    return wall ? copyKey(entry, wall.slice(0, 16)) : '';
  };
  const minuteClocks = new Map<string, string>();
  for (const entry of entries) {
    const key = entry.placed && /:00(?:\.0+)?$/.test(mislabeledWallTime(entry.date) ?? '') ? minuteKey(entry) : '';
    if (key) minuteClocks.set(key, minuteClocks.has(key) && minuteClocks.get(key) !== entry.placed ? '' : entry.placed!);
  }
  const zones = wallClockZones(entries.map((entry) => ({ ...entry,
    zone: entry.wallClock ? entry.zone : (localClocks.size && !entry.local && !entry.offset ? localClocks.get(copyKey(entry)) : undefined) ?? entry.zone,
    copy: entry.wallClock && !entry.zone ? placedClocks.get(copyKey(entry)) || minuteClocks.get(minuteKey(entry)) || undefined : undefined })));
  placeCopies(entries).forEach((zone, index) => { if (zone) zones[index] = { zone, step: 'copy' }; });
  copiedNetworkZones(entries.map((entry, index) => ({ name: entry.name, key: copyKey(entry), zone: zones[index]!.zone,
    fixed: Boolean(entry.offset) || relaysFacilityClock(entry.name), location: entry.location })))
    .forEach((zone, index) => { if (zone) zones[index] = { zone, step: 'copy' }; });
  chinaPostTwinZones(entries, zones.map(({ zone }) => zone), destination)
    .forEach((zone, index) => { if (zone) zones[index] = { zone, step: 'copy' }; });
  const dayOnly = dayOnlyNetworks(entries);
  const steps = new Set<CarrierEvent>();
  const latest = new LatestScan(SOURCE);
  for (const [index, entry] of entries.entries()) {
    const { raw, name, scan, date } = entry;
    const { zone } = zones[index]!;
    // A DHL Express scan whose facility the rule cannot place is a wall clock
    // with no instant, and so is a UPS or FedEx scan with no location that
    // nothing places. A scan at a US military post office, of a network no
    // table knows (`unknownNetwork`), of a bare brand on local clocks
    // (`localClockBrand`), of iMile for a destination of several zones, of
    // Croatia Post without an office or at an office abroad that its code does not place, of UPU at
    // an office in the destination (`destinationOffice`) or of a line on its
    // place's clock that its place does not date (`PLACE_CLOCK_LINES`) keeps
    // its wall clock as its local time. Any other
    // scan with no zone keeps ParcelsApp's label.
    const facility = !zone && relaysFacilityClock(name);
    const unplaced = facility || (!zone && !entry.location && UNLOCATED_LOCAL_CLOCKS.has(nameKey(name)));
    const localOnly = !zone && !unplaced && entry.wallOnly;
    // A step or network its carrier dates by the day alone keeps the day (`datedOnly`, `dayOnlyNetworks`).
    const step = datedOnly(name, relayedLabel(raw.status), date);
    const day = step ?? networkDay(dayOnly, name, date);
    const parsed = day ? dayEvent(day, entry.wording)
      : localEvent((zone ? mislabeledLocalTime(date, zone)?.iso : unplaced || localOnly ? mislabeledWallTime(date) : undefined) ?? date, entry.wording);
    if (parsed) latest.see(mislabeledWallTime(date) ?? '', facility);
    // Nor has an offset-less date that no zone resolves: a wall time, not an instant.
    if (parsed && !parsed.time && !day && !localOnly) {
      undated++;
      continue;
    }
    if (parsed && guessedAhead(parsed, entry.location, zone, timezone, readAt)) continue;
    if (parsed) {
      // Some Chronopost rows put the service label in the location field.
      const location = reportedPlace(raw.location);
      if (location && !/^Type de livraison\s*:/i.test(location)) parsed.location = location;
      events.push(parsed);
      carried.push({ event: parsed, carrier: nameKey(name) });
      scanCarriers.add(name);
      names.set(parsed, name);
      if (RUSSIAN_POST_SUMMARY.test(relayedLabel(raw.status))) summaries.add(parsed);
      if (step) steps.add(parsed);
    }
    if (parsed && scan) scans.push({ event: Object.assign(parsed, { stage: scan.stage, stage_source: 'carrier_map' }), scan });
  }
  markReturnLeg(scans);
  markLaterReceipts(scans);
  markHandovers(carried);
  dropPassed(events, carried, steps);
  dropRussianPostSummaries(events, summaries);
  latest.check();
  if (!events.length) {
    const gates = payload.states.filter((raw: unknown): raw is Record<string, unknown> => isRecord(raw)
      && Array.isArray(raw.require_fields) && raw.require_fields.some((field: unknown) => isRecord(field) && field.name === 'zipcode'));
    if (gates.length) {
      // A gate names the carrier that asks for the postcode, as a scan does. It is
      // given only when every gate names the same one and it maps to the catalog.
      const [name, ...others] = gates.map((gate) => stateCarrierName(payload, gate));
      const carrier = typeof name === 'string' && others.every((other) => other === name)
        ? universalCarrierHints([name], number).discovered_carrier : undefined;
      throw new InputRequiredError(SOURCE, 'postcode', 'ParcelsApp requires a valid delivery postcode or further recipient information',
        carrier ? { carrier } : undefined);
    }
    // An empty history is the NO_DATA answer; states that don't parse are not an answer.
    if (!payload.states.length) throw new NoHistoryError(SOURCE, 'ParcelsApp has no usable shipment history');
    throw new IndeterminateError(SOURCE, 'No usable tracking events');
  }
  // The carriers ParcelsApp aggregated for this number ("DPD Group"), as
  // discovery hints; routing confirms one with its own adapter before adopting it.
  // ParcelsApp lists its link to another tracker, among `next_tracking_ids`,
  // as a carrier and a service named "url": no carrier's name.
  const services = Array.isArray(payload.services) ? payload.services : [];
  const carriers: unknown[] = Array.isArray(payload.carriers) ? payload.carriers : [];
  const hints = universalCarrierHints([
    ...carriers, ...services.map((service: unknown) => isRecord(service) ? service.name : undefined),
  ].filter((name) => !(typeof name === 'string' && /^url$/i.test(name.trim()))).slice(0, 20), number);
  // The list also names carriers asked without an answer. When every scan
  // names the same carrier, that carrier is the hint.
  const discovered = hints.discovered_carrier
    ?? (scanCarriers.size === 1 ? universalCarrierHints([...scanCarriers], number).discovered_carrier : undefined);
  const stated = statedDestination(payload);
  const answer = result(events, SOURCE);
  return { ...answer, ...(undated ? { undated_event_count: undated } : {}),
    ...hints, ...(discovered ? { discovered_carrier: discovered } : {}), ...(stated ? { destination_country: stated } : {}),
    ...nextPartner(payload, answer.events ?? [], names, number) };
}

/** Whether a direct request failed by reaching its own cap rather than by a network failure. */
function timedOut(error: unknown): boolean {
  for (let cause = error, depth = 0; cause && depth < 8; cause = (cause as { cause?: unknown }).cause, depth++) {
    if (cause instanceof DOMException && cause.name === 'TimeoutError') return true;
  }
  return false;
}

function browserCanRecover(error: unknown): boolean {
  // A slow uncached lookup needs more time on the same API. It has already
  // had one direct retry; a new browser lookup would repeat the work again.
  if (error instanceof UpstreamNetworkError) return false;
  // A second lookup cannot repair missing input, rate limiting or an outage.
  if (error instanceof UpstreamHttpError && (error.status === 429 || error.status >= 500)) return false;
  // The browser tier reads a larger reply than the direct POST's cap.
  if (error instanceof CarrierError && error.reason === 'response_too_large') return true;
  const kind = carrierErrorKind(error);
  return kind === null || kind === 'challenge' || kind === 'transport' || kind === 'schema';
}

export function parseParcelsAppHtml(html: string, trackingNumber: string, timezone: string | null = null, readAt = Date.now()): CarrierResult {
  if (!parcelsIdentity(html, numberOf(trackingNumber))) throw new SchemaError(SOURCE, 'ParcelsApp shipment identity missing');
  const $ = load(html);
  const nodes = $('.tracking-info .parcel .events > .event');
  if (nodes.length > MAX_EVENTS) throw new SchemaError(SOURCE, 'ParcelsApp returned too many events');
  const events: CarrierEvent[] = [];
  // Each scan names its carrier ("DPD Group") under its wording, as the JSON
  // reply's `carriers` index does: the same zone rules then give the same
  // instants, and so the same event ids, whichever tier answered.
  const carriers: string[] = [];
  const carried: { event: CarrierEvent; carrier: string }[] = [];
  const scans: { event: CarrierEvent; scan: CarrierScan }[] = [];
  const rows: { name: string; description: string; state: ReturnType<typeof readState>; scan: CarrierScan | undefined }[] = [];
  let undated = 0;
  const latest = new LatestScan(SOURCE);
  nodes.each((_, node) => {
    const row = $(node);
    if (row.find('input, select, form').length) return;
    const description = relayedLabel(row.find('.event-content > strong').first().text());
    if (isNotice(description) || FORECAST.test(description)) return;
    const date = row.find('.event-time > strong').text().trim();
    const time = row.find('.event-time > span').text().trim();
    // Notice rows ("No information about your package...") render a date with
    // an empty time. Skip them instead of failing the whole history.
    if (!time) return;
    const name = row.find('.event-content .carrier').first().text().replace(/\s+/g, ' ').trim();
    if (name && !carriers.includes(name)) carriers.push(name);
    if (summaryRow(name, description)) return;
    // The page prints a state without a date as "aN Inv NaN" at "aN:aN":
    // counted, as in the JSON reply.
    if (date.includes('NaN')) {
      undated++;
      return;
    }
    // The English web app renders the UTC digits of its API, which are the
    // scan's local clock.
    const labeled = DateTime.fromFormat(`${date} ${time}`, 'dd LLL yyyy HH:mm', { locale: 'en', zone: 'UTC' });
    if (!labeled.isValid) throw new SchemaError(SOURCE, 'ParcelsApp returned an invalid event date');
    const state = readState({ carriers }, { date: labeled.toISO(), ...(name ? { carrier: carriers.indexOf(name) } : {}) },
      description, timezone, numberOf(trackingNumber), false, replyDestination({}, numberOf(trackingNumber)));
    const scan = carrierScan(name ? carrierIdFromName(name) : undefined, description);
    rows.push({ name, description, state, scan });
  });
  // A placeholder date is counted, as in the JSON reply.
  const placeholders = placeholderDates(rows.map(({ state }) => state.date));
  const placeholder = ({ state }: typeof rows[number]) => placeholders.has(mislabeledWallTime(state.date) ?? '');
  undated += rows.filter(placeholder).length;
  rows.splice(0, rows.length, ...rows.filter((row) => !placeholder(row)));
  // The page prints no location, so no DHL Express scan has a facility to
  // read its clock in, and no other wall clock a place, a copy to take or a
  // placed scan of its network to borrow from: routing's zone, its known
  // clock or its label, else the clock its copies show, as in the JSON reply.
  const zones = rows.map(({ state }) => state.zone ?? state.fallback ?? state.known);
  copiedNetworkZones(rows.map(({ name, description, state, scan }, index) => {
    const wall = mislabeledWallTime(state.date);
    const text = wall ? localEvent(state.date, scan?.wording ?? description)?.description : undefined;
    return { name, key: wall && text ? `${wall}|${text}` : '', zone: zones[index]!,
      fixed: Boolean(state.offset) || relaysFacilityClock(name), location: '' };
  })).forEach((zone, index) => { if (zone) zones[index] = zone; });
  const dayOnly = dayOnlyNetworks(rows.map(({ name, state }) => ({ name, date: state.date, offset: state.offset })), true);
  const steps = new Set<CarrierEvent>();
  for (const [index, { name, description, state, scan }] of rows.entries()) {
    const zone = zones[index]!;
    const unplaced = !zone && relaysFacilityClock(name);
    latest.see(mislabeledWallTime(state.date) ?? '', unplaced);
    if (unplaced) {
      undated++;
      continue;
    }
    const step = datedOnly(name, description, state.date);
    const day = step ?? networkDay(dayOnly, name, state.date);
    // A scan whose label nothing vouches for keeps its wall clock, as in the JSON reply.
    const wall = !zone && state.wallOnly ? mislabeledWallTime(state.date) : null;
    const parsed = day ? dayEvent(day, scan?.wording ?? description)
      : wall ? localEvent(wall, scan?.wording ?? description)
        : event((zone ? mislabeledLocalTime(state.date, zone)?.iso : undefined) ?? state.date, scan?.wording ?? description);
    if (parsed && guessedAhead(parsed, '', zone, timezone, readAt)) continue;
    if (parsed) events.push(parsed);
    if (parsed) carried.push({ event: parsed, carrier: nameKey(name) });
    if (parsed && step) steps.add(parsed);
    if (parsed && scan) scans.push({ event: Object.assign(parsed, { stage: scan.stage, stage_source: 'carrier_map' }), scan });
  }
  markReturnLeg(scans);
  markLaterReceipts(scans);
  markHandovers(carried);
  dropPassed(events, carried, steps);
  latest.check();
  return { ...result(events, SOURCE), ...(undated ? { undated_event_count: undated } : {}),
    ...universalCarrierHints(carriers.slice(0, 20), numberOf(trackingNumber)) };
}

export interface ParcelsAppOptions {
  trawl?: TrawlClient | null;
  fetcher?: typeof fetch;
  recorder?: StepRecorder;
  timeoutMs?: number;
  userAgent?: string;
  /** Null runs only the existing browser capture tier. */
  httpClient?: ParcelsAppHttpClient | null;
}

export class ParcelsAppTracker {
  private readonly http: ParcelsAppHttpClient | null;

  constructor(readonly options: ParcelsAppOptions = {}) {
    this.http = options.httpClient === undefined ? new ParcelsAppHttpClient(options.fetcher, options.userAgent) : options.httpClient;
  }

  async fetch(trackingNumber: string, budgetMs = this.options.timeoutMs ?? PARCELSAPP_BUDGET_MS, postcode?: string | null, timezone: string | null = null, signal?: AbortSignal): Promise<CarrierResult> {
    const number = numberOf(trackingNumber);
    if (!Number.isFinite(budgetMs) || budgetMs < 1) throw new TypeError('ParcelsApp timeout must be positive');
    const deadline = performance.now() + budgetMs;
    const request = async (remainingMs: number, signal: AbortSignal): Promise<CarrierResult> => {
      const payload = await this.http!.fetch(number, Math.max(1, Math.min(DIRECT_BUDGET_MS, Math.floor(remainingMs))), postcode, signal);
      // This endpoint returns one shipment per POST, synchronously, with no
      // shared session or polling handle. Each retry keeps its own request
      // binding. Numberless browser captures never get this exemption.
      if (isRecord(payload) && payload.correctId && payload.correctId !== number) {
        throw new SchemaError(SOURCE, 'ParcelsApp returned an unverified tracking alias');
      }
      return { ...parseHistory(payload, number, timezone), tracking_source: 'structured-web-response' };
    };
    return runSteps({ carrier: SOURCE, budgetMs, signal, recorder: this.options.recorder }, [{
      id: 'direct',
      enabled: this.http !== null,
      run: ({ remainingMs, signal }) => request(remainingMs, signal),
    }, {
      id: 'retry',
      enabled: this.http !== null,
      // Retry a replayable network failure with the same input, within the
      // original lookup budget. A request ParcelsApp held to its cap is not
      // retried: the one sent two seconds later waited out the rest of the
      // budget as well, for every Royal Mail parcel tried from production
      // (2026-10-16), while a cold lookup answered within 16 s.
      recovers: (error) => error instanceof UpstreamNetworkError && !timedOut(error) && deadline - performance.now() > RETRY_DELAY_MS + 1,
      run: async ({ signal }) => {
        await timers.setTimeout(RETRY_DELAY_MS, undefined, { signal });
        signal.throwIfAborted();
        return request(deadline - performance.now(), signal);
      },
    }, {
      id: 'trawl',
      enabled: this.options.trawl != null || this.http === null,
      recovers: browserCanRecover,
      run: async ({ remainingMs, signal }) => {
        const capture: CaptureSpec = {
          source: SOURCE, url: `https://parcelsapp.com/en/tracking/${number}`, apiUrl: PARCELSAPP_API,
          budgetMs: remainingMs, fetcher: this.options.fetcher, signal,
        };
        const page = await loadCapture(this.options.trawl ?? null, capture);
        let noData = false;
        for (const body of capturedBodies(page, capture)) {
          let payload: unknown;
          try {
            payload = JSON.parse(body);
            return parseParcelsAppResponse(payload, number, page.html, timezone);
          } catch {
            // Polling replies, unrelated numbers and demo shipments are not history.
            noData ||= isRecord(payload) && (payload.error === 'NO_DATA' || payload.error === 'NO_TRACKER');
          }
        }
        // For a number it has no data for, ParcelsApp renders its empty view, which
        // leaves out the number, so no reply can be bound to it. With the page's own
        // NO_DATA that is the direct step's inconclusive answer; without, inconclusive.
        if (emptyView(page.html)) {
          throw noData ? new NoHistoryError(SOURCE, 'ParcelsApp has no usable shipment history') : captureFailure(page, capture);
        }
        // The rendered page carries the same history when no body was readable.
        return parseParcelsAppHtml(page.html, number, timezone);
      },
    }]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ParcelsAppTracker({
    trawl: environment.trawl, fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent,
  });
  return {
    id: SOURCE,
    steps: ['direct', 'retry', 'trawl'],
    track: (input, context) => tracker.fetch(input.number, context?.budgetMs, input.postcode, input.timezone ?? null, context?.signal),
  };
};
