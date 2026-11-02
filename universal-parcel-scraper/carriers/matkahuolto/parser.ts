import { DateTime } from 'luxon';
import { isValidS10TrackingNumber, isValidSscc, normalizeTrackingNumber } from '../../core/detection/index.js';
import { returnedTrackingNumber } from '../../core/detection/returned.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { lastMovement } from '../../core/result/pickup.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { isMatkahuoltoNotice, matkahuoltoStage } from './status.js';

export const PROVIDER = 'Matkahuolto';
// A reply is about 300 bytes per scan.
export const MATKAHUOLTO_MAX_BYTES = 256 * 1024;

const MAX_ROWS = 300;
const MAX_EVENTS = 100;
// Matkahuolto's own numbers: MH, nine digits and FI, or MA and nineteen digits.
const OWN_S10 = /^MH\d{9}FI$/;
const OWN_MA = /^MA\d{19}$/;
// An SSCC, with or without its 00 identifier.
const SSCC = /^(?:00)?\d{18}$/;
const DATE = /^(\d{2})\.(\d{2})\.(\d{4})$/;
const TIME = /^(\d{2}):(\d{2})$/;
// A town, as the tracker names the place of a scan, optionally followed by
// the postcode of the terminal or point. Anything else is not read: it could
// be an address.
const TOWN = /^(\p{L}[\p{L}'-]*(?: \p{L}[\p{L}'-]*){0,2})(?: \d{5})?$/u;
// A public pickup point: its town, its kind, its name, then its street.
const POINT = /^(\p{L}[\p{L}'-]*(?: \p{L}[\p{L}'-]*){0,2}) (pakettipiste|pakettiautomaatti|ulkoautomaatti) ([^,]{1,100})(?:, ([^,]{1,80}))?$/u;
// The page leaves out a service whose name says it was paid in cash.
const CASH = /käteinen|kontant|\bcash\b/i;

export interface MatkahuoltoNumber {
  /** The number as the tracker is asked for it. */
  readonly query: string;
  /** Matkahuolto's own number, a postal S10 item it carries, or an SSCC. */
  readonly kind: 'own' | 'postal' | 'sscc';
}

/**
 * Matkahuolto's own MH…FI and MA numbers, the S10 items of the posts it
 * delivers for, and SSCCs. An S10 number and an SSCC need a valid check digit.
 */
export function normalizeMatkahuoltoNumber(raw: string): MatkahuoltoNumber {
  const number = normalizeTrackingNumber(raw);
  if (OWN_MA.test(number) || (OWN_S10.test(number) && isValidS10TrackingNumber(number))) return { query: number, kind: 'own' };
  if (isValidS10TrackingNumber(number)) return { query: number, kind: 'postal' };
  if (SSCC.test(number) && isValidSscc(number.length === 18 ? `00${number}` : number)) return { query: number, kind: 'sscc' };
  throw new InvalidInputError(PROVIDER, 'Matkahuolto tracks MH…FI and MA numbers, postal S10 items and SSCCs');
}

/**
 * Matkahuolto's own numbers and SSCCs: a parcel its tracker knows by an SSCC
 * is one it carries. Knowing a post's item says less, since it delivers some
 * for other posts.
 */
export function normalizeMatkahuoltoRecognitionNumber(raw: string): string {
  const number = normalizeMatkahuoltoNumber(raw);
  if (number.kind === 'postal') throw new InvalidInputError(PROVIDER, 'Matkahuolto recognizes its own MH…FI and MA numbers and SSCCs only');
  return number.query;
}

/** Whether the number the reply names is the one asked for. An SSCC is named with its 00 identifier. */
function sameNumber(named: string, number: MatkahuoltoNumber): boolean {
  if (named === number.query) return true;
  return number.kind === 'sscc' && named.length !== number.query.length
    && named.replace(/^00(?=\d{18}$)/, '') === number.query.replace(/^00(?=\d{18}$)/, '');
}

/** The scan's date and time ("08.10.2026", "11:14") as a wall clock. They carry no offset. */
function wallClock(date: string, time: string): string | null {
  const day = DATE.exec(date);
  const clock = TIME.exec(time);
  if (!day || !clock) return null;
  // UTC only checks the calendar fields. No offset is assigned.
  const parsed = DateTime.fromObject({ year: Number(day[3]), month: Number(day[2]), day: Number(day[1]),
    hour: Number(clock[1]), minute: Number(clock[2]) }, { zone: 'UTC' });
  return parsed.isValid ? parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") : null;
}

