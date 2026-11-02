import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { lastMovement } from '../../core/result/pickup.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, countryTimeZone, explicitOffsetTime, isoTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { isLietuvosPastasNotice, lietuvosPastasStage, RETURN_STARTS } from './status.js';

export const PROVIDER = 'Lietuvos paštas';
// A long history is a few kilobytes.
export const LIETUVOS_PASTAS_MAX_BYTES = 512_000;

const MAX_MAILS = 20;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
const HOME = 'LT';
const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The answer for a number the service does not know.
const NO_MAIL = '00000000-0000-0000-0000-000000000000';
// The sorting centre of the recipient's country, or of a transit country before it.
const RECEIVER_CENTRE: ReadonlySet<string> = new Set(['RECEIVED_RECEIVER_LC', 'DEPARTED_RECEIVER_LC']);
const STAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
// A mail the page leaves out: the label for a customer return, not this parcel's journey.
const RETURN_MAIL = 'return';
// The label created online; the self-service site is not a place.
const SELF_SERVICE = /^savitarna$/i;
const POSTCODE = /^(?:LT-?)?\d{5}$/i;
// A parcel locker or post office leads with its kind.
const POINT = /paštomat|paštas|pašto skyrius|terminal/i;
const LITHUANIAN_REGIONS = new Intl.DisplayNames(['lt'], { type: 'region' });
const ENGLISH_REGIONS = new Intl.DisplayNames(['en'], { type: 'region' });

/**
 * Lietuvos paštas's numbers: two letters, nine digits and LT, its own S10
 * items and LP Express parcels (CC, CH and HC, which mostly fail the S10 check
 * digit), and S10 items other posts send to Lithuania.
 */
export function normalizeLietuvosPastasNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (/^[A-Z]{2}\d{9}LT$/.test(number) || isValidS10TrackingNumber(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Lietuvos paštas tracks item codes of two letters, nine digits and two letters');
}

interface Clock {
  /** The instant the feed labels the row with, for ordering. */
  readonly order: number;
  readonly time?: string;
  readonly localTime?: string;
}

/**
 * The feed labels every row with Vilnius's offset. Its own rows are Vilnius
 * times; a row from abroad carries that country's wall clock instead, which is
 * read in the country's zone, or kept as a wall clock when it has several.
 */
function clockOf(value: unknown, country: string | null): Clock | null {
  const match = typeof value === 'string' ? STAMP.exec(value.trim()) : null;
  const labeled = match ? explicitOffsetTime(`${match[1]}${match[2]}`) : null;
  if (!match || !labeled) return null;
  if (!country || country === HOME) return { order: labeled.timestamp, time: labeled.iso };
  const zone = countryTimeZone(country);
  const local = zone ? isoTime(match[1], zone) : null;
  return local ? { order: labeled.timestamp, time: local.iso } : { order: labeled.timestamp, localTime: match[1] };
}

interface Place {
  readonly location?: string;
  /** A parcel locker or post office: its name, then its town on the next line. */
  readonly point?: string;
}

/**
 * A row's place: a town, a sorting centre or a country, or a parcel locker or
 * post office with its street, town and postcode. The street and postcode are
 * left out, and so is any other place with several parts, which could be a
 * door address.
 */
function placeOf(value: unknown, country: string | null): Place {
  const parts = clean(value, 300).split(',').map(part => part.trim()).filter(Boolean);
  if (parts.length > 1 && POSTCODE.test(parts.at(-1)!)) parts.pop();
  if (!parts.length) return {};
  const [first] = parts as [string, ...string[]];
  if (parts.length === 1) {
    if (SELF_SERVICE.test(first)) return {};
    if (POINT.test(first)) return { location: first, point: first };
    if (/\d/.test(first)) return {};
    // A row from abroad names its country in Lithuanian.
    if (country && country !== HOME && LITHUANIAN_REGIONS.of(country) === first) return { location: ENGLISH_REGIONS.of(country) ?? first };
    return { location: first };
  }
  if (!POINT.test(first)) return {};
  const town = parts.at(-1)!;
  const name = parts.slice(0, parts.length > 2 ? -2 : 1).join(', ');
  if (/\d/.test(town)) return { location: name, point: name };
  return { location: `${name}, ${town}`, point: `${name}\n${town}` };
}

interface Row {
  readonly code: string;
  readonly country: string | null;
  readonly clock: Clock;
  readonly text: string;
  readonly place: Place;
  readonly index: number;
}

function rowOf(value: unknown, index: number): Row {
  if (!isRecord(value)) throw new SchemaError(PROVIDER, 'Lietuvos paštas returned an invalid row');
  const code = clean(value.publicEventType, 64);
  const raw = typeof value.countryCode === 'string' ? value.countryCode.trim().toUpperCase() : '';
  const country = /^[A-Z]{2}$/.test(raw) ? countryCode(raw) : null;
  const clock = clockOf(value.eventDate, country);
  if (!CODE.test(code) || !clock) throw new SchemaError(PROVIDER, 'Lietuvos paštas returned a row without a type or clock');
  return { code, country, clock, text: clean(value.publicEventText, 300), place: placeOf(value.location, country), index };
}

/**
 * The tracking service's answer for one number: the mail it knows under that
 * number, if any, and its rows, oldest first, each with a public event type,
 * an English wording, a clock, a country and often a place.
 */
export function parseLietuvosPastas(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeLietuvosPastasNumber(rawNumber);
  if (!isRecord(payload) || typeof payload.mailGuid !== 'string' || !GUID.test(payload.mailGuid)
    || !Array.isArray(payload.mails) || payload.mails.length > MAX_MAILS) {
    throw new SchemaError(PROVIDER, 'Lietuvos paštas did not return a mail');
  }
  if (typeof payload.mailBarcode !== 'string' || payload.mailBarcode.trim().toUpperCase() !== number) {
    throw new SchemaError(PROVIDER, 'Lietuvos paštas answered for a different item');
  }
  if (payload.mailGuid === NO_MAIL) {
    if (payload.mails.length) throw new SchemaError(PROVIDER, 'Lietuvos paštas returned mails without an identifier');
    throw new NotFoundError(PROVIDER);
  }
  const raws: unknown[] = [];
  for (const mail of payload.mails) {
    if (!isRecord(mail) || !Array.isArray(mail.events)) throw new SchemaError(PROVIDER, 'Lietuvos paštas returned an invalid mail');
    // The tracking page shows every mail but the return label's.
    if (typeof mail.type === 'string' && mail.type.trim().toLowerCase() === RETURN_MAIL) continue;
    raws.push(...(mail.events as unknown[]));
  }
  if (raws.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Lietuvos paštas returned an invalid history');
  // A mail the service knows with no rows yet, or whose rows it no longer shows.
  if (!raws.length) throw new NoHistoryError(PROVIDER);
  const rows = raws.map(rowOf);

  const scans: { event: CarrierEvent; row: Row }[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const event: CarrierEvent = {
      ...(row.clock.time ? { time: row.clock.time } : { local_time: row.clock.localTime! }),
      description: row.text || row.code, provider_code: row.code,
      ...(row.place.location ? { location: row.place.location } : {}),
    };
    const identity = JSON.stringify(event);
    if (seen.has(identity)) continue;
    seen.add(identity);
    scans.push({ event, row });
  }
  // Newest first; rows at the same labeled instant follow the reply's order, reversed.
  scans.sort((left, right) => right.row.clock.order - left.row.clock.order || right.row.index - left.row.index);

  // Oldest first: a notice keeps the stage of the row before it, and a
  // delivery after the parcel was sent back reaches the sender.
  let returning = false;
  let previous: Stage | undefined;
  for (const { event, row } of [...scans].reverse()) {
    if (RETURN_STARTS.has(row.code)) returning = true;
    if (isLietuvosPastasNotice(row.code)) {
      if (previous) Object.assign(event, { stage: previous, stage_source: 'none' });
      continue;
    }
    const classified = lietuvosPastasStage(row.code, row.text);
    const stage = classified?.stage === 'delivered' && returning ? 'returned' : classified?.stage;
    if (stage) Object.assign(event, { stage, stage_source: classified!.source });
    previous = stage;
  }
  const events = scans.map(scan => scan.event);

  const decider = scans.find(scan => !isLietuvosPastasNotice(scan.row.code)) ?? scans[0]!;
  const stage = decider.event.stage as Stage | undefined;
  // The locker or office a parcel waits at is its pickup point; a delivered
  // parcel was collected there when it waited there last. A return's is the sender's.
  let point = '';
  if (!returning) {
    if (stage === 'ready_for_pickup') point = decider.row.place.point ?? '';
    else if (stage === 'delivered') {
      const earlier = scans.slice(scans.indexOf(decider) + 1);
      if (lastMovement(earlier.map(scan => scan.event)) === 'ready_for_pickup') {
        point = earlier.find(scan => scan.event.stage === 'ready_for_pickup' && !isLietuvosPastasNotice(scan.row.code))?.row.place.point ?? '';
      }
    }
  }
  const newest = events[0]!;
  // An item sent abroad reaches the recipient's country last: its post delivers the rest.
  const destination = scans.find(scan => RECEIVER_CENTRE.has(scan.row.code) && scan.row.country && scan.row.country !== HOME)?.row.country;

  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: decider.event.stage_source } : {}),
    last_status_text: decider.event.description!,
    last_update: newest.time ?? null,
    ...(typeof newest.local_time === 'string' ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    ...(stage === 'delivered' && decider.event.time ? { delivered_at: decider.event.time } : {}),
    ...(point ? { pickup_point: point } : {}),
    ...(destination ? { destination_country: destination } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
