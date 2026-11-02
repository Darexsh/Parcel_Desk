import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { mainZone } from '../../places/zones.js';
import { pitneyBowesPlatformClock } from './clock.js';
import { declarationCountry } from './identity.js';
import { interpostClearance, pitneyBowesStage, pitneyBowesSummaryStage } from './status.js';

export const PROVIDER = 'Pitney Bowes';
// A long history is under twenty kilobytes.
export const PITNEY_BOWES_MAX_BYTES = 512 * 1024;
// The references Pitney Bowes prints, as its detection rules claim them: eBay
// parcels from the US and the UK, eBay parcels from the UK, and its other
// cross-border parcels.
const NUMBER = /^(?:UPAA[A-Z]\d{15}|UPBE[0-9A-F]{16}|PBX[A-Z]{2}(?:\d{9}|[0-9A-F]{15}))$/;
// The page's answer when it could not read the parcel, which it also gives
// for a number it does not know and for one whose history has expired.
const FAILED = new Set(['ServerError', 'Timeout']);
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A Pitney Bowes reference in capitals; anything else is not a number it issues. */
export function normalizePitneyBowesNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Pitney Bowes references start with UPAA, UPBE or PBX');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Pitney Bowes returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * A scan's clock: `date` ("Sep 6, 2026") and `hour` ("05:53 PM") as the page
 * shows them, the wall clock of whoever scanned the parcel. A relayed scan
 * keeps its partner's clock, so the clock stays local.
 */
