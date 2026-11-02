import { DateTime } from 'luxon';
import { load } from 'cheerio';
import { ChallengeError, IndeterminateError, InvalidInputError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { countryCode, countryTimeZone, explicitOffsetTime, isoTime } from '../../core/time/index.js';
import { isRecord } from '../../core/types.js';
import { isRoyalMailDomesticReference } from '../../core/detection/royalMail.js';
import { isValidS10TrackingNumber } from '../../core/detection/s10.js';
import { furtherAlong } from '../../core/status/progress.js';
import { royalMailEventStage, royalMailScanStage, royalMailSummaryStage, statusForStage } from './status.js';

/** Read the response produced by Royal Mail's form and hCaptcha callback. */
const TRACKING_BASE = 'https://www.royalmail.com/track-your-item';
const SUMMARY_API_PREFIX = 'https://api-web.royalmail.com/mailpieces/microsummary/v1/summary/';
const EVENTS_API_PREFIX = 'https://api-web.royalmail.com/mailpieces/v3/';
const MAX_EVENTS_TO_INSPECT = 500;
const MAX_EVENTS_TO_RETURN = 100;
// A parcel hub's or a mail centre's receipt, without an acceptance before it.
const FIRST_RECEIPTS = new Set(['EVBAH', 'EVDAC', 'EVDAV']);
/** A Parcelforce parcel: PB, its consignment number and the parcel's place in it. */
const PARCELFORCE_PARCEL = /^PB[A-Z]{2}\d{10}$/;

export function normalizeRoyalMailNumber(raw: string): string {
  const value = raw.toLocaleUpperCase('en-US').replace(/[\s.-]/g, '');
  // Mail arriving from abroad keeps the sending post's S10 number on Royal Mail's tracker.
  if (!/^[A-Z]{2}\d{9}GB$/.test(value) && !isValidS10TrackingNumber(value) && !isRoyalMailDomesticReference(value)
    && !PARCELFORCE_PARCEL.test(value)) {
    throw new InvalidInputError('Royal Mail', 'Royal Mail tracking numbers must match the UPU S10 format, a domestic 2D reference or a Parcelforce parcel number');
  }
  return value;
}

export function royalMailTrackingUrl(trackingNumber: string): string {
  return `${TRACKING_BASE}#/tracking-results/${normalizeRoyalMailNumber(trackingNumber)}`;
}

export function royalMailSummaryApiUrl(trackingNumber: string): string {
  return `${SUMMARY_API_PREFIX}${normalizeRoyalMailNumber(trackingNumber)}`;
}

export function royalMailEventsApiUrl(trackingNumber: string): string {
  return `${EVENTS_API_PREFIX}${normalizeRoyalMailNumber(trackingNumber)}/events`;
}

/** Preserve offset-free wall time instead of assigning a zone to overseas scans. */
function eventTime(value: unknown): string | null {
  const raw = cleanScalar(value, 64);
  // A date or wall clock must never acquire the carrier's default timezone.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-](?:(?:0\d|1[0-3]):?[0-5]\d|14:?00))$/i.test(raw)) return null;
  return explicitOffsetTime(raw)?.iso ?? null;
}

const HOME = new Set(['GB', 'JE', 'GG', 'IM']);
// A European partner's scans reach Royal Mail on Central European time, whatever the country's own clock.
const RELAY_CLOCK = 'Europe/Brussels';
const IN_DESTINATION = /\bin the destination country\b/i;
// The scan that leaves a country: "Item Leaving the UK", or "Item Leaving overseas" placed in the country of origin.
const LEAVING = /^item leaving\b/i;
// Royal Mail's own facilities go by bare names: "Example MC", "Example DO", "LANGLEY HWDC".
const HOME_FACILITY = /\b(?:MC|DO|HWDC|IMC|LC|DC|PFW|Mail Centre|Delivery Office|Hub|Depot)\b/i;
const europeanAbroad = (country: string | null) => Boolean(country && !HOME.has(country)
  && countryTimeZone(country)?.startsWith('Europe/'));
/** The country a scan's place is, or ends with. */
const placeCountry = (location: string) => countryCode(/(?:^|,)\s*([^,]+)$/.exec(location)?.[1]);

/**
 * A scan abroad names its country as, or after, the place. A European partner's
 * scan, and an unplaced one in a European destination country, carries the
 * partner's Central European wall clock under the UK's offset, and is read on
 * that clock. A partner's facility can go by its bare name, without a country:
 * it is in the destination when the wording says so, and in the country of
 * origin when it comes before the scan that leaves that country (`departure`).
 * Null for any other scan: beyond Europe, Royal Mail's label is the scan's
 * instant, as at home. The South African post's own tracker dates a South
 * African office's scans at those instants.
 */
function abroadClock(raw: string, location: string, description: string, destination: string | null,
  departure: number | null): { time: string } | { local_time: string } | null {
  const label = eventTime(raw);
  if (!label) return null;
  const country = placeCountry(location);
  const partner = !location || !HOME_FACILITY.test(location);
  const relayed = country ? europeanAbroad(country)
    : partner && (europeanAbroad(destination) && IN_DESTINATION.test(description)
      || Boolean(location) && departure !== null && Date.parse(label) < departure);
  if (!relayed) return null;
  const wall = DateTime.fromISO(raw, { setZone: true }).toISO({ includeOffset: false, suppressMilliseconds: true });
  if (!wall) return null;
  const placed = isoTime(wall, RELAY_CLOCK);
  return placed ? { time: placed.iso } : { local_time: wall };
}

// Royal Mail appends a Post Office branch's postcode in brackets, and an
// overseas partner can report a delivery office by postcode alone.
const POSTCODE = /^(?:[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}|\d{3,10}(?:-\d{3,4})?)$/i;

/** A scan's place without postcodes, which can narrow down a recipient's area. */
function placeName(value: unknown): string {
  const text = cleanScalar(value, 250).replace(/\s*\[([^\]]*)\]$/, (bracket, inner: string) => POSTCODE.test(inner.trim()) ? '' : bracket);
  return POSTCODE.test(text) ? '' : text;
}

