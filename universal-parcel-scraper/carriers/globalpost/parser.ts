import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { DateTime } from 'luxon';
import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { USPS_ROUTING_BARCODE, uspsPackageIdentifier } from '../../core/detection/usps.js';
import {
  ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError, TransportError,
} from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, countryTimeZone, firstOccurrence, regionHasTown, usStateTimeZone } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { globalpostStage } from './status.js';

export const PROVIDER = 'GlobalPost';
// A long history's page is about 150 kB, most of it the site's own markup.
export const GLOBALPOST_MAX_BYTES = 2_000_000;
// `globalpost-1`: GP, four letters for the service, ten digits and the origin.
// Older labels carry SDC and fifteen digits.
const NUMBER = /^(?:GP[A-Z]{4}\d{10}(?:US|GB)|SDC\d{15})$/;
// A day's heading: "Thursday, Aug 6, 2026".
const DAY = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), ([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// A scan's clock: "1:43 pm".
const CLOCK = /^(\d{1,2}):(\d{2}) ([ap]m)$/i;
// The placeholder the page gives a scan without a place.
const NO_PLACE = /^(?:not available|n\/a|-*)$/i;
// A firewall's, CDN's or bot check's page in place of the tracker's, which can come back with HTTP 200.
const BLOCKED = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied)|g-recaptcha|h-captcha/i;
const HOSTS = new Set(['www.goglobalpost.com', 'goglobalpost.com']);
const FACILITY_SCAN = /^(?:Arrived at|Departed) GlobalPost Facility$/;
// A GlobalPost facility as ePost Global's processing centers name it, by town and
// state ("Itasca IL"); the facilities Asendia runs come as "Town, ST".
const CENTER = /^[A-Za-z][A-Za-z .'-]{0,60} ([A-Z]{2})$/;
// A town as USPS writes it, "TOWN,ST".
const USPS_TOWN = /^([A-Z][A-Z .'-]*),([A-Z]{2})$/;
// USPS names a facility by its town, its state and its kind, "TOWN ST DISTRIBUTION
// CENTER" or "ISC TOWN ST (USPS)", which the page cuts short.
const USPS_KINDS = ['DISTRIBUTION CENTER', 'INTERNATIONAL DISTRIBUTION CENTER', 'NETWORK DISTRIBUTION CENTER',
  'REGIONAL DISTRIBUTION CENTER', 'PROCESSING AND DISTRIBUTION CENTER', 'LOGISTICS AND DISTRIBUTION CENTER', '(USPS)'];
// States whose places keep different clocks, so a state does not settle a clock's zone.
const SPLIT_STATES = new Set(['AK', 'AZ', 'FL', 'ID', 'IN', 'KS', 'KY', 'MI', 'ND', 'NE', 'NV', 'OR', 'SD', 'TN', 'TX']);
// The delivery abroad and a return, which end the parcel's way out of the United States.
const DELIVERY_STAGES: ReadonlySet<string> = new Set(['out_for_delivery', 'ready_for_pickup', 'failed_attempt', 'exception', 'delivered', 'returned']);
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A GlobalPost number; anything else is not one GlobalPost issues. */
export function normalizeGlobalpostNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) {
    throw new InvalidInputError(PROVIDER, 'GlobalPost numbers are GP, four letters, ten digits and US or GB, or SDC and fifteen digits');
  }
  return number;
}

/**
 * Where the tracking page sends a number it holds nothing for: its search page
 * with the number and `status=not_found`, which shows "We couldn't locate any
 * details for the tracking number you entered". Any other redirect is a moved
 * page or a lookup that did not finish.
 */
export function readGlobalpostRedirect(location: string | null, raw: string, html?: string): never {
  const number = normalizeGlobalpostNumber(raw);
  if (html && BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'GlobalPost answered with a block page');
  let target: URL | undefined;
  try {
    target = location ? new URL(location, 'https://www.goglobalpost.com/') : undefined;
  } catch {
    target = undefined;
  }
  if (!target || !HOSTS.has(target.hostname) || target.pathname !== '/tracking/') {
    throw new TransportError(PROVIDER, 'GlobalPost redirected its tracking page');
  }
  if (normalizeTrackingNumber(target.searchParams.get('t') ?? '').toUpperCase() !== number) {
    throw new IndeterminateError(PROVIDER, 'GlobalPost answered for another number');
  }
  if (target.searchParams.get('status') === 'not_found') throw new NotFoundError(PROVIDER);
  throw new IndeterminateError(PROVIDER, 'GlobalPost did not complete the lookup');
}

/** A day's heading as a calendar day; its weekday must agree with the date. */
function dayOf(text: string): string {
  const match = DAY.exec(text);
  const month = match ? MONTHS.indexOf(match[2]!) + 1 : 0;
  const day = match && month ? calendarDay(Number(match[4]), month, Number(match[3])) : null;
  if (!day || DateTime.fromISO(day, { zone: 'utc' }).setLocale('en-US').weekdayLong !== match![1]) {
    throw new SchemaError(PROVIDER, 'GlobalPost returned an invalid scan day');
  }
  return day;
}

/** A scan's twelve-hour clock as a 24-hour time to the minute. */
function clockOf(text: string): string {
  const match = CLOCK.exec(text);
  const hour = Number(match?.[1]);
  const minute = Number(match?.[2]);
  if (!match || hour < 1 || hour > 12 || minute > 59) throw new SchemaError(PROVIDER, 'GlobalPost returned an invalid scan time');
  const hours = (hour % 12) + (match[3]!.toLowerCase() === 'pm' ? 12 : 0);
  return `${String(hours).padStart(2, '0')}:${match[2]}:00`;
}

/**
 * A scan's place up to its first word holding a digit, where the page puts
 * the shipper's ZIP code or a facility's cut-off one ("Sampleburg, IL 6000").
 */
function placeOf(raw: string): string {
  const words: string[] = [];
  for (const word of raw.split(' ')) {
    if (/\d/.test(word)) break;
    words.push(word);
  }
  const place = words.join(' ').replace(/[\s,]+$/, '');
  return NO_PLACE.test(place) ? '' : place;
}

/** The one element of a row under this selector. */
function only(row: Cheerio<Element>, selector: string): Cheerio<Element> {
  const found = row.find(selector);
  if (found.length !== 1) throw new SchemaError(PROVIDER, 'GlobalPost returned an invalid scan row');
  return found;
}

/**
 * The history, newest first as the page lists it: a heading for each day, then
 * that day's scans with their clock, wording and place. Repeated scans are kept
 * once. The page orders scans by wall clocks of several zones, so its order
 * stands.
 */
function scans($: CheerioAPI, container: Cheerio<Element>): CarrierEvent[] {
  const list = container.find('.single-view-tracking-details-container');
  if (list.length !== 1) throw new SchemaError(PROVIDER, 'GlobalPost returned a shipment without its history');
  // Each scan is a timeline row; the current page wraps each in a timestamp
  // wrapper, an older one listed them bare.
  const nodes = list.find('.trackingEvents-timestamp-header, .trackingEvents-timeline-row').toArray();
  if (nodes.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'GlobalPost returned an oversized history');
  let day: string | undefined;
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const node of nodes) {
    const row = $(node);
    if (row.hasClass('trackingEvents-timestamp-header')) {
      day = dayOf(clean(row.text(), 60));
      continue;
    }
    if (!day) throw new SchemaError(PROVIDER, 'GlobalPost returned a scan without its day');
    const local = `${day}T${clockOf(clean(only(row, '.trackingEvents-content.timestamp').text(), 20))}`;
    const description = clean(only(row, '.eventDescription').text(), 200);
    if (!description) throw new SchemaError(PROVIDER, 'GlobalPost returned a scan without wording');
    const city = row.find('.city');
    if (city.length > 1) throw new SchemaError(PROVIDER, 'GlobalPost returned an invalid scan row');
    const location = placeOf(clean(city.text(), 120));
    const key = JSON.stringify([local, description, location]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = globalpostStage(description);
    events.push({
      local_time: local,
      description,
      ...(location ? { location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    });
  }
  // Day headings without scans are a changed page, not an empty history.
  if (!events.length && nodes.length) throw new SchemaError(PROVIDER, 'GlobalPost returned days without scans');
  return events;
}

/** The value of the `To:` or `From:` field. */
function routeField($: CheerioAPI, container: Cheerio<Element>, label: string): string {
  const section = container.find('.eta-to-from-out .tracking-section')
    .filter((_, element) => clean($(element).find('.tracking-label').text(), 20) === label);
  return section.length === 1 ? clean(section.find('.tracking-data').text(), 160) : '';
}

/** A town as a scan's place or the route writes it, for comparing the two. */
function townOf(text: string): string {
  return text.split(',')[0]!.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** The `To:` or `From:` field as a town and a country, "Town, Region, CC". */
function placeOfRoute(field: string): { town: string; country: string } | undefined {
  const parts = field.split(',').map((part) => part.trim());
  const country = parts.at(-1) ?? '';
  const town = parts.length > 1 ? townOf(parts[0]!) : '';
  return town && /^[A-Z]{2}$/.test(country) ? { town, country } : undefined;
}

/**
 * A parcel sent back is delivered to its sender, and the page still says
 * "Delivered", with the recipient's town as the delivery's place in its
 * heading. Only the scan's own place tells: the sender's town, in another
 * country than the recipient's. Such a delivery is the return's.
 */
function returnsHome(events: CarrierEvent[], from: string, to: string): CarrierEvent[] {
  const sender = placeOfRoute(from);
  const recipient = placeOfRoute(to);
  if (!sender || !recipient || sender.country === recipient.country || sender.town === recipient.town) return events;
  return events.map((event) => event.stage === 'delivered' && event.location && townOf(event.location) === sender.town
    ? { ...event, stage: 'returned' }
    : event);
}

/** The index of the oldest scan that passes the test, or -1. */
function oldest(events: CarrierEvent[], test: (event: CarrierEvent) => boolean): number {
  for (let index = events.length - 1; index >= 0; index -= 1) if (test(events[index]!)) return index;
  return -1;
}

/** The clock of an ePost Global processing center: its state's. */
function centerZone(place: string): string | null {
  const state = CENTER.exec(place)?.[1];
  return state && !SPLIT_STATES.has(state) ? usStateTimeZone(state) : null;
}

/** The town and state of a place USPS writes as a town. */
function uspsTown(place: string): { town: string; state: string } | undefined {
  const match = USPS_TOWN.exec(place);
  return match ? { town: match[1]!, state: match[2]! } : undefined;
}

/** The town and state of a USPS facility's name, cut short or not. */
function uspsFacility(place: string): { town: string; state: string } | undefined {
  const name = place.replace(/^ISC /, '');
  for (const match of name.matchAll(/ ([A-Z]{2}) /g)) {
    const town = name.slice(0, match.index);
    const kind = name.slice(match.index + 4);
    if (/^[A-Z][A-Z .'-]*$/.test(town) && USPS_KINDS.some((full) => full.startsWith(kind))) return { town, state: match[1]! };
  }
  return undefined;
}

/**
 * The clock of a USPS scan's place: its state's, when the state keeps one
 * clock. A code that also names a single-clock country (IL is Israel's too)
 * needs a town of the state.
 */
function uspsZone(place: { town: string; state: string } | undefined): string | null {
  if (!place || SPLIT_STATES.has(place.state) || (countryTimeZone(place.state) && !regionHasTown(place.state, place.town))) return null;
  return usStateTimeZone(place.state);
}

/** A wall clock's instant in the zone; a clock the zone skips, or midnight sharp, where the page puts a day without its time, has none. */
function instant(local: string, zone: string): string | null {
  if (local.endsWith('T00:00:00')) return null;
  const placed = firstOccurrence(DateTime.fromISO(local, { zone }));
  return placed.isValid && placed.toFormat("yyyy-MM-dd'T'HH:mm:ss") === local ? placed.toISO({ suppressMilliseconds: true }) : null;
}

/**
 * A parcel sent from the United States, read on the clocks its scans' places
 * keep on its way out. A GlobalPost facility's scans at ePost Global's
 * processing centers are on the center's clock, as ePost Global's tracker
 * shows the same scans. USPS's scans are on their facility's clock: a scan at
 * a facility USPS names, anywhere on the way out, and one at a town written as
 * USPS writes it, before GlobalPost has the parcel, since posts abroad write
 * their towns the same way. The registration, Asendia's facilities, the
 * delivery abroad, a return and every other scan keep their wall clocks.
 */
function dated(events: CarrierEvent[], fromUnitedStates: boolean): CarrierEvent[] {
  if (!fromUnitedStates) return events;
  // The way out ends at the oldest scan of the delivery abroad, of the destination country or of a return.
  const out = oldest(events, (event) => DELIVERY_STAGES.has(event.stage ?? '') || /country|return/i.test(event.description!));
  const facility = oldest(events, (event) => FACILITY_SCAN.test(event.description!));
  // Without a facility's scan, the parcel has reached GlobalPost by the time customs or a post abroad scans it.
  const received = facility >= 0 ? facility : Math.max(out, oldest(events, (event) => event.stage === 'customs'));
  return events.map(({ local_time, ...event }, index): CarrierEvent => {
    const place = index > out && event.stage !== 'registered' ? event.location ?? '' : '';
    const zone = !place ? null : FACILITY_SCAN.test(event.description!) ? centerZone(place)
      : uspsZone(uspsFacility(place) ?? (index > received ? uspsTown(place) : undefined));
    const time = zone ? instant(String(local_time), zone) : null;
    return time ? { time, ...event } : { local_time, ...event };
  });
}

/** The partner's number, without the recipient's ZIP code a USPS routing barcode opens with. */
function partnerNumber(raw: string, number: string): string | undefined {
  const compact = normalizeTrackingNumber(raw).toUpperCase();
  const code = USPS_ROUTING_BARCODE.test(compact) ? uspsPackageIdentifier(compact) ?? '' : compact;
  return /^[A-Z0-9]{4,40}$/.test(code) && code !== number ? code : undefined;
}

/**
 * The carrier that delivers in the destination country and its number, from
 * "Final Mile Tracking By:". The partner is named only when the catalog knows
 * its exact name and its link, if any, is its own; the number stays without a
 * partner otherwise.
 */
function finalMile(container: Cheerio<Element>, number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const section = container.find('.finalMiletrackingSection');
  if (section.length > 1) throw new SchemaError(PROVIDER, 'GlobalPost returned several final-mile partners');
  const holder = section.find('.finalMileTrackingNumber [id$="-finalMile-tracking-id"]');
  const delivery = partnerNumber(clean(holder.text(), 80), number);
  if (!delivery) return {};
  const name = clean(section.find('.finalMileTrackingCarrier').text(), 80);
  const partner = name ? carrierIdFromPartner(name, holder.find('a[href]').attr('href') ?? '') : undefined;
  return { ...(partner && partner !== 'globalpost' ? { delivery_carrier: partner } : {}), delivery_tracking_number: delivery };
}

/**
 * GlobalPost's tracking page for one number, `/track-detail/?t={number}`, which
 * the site renders on its server: the newest status, the route's towns, the
 * GlobalPost number as asked, the final-mile carrier and its number, the
 * service, then the scans. The page repeats the number it is asked, and also
 * opens a parcel by its partner's number, so only GlobalPost's own numbers are
 * asked. The recipient's and shipper's towns, read only to tell a return, the
 * shipper's country, read only for an SDC number's origin, the shipper's ZIP
 * code and the progress rail are not kept.
 */
export function parseGlobalpost(html: string, raw: string): CarrierResult {
  const number = normalizeGlobalpostNumber(raw);
  const $ = load(html);
  const containers = $('.single-tracking-container');
  if (!containers.length) {
    if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'GlobalPost answered with a bot check');
    throw new SchemaError(PROVIDER, 'GlobalPost returned a page without a shipment');
  }
  if (containers.length > 1) throw new IndeterminateError(PROVIDER, 'GlobalPost answered for several shipments');
  const container = containers.first();
  const echoed = clean(container.find('.globalPostTrackingNumber [id$="-global-post-tracking-id"]').text(), 80);
  if (container.attr('id') !== `${number}-container` || normalizeTrackingNumber(echoed).toUpperCase() !== number) {
    throw new IndeterminateError(PROVIDER, 'GlobalPost answered for another number');
  }

  const to = routeField($, container, 'To:');
  const from = routeField($, container, 'From:');
  // GlobalPost's numbers end with the origin's code; the older ones are read by the route's.
  const origin = number.startsWith('SDC') ? placeOfRoute(from)?.country : number.slice(-2);
  const events = dated(returnsHome(scans($, container), from, to), origin === 'US');
  if (!events.length) throw new NoHistoryError(PROVIDER);
  const newest = events[0]!;
  // A registration listed after the parcel moved is no step back.
  const current = events.find((event) => event.stage && event.stage !== 'registered') ?? events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const service = clean(container.find('[id$="-global-post-service"]').first().text(), 80);
  const country = to.split(',').at(-1)?.trim() ?? '';
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    ...(service ? { service_name: service } : {}),
    ...(/^[A-Z]{2}$/.test(country) ? { destination_country: country } : {}),
    ...finalMile(container, number),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