function scanClock(row: Record<string, unknown>): string {
  const date = text(row, 'date', 20);
  const hour = text(row, 'hour', 12);
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = DateTime.fromFormat(`${date} ${hour}`, 'MMM d, yyyy h:mm a', { zone: 'UTC', locale: 'en-US' });
  // Luxon reads 13:00 PM or Feb 30 as invalid, and the clock must read back as written.
  if (!parsed.isValid || parsed.toFormat('MMM d, yyyy h:mm a') !== `${date} ${hour.replace(/^0/, '')}`) {
    throw new SchemaError(PROVIDER, 'Pitney Bowes returned an invalid scan time');
  }
  return parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

/** A wall clock read in a zone the scan itself tells, and how that zone was chosen. */
function dated(local: string, zone: string, basis: string): Pick<CarrierEvent, 'time' | 'time_zone' | 'time_zone_basis'> {
  const time = firstOccurrence(DateTime.fromISO(local, { zone })).toISO({ suppressMilliseconds: true });
  return time ? { time, time_zone: zone, time_zone_basis: basis } : {};
}

/**
 * An import declaration's country is paperwork: Interpost can lodge it within
 * hours of the parcel leaving the UK hub, before the parcel could be there.
 * The scan keeps no place, so it puts nothing on a map, but the country still
 * tells its clock, as the place did.
 */
function withoutDeclarationCountry(event: CarrierEvent): CarrierEvent {
  const country = declarationCountry(event.description ?? '', event.location ?? '');
  if (!country) return event;
  const unplaced = { ...event };
  delete unplaced.location;
  const zone = mainZone(country);
  return zone ? { ...unplaced, ...dated(event.local_time!, zone, 'place') } : unplaced;
}

/** A scan the platform writes without a place, on its own clock (`pitneyBowesPlatformClock`). */
function onPlatformClock(event: CarrierEvent): CarrierEvent {
  const zone = event.location || event.time ? undefined : pitneyBowesPlatformClock(event.description!);
  return zone ? { ...event, ...dated(event.local_time!, zone, 'carrier') } : event;
}

/** A scan's place as written, without the `XX` some relayed scans put for a missing region. */
function place(row: Record<string, unknown>): string {
  return text(row, 'location', 120).split(',').map((part) => part.trim()).filter((part) => part && part !== 'XX').join(', ');
}

/** The parcel's weight, written in pounds and ounces ("1 lbs. 6 oz.", "3 oz."). */
function weightKg(value: string): number | null {
  const match = /^(?:(\d{1,4}) lbs?\.?)? ?(?:(\d{1,3}) oz\.?)?$/i.exec(value);
  if (!value || !match || (match[1] === undefined && match[2] === undefined)) return null;
  const ounces = Number(match[1] ?? 0) * 16 + Number(match[2] ?? 0);
  return ounces > 0 ? Math.round(ounces * 28.349523125) / 1000 : null;
}

interface Scan {
  event: CarrierEvent;
  /** The wall clock in minutes, to compare two scans' clocks. */
  minute: number;
}

const HOUR = 60;
// The furthest a wall clock is from UTC.
const MAX_SHIFT = 14 * HOUR;

/**
 * The scans without repeats. Pitney Bowes relays some partners' scans twice:
 * once with the place, on the place's clock, and once in capitals without it,
 * on another clock whole hours away (UTC, by the British and German scans
 * seen). The copy without its place goes, as does a scan repeated whole.
 */
function withoutCopies(scans: Scan[]): Scan[] {
  const seen = new Set<string>();
  const unique = scans.filter((scan) => {
    const key = JSON.stringify([scan.minute, scan.event.description!.toLowerCase(), scan.event.location ?? '']);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const paired = new Set<Scan>();
  const copies = new Set<Scan>();
  for (const scan of unique) {
    const wording = scan.event.description!;
    if (scan.event.location) continue;
    const capitals = wording === wording.toUpperCase();
    let twin: Scan | undefined;
    for (const other of unique) {
      const shift = Math.abs(other.minute - scan.minute);
      if (!other.event.location || paired.has(other) || other.event.description!.toLowerCase() !== wording.toLowerCase()) continue;
      // A copy on another clock is told apart by its capitals; one on the same clock needs none.
      if (shift !== 0 && (!capitals || other.event.description === wording || shift % HOUR !== 0 || shift > MAX_SHIFT)) continue;
      if (!twin || shift < Math.abs(twin.minute - scan.minute)) twin = other;
    }
    if (twin) {
      paired.add(twin);
      copies.add(scan);
    }
  }
  return unique.filter((scan) => !copies.has(scan));
}

/**
 * The reply of `/api/track/package-details/{number}`, which the tracking page
 * reads: a summary status and the scans the page lists, newest first. The
 * parcel must be the number asked. Each scan's link to the onward carrier's
 * page carries an access key and that carrier's number; neither is kept.
 */
export function parsePitneyBowes(payload: unknown, raw: string): CarrierResult {
  const number = normalizePitneyBowesNumber(raw);
  if (!isRecord(payload) || typeof payload.trackingNumber !== 'string') throw new SchemaError(PROVIDER, 'Pitney Bowes returned a reply without its number');
  const shipping = isRecord(payload.shippingInfoModule) ? payload.shippingInfoModule : null;
  if (!shipping && payload.shippingInfoModule !== undefined && payload.shippingInfoModule !== null) {
    throw new SchemaError(PROVIDER, 'Pitney Bowes returned invalid shipping details');
  }
  const named = [payload.trackingNumber, shipping?.trackingNumber].filter((value) => value !== undefined && value !== null);
  if (named.some((value) => typeof value !== 'string' || normalizeTrackingNumber(value).toUpperCase() !== number)) {
    throw new IndeterminateError(PROVIDER, 'Pitney Bowes answered for another shipment');
  }
  const status = text(payload, 'trackingPackageStatus', 40);
  if (!status) throw new SchemaError(PROVIDER, 'Pitney Bowes returned a reply without its status');
  if (payload.trackingPackageNotFound === true || status === 'NotFound') throw new NotFoundError(PROVIDER);
  if (FAILED.has(status)) throw new IndeterminateError(PROVIDER, 'Pitney Bowes could not read the parcel, as it says for a number it does not know');

  const module = payload.trackingEventsModule;
  if (!isRecord(module) || !Array.isArray(module.trackingEvents)) throw new SchemaError(PROVIDER, 'Pitney Bowes returned a reply without its scans');
  if (module.trackingEvents.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Pitney Bowes returned an oversized history');

  const scans: Scan[] = [];
  for (const row of module.trackingEvents as unknown[]) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Pitney Bowes returned an invalid scan');
    const written = text(row, 'description');
    if (!written) throw new SchemaError(PROVIDER, 'Pitney Bowes returned a scan without wording');
    const local = scanClock(row);
    const location = place(row);
    const clearance = interpostClearance(written);
    const staged = pitneyBowesStage(written);
    scans.push({ minute: Date.parse(`${local}Z`) / 60_000, event: {
      local_time: local,
      ...(location ? { location } : {}),
      description: clearance?.wording ?? written,
      ...(clearance ? { provider_code: clearance.code } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  }
  const kept = withoutCopies(scans);
  if (!kept.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the page lists them; scans of one minute keep the reply's order.
  const events = kept.map((scan) => onPlatformClock(withoutDeclarationCountry(scan.event)));
  if (listsNewestFirst(events) === false) events.reverse();
  events.sort((a, b) => String(b.local_time).localeCompare(String(a.local_time)));

  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  const summary = pitneyBowesSummaryStage(status);
  const settled = summary === 'delivered' && scanned?.stage !== 'delivered';
  const stage = (settled ? summary : scanned?.stage ?? summary) as Stage | undefined;
  const source = settled || !scanned ? 'carrier_map' : scanned.stage_source;
  const service = shipping ? text(shipping, 'shippingType', 120) : '';
  const weight = shipping ? weightKg(text(shipping, 'packageWeight', 40)) : null;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    ...(service ? { service_name: service } : {}),
    ...(weight ? { weight_kg: weight } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