interface Place {
  /** The town the scan happened in. */
  readonly location?: string;
  /** A public pickup point: its name, then its street on the next line. */
  readonly point?: string;
}

/** The town of a scan's place, and the point it names when it is a public pickup point. */
function placeOf(text: string): Place {
  if (!text) return {};
  const point = POINT.exec(text);
  if (point) {
    const [, town, kind, name, street] = point;
    return { location: town!, point: [`${town} ${kind} ${name!.trim()}`, ...(street ? [street.trim()] : [])].join('\n') };
  }
  const town = TOWN.exec(text);
  return town ? { location: town[1]! } : {};
}

interface Scan {
  readonly event: CarrierEvent;
  readonly point?: string;
  readonly notice: boolean;
}

function scanOf(row: unknown): Scan {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Matkahuolto returned an invalid scan');
  const time = wallClock(clean(row.date, 16), clean(row.time, 8));
  const description = clean(row.description, 1000);
  if (!time || !description) throw new SchemaError(PROVIDER, 'Matkahuolto returned a scan without a clock or wording');
  const { location, point } = placeOf(clean(row.place, 200));
  return { event: { local_time: time, description, ...(location ? { location } : {}) },
    ...(point ? { point } : {}), notice: isMatkahuoltoNotice(description) };
}

/**
 * The tracker's reply for one number: the consignment it names, its service
 * and its scans, newest first. A number it does not know comes back as
 * `{"notFound": true}`.
 */
export function parseMatkahuolto(reply: unknown, raw: string): CarrierResult {
  const number = normalizeMatkahuoltoNumber(raw);
  if (!isRecord(reply)) throw new SchemaError(PROVIDER, 'Matkahuolto tracking reply changed');
  if (reply.notFound !== undefined) {
    if (reply.notFound === true && Object.keys(reply).length === 1) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Matkahuolto returned an unexpected not-found reply');
  }
  if (typeof reply.parcelNumber !== 'string' || !sameNumber(returnedTrackingNumber(reply.parcelNumber), number)) {
    throw new SchemaError(PROVIDER, 'Matkahuolto answered for a different consignment');
  }
  const rows = reply.trackingEvents;
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Matkahuolto returned an invalid scan list');
  // The page shows its "no data yet" notice for a consignment without scans.
  if (!rows.length) throw new NoHistoryError(PROVIDER);

  const scans: Scan[] = [];
  const seen = new Set<string>();
  rows.forEach(row => {
    const scan = scanOf(row);
    const identity = JSON.stringify([scan.event, scan.point ?? '']);
    if (seen.has(identity)) return;
    seen.add(identity);
    scans.push(scan);
  });
  // Newest first, as the tracker lists them; equal clocks keep its order.
  if (listsNewestFirst(scans.map(({ event }) => event)) === false) scans.reverse();
  scans.sort((left, right) => right.event.local_time! > left.event.local_time! ? 1
    : right.event.local_time! < left.event.local_time! ? -1 : 0);

  // Oldest first: a notice keeps the stage of the scan before it.
  let previous: Stage | undefined;
  for (const { event, notice } of [...scans].reverse()) {
    if (notice) {
      if (previous) Object.assign(event, { stage: previous, stage_source: 'none' });
      continue;
    }
    const classified = matkahuoltoStage(event.description!);
    if (classified) Object.assign(event, { stage: classified.stage, stage_source: classified.source });
    previous = classified?.stage;
  }

  const events = scans.map(({ event }) => event);
  const deciderIndex = Math.max(0, scans.findIndex(({ notice }) => !notice));
  const decider = scans[deciderIndex]!;
  const stage = decider.event.stage as Stage | undefined;
  // The point a parcel waits at, or was collected from when waiting there was
  // its last movement before the delivery.
  const older = scans.slice(deciderIndex + 1);
  const waiting = stage === 'ready_for_pickup' ? decider
    : stage === 'delivered' && lastMovement(older.map(({ event }) => event)) === 'ready_for_pickup'
      ? older.find(({ event, notice }) => event.stage === 'ready_for_pickup' && !notice) : undefined;
  const service = clean(reply.productCategory, 80);

  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: decider.event.stage_source } : {}),
    last_status_text: decider.event.description!,
    last_update: null,
    last_update_local: events[0]!.local_time!,
    expected_delivery: null,
    ...(waiting?.point ? { pickup_point: waiting.point } : {}),
    ...(service && !CASH.test(service) ? { service_name: service } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