// Royal Mail ends some scans where its page shows the place: "Arrived at", "Item received at",
// "Due to be delivered today by".
const PLACE_FOLLOWS = /\s(at|by)$/i;

/**
 * A scan's wording as a whole sentence. One that ends where Royal Mail's page
 * shows the place takes it; without one, "at" names a Royal Mail office and
 * "by" is dropped.
 */
function sentence(description: string, location: string): string {
  const ending = PLACE_FOLLOWS.exec(description)?.[1]!.toLowerCase();
  if (!ending) return description;
  if (location) return `${description} ${location}`;
  return ending === 'at' ? `${description} a Royal Mail office` : description.replace(PLACE_FOLLOWS, '');
}

/** A delivery estimate reduced to its calendar day. */
function expectedDelivery(value: unknown): string | null {
  const raw = cleanScalar(value, 64);
  const day = /^\d{4}-\d{2}-\d{2}/.exec(raw)?.[0];
  return day && DateTime.fromISO(day).isValid ? day : null;
}

const hasCode = (errors: readonly unknown[], code: string) => errors.some(error => isRecord(error)
  && (error.errorCode === code || error.code === code));

/**
 * Royal Mail's answers about the reference itself, not a failing route, both under HTTP 404.
 * E1142, "unable to confirm the status", is its reply for a reference it cannot locate, which
 * its tracking application files as not found; an item can be unknown until its first scan.
 * E1283 says the reference's service is not tracked. Both stay inconclusive.
 */
export function royalMailUnconfirmed(errors: readonly unknown[]): IndeterminateError | null {
  if (hasCode(errors, 'E1142')) {
    return new IndeterminateError('Royal Mail', 'Royal Mail could not confirm the tracking status', { reason: 'portal_not_found' });
  }
  return hasCode(errors, 'E1283') ? new IndeterminateError('Royal Mail', 'Royal Mail does not track this service') : null;
}

/** Only the field vocabulary consumed by the public tracking application. */
export function parseRoyalMailTrackingResponse(payload: unknown, trackingNumber: string): CarrierResult {
  const number = normalizeRoyalMailNumber(trackingNumber);
  if (!isRecord(payload)) throw new SchemaError('Royal Mail', 'Royal Mail returned an invalid tracking response');
  const errors = Array.isArray(payload.errors) ? payload.errors.filter(isRecord) : [];
  if (errors.some(error => error.errorCode === 'E0015' || error.code === 'E0015')) {
    throw new ChallengeError('Royal Mail', 'Royal Mail denied the tracking session');
  }
  if (String(payload.httpCode) === '429') throw new RateLimitedError('Royal Mail');
  if (errors.length) throw royalMailUnconfirmed(errors) ?? new IndeterminateError('Royal Mail', 'Royal Mail could not confirm the tracking status');
  const mailpiece = payload.mailPieces;
  // Both summary and events endpoints return one object, not the array used by the
  // recent-items endpoint. Never treat a gateway 404 or schema drift as not-found.
  if (!isRecord(mailpiece) || !isRecord(mailpiece.summary)) {
    throw new SchemaError('Royal Mail', 'Royal Mail returned an invalid tracking response');
  }
  if (cleanScalar(mailpiece.mailPieceId).toUpperCase() !== number) {
    throw new SchemaError('Royal Mail', 'Royal Mail did not return the requested parcel');
  }
  const summary = mailpiece.summary;
  const summaryText = cleanScalar(summary.statusDescription).replace(/\*\*/g, '').trim();
  if (mailpiece.events !== undefined && !Array.isArray(mailpiece.events)) {
    throw new SchemaError('Royal Mail', 'Royal Mail returned invalid tracking events');
  }
  const scans = Array.isArray(mailpiece.events) ? mailpiece.events : [];
  // Only the full-history reply names the destination, and not always.
  const destination = cleanScalar(summary.destinationCountryCode, 8);
  const destinationCountry = /^[A-Z]{2}$/.test(destination) ? destination : null;
  // Without it, an unplaced scan in the destination country is in the country the scans abroad name.
  const abroadCountry = destinationCountry ?? scans.slice(0, MAX_EVENTS_TO_INSPECT)
    .map(raw => isRecord(raw) ? placeCountry(placeName(raw.locationName)) : null).find(country => country && !HOME.has(country)) ?? null;
  // Mail from abroad names its country of origin on the scan that leaves it, as Royal Mail labels it.
  const departure = scans.slice(0, MAX_EVENTS_TO_INSPECT).flatMap((raw) => {
    if (!isRecord(raw) || !LEAVING.test(cleanScalar(raw.eventName).replace(/\*\*/g, '').trim())
      || !europeanAbroad(placeCountry(placeName(raw.locationName)))) return [];
    const label = eventTime(raw.eventDateTime);
    return label ? [Date.parse(label)] : [];
  }).reduce<number | null>((latest, at) => (latest === null || at > latest ? at : latest), null);
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  const abroad = new Map<string, { time: string } | { local_time: string }>();
  for (const raw of scans.slice(0, MAX_EVENTS_TO_INSPECT)) {
    if (!isRecord(raw)) throw new SchemaError('Royal Mail', 'Royal Mail returned invalid tracking events');
    // The website returns Markdown emphasis, including "**Delivered by**".
    // Normalize it before classification so delivery prose is still redacted.
    const description = cleanScalar(raw.eventName).replace(/\*\*/g, '').trim();
    if (!description) throw new SchemaError('Royal Mail', 'Royal Mail returned invalid tracking events');
    const code = cleanScalar(raw.eventCode, 64);
    const mapped = royalMailEventStage(code);
    const stage = royalMailScanStage(code, description);
    const timeText = cleanScalar(raw.eventDateTime, 64);
    const location = placeName(raw.locationName);
    const clock = abroadClock(timeText, location, description, abroadCountry, departure);
    if (clock && !abroad.has(timeText)) abroad.set(timeText, clock);
    const time = clock ? ('time' in clock ? clock.time : null) : eventTime(raw.eventDateTime);
    const event: CarrierEvent = {
      ...(clock ?? (time ? { time } : {})),
      ...(!time && !clock && timeText ? { provider_time_text: timeText } : {}),
      ...(location ? { location } : {}),
      description: stage === 'delivered' ? 'Delivered' : sentence(description, location),
      ...(stage ? { stage } : {}),
      ...(mapped ? { stage_source: 'carrier_map' } : {}),
      ...(/^[A-Za-z0-9_-]+$/.test(code) ? { provider_code: code } : {}),
    };
    const identity = JSON.stringify([time ?? timeText, location, event.description]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    events.push(event);
  }
  // Royal Mail also sorts the history; upstream order is not guaranteed.
  // A partial comparator can move resolved scans across unresolved overseas
  // clocks. Preserve provider order unless every scan denotes an instant.
  let receiptAccepted = false;
  if (events.every(event => event.time)) {
    if (listsNewestFirst(events) === false) events.reverse();
    events.sort((a, b) => Date.parse(b.time!) - Date.parse(a.time!));
    // Mail a sender hands in at a parcel hub or a mail centre, or a collection
    // one of them receives first, has no acceptance scan before that receipt,
    // which the summary then calls "We've got it".
    const first = [...events].reverse().find(event => event.stage !== 'registered' && event.stage !== 'pending');
    if (first?.stage === 'in_transit' && FIRST_RECEIPTS.has(first.provider_code ?? '')) {
      first.stage = 'accepted';
      receiptAccepted = true;
    }
  }
  const trimmed = events.slice(0, MAX_EVENTS_TO_RETURN);
  const summaryCategory = cleanScalar(summary.statusCategory);
  const statusText = summaryText || summaryCategory || trimmed[0]?.description;
  if (!statusText) throw new SchemaError('Royal Mail', 'Royal Mail returned no usable tracking status');
  // The summary repeats the newest scan's label, which a scan abroad corrects.
  const lastText = cleanScalar(summary.lastEventDateTime, 64);
  const lastClock = abroad.get(lastText);
  const lastTime = lastClock ? ('time' in lastClock ? lastClock.time : null) : eventTime(lastText);
  // A summary category groups several scans: "Ready for Delivery" covers the delivery office's
  // receipt and the day's round, "We've got it" the acceptance and the mail centre's receipt after
  // a drop-off. When it repeats the newest scan, a round, customs or receipt scan's code places the
  // parcel further along. Receipts after a first receipt, the acceptance itself, stay under it.
  const summaryStage = royalMailSummaryStage(summaryCategory, statusText) ?? undefined;
  const newest = trimmed[0];
  const repeated = newest?.stage_source === 'carrier_map' && !(receiptAccepted && newest.stage === 'in_transit')
    && (Boolean(lastTime) && lastTime === newest.time
      || events.every(event => event.time) && cleanScalar(summary.lastEventCode, 64) === newest.provider_code);
  const stage = repeated && furtherAlong(summaryStage, newest.stage) ? newest.stage : summaryStage;
  const delivered = stage === 'delivered';
  const deliveredAt = !delivered ? null : trimmed.find(event => event.stage === 'delivered' && event.time)?.time
    ?? (royalMailEventStage(cleanScalar(summary.lastEventCode, 64)) === 'delivered' ? lastTime : null);
  return {
    status: stage ? statusForStage(stage) : 'unknown',
    ...(stage ? { current_stage: stage } : {}),
    last_status_text: delivered ? 'Delivered' : statusText,
    last_update: lastClock ? lastTime : lastTime || trimmed[0]?.time || null,
    expected_delivery: delivered || !isRecord(mailpiece.estimatedDelivery)
      ? null : expectedDelivery(mailpiece.estimatedDelivery.date),
    ...(deliveredAt ? { delivered_at: deliveredAt } : {}),
    ...(destinationCountry ? { destination_country: destinationCountry } : {}),
    events: trimmed,
    ...(trimmed.length ? {} : { summary_only: true }),
  };
}

/**
 * The page the browser rendered, read only to tell a bot challenge from an
 * inconclusive load. Rendered text never decides not-found: only the
 * structured reply does.
 */
export function parseRoyalMailTrackingHtml(page: string): 'challenged' | 'inconclusive' {
  const $ = load(page);
  $('script, style, noscript').remove();
  const visible = clean($('body').text(), 20_000);
  if (/access denied|just a moment|attention required|are you a robot|verify you are human|before you proceed|unusual traffic/i.test(visible)) {
    return 'challenged';
  }
  return 'inconclusive';
}
