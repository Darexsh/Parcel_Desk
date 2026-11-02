import { DateTime } from 'luxon';
import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { clean, escapeRegExp } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { bombinoStage, bombinoStateLabel } from './status.js';

export const PROVIDER = 'Bombino Express';
// A one-piece shipment's reply is about two kilobytes.
export const BOMBINO_MAX_BYTES = 512 * 1024;
// An air waybill: seven to ten digits on every tracker Bombino has had.
const NUMBER = /^\d{7,10}$/;
const STATE = /^[A-Za-z0-9_ -]{1,40}$/;
const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})(?:[ T]|$)/;
// The lookup's answer for an air waybill it has no shipment for.
const NOT_FOUND = /^no tracking data found\.?$/i;
// Separators the reply leaves at the end of a scan's wording ("SHIPMENT UNHOLD -").
const TRAILING = /[\s,;:\-–—]+$/;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A Bombino air waybill, digits only; anything else is not one it issues. */
export function normalizeBombinoNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Bombino Express air waybills are seven to ten digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Bombino Express returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** The value of one `[label, value]` row of the shipment's details, as the page reads it. */
function detail(rows: unknown[], label: string): string {
  const row = rows.find((candidate) => Array.isArray(candidate) && clean(candidate[0], 80).toLowerCase() === label);
  return Array.isArray(row) && typeof row[1] === 'string' ? clean(row[1], 300) : '';
}

/** A list the reply may leave out; anything but an array is a changed reply. */
function list(payload: Record<string, unknown>, key: string): unknown[] {
  const value = payload[key] ?? [];
  if (!Array.isArray(value)) throw new SchemaError(PROVIDER, `Bombino Express returned an invalid ${key}`);
  return value;
}

/**
 * The reply's `errors`: false on a shipment, else the lookup's messages. Its
 * own message for a number without a shipment, with nothing else, is a
 * missing parcel; any other message is a lookup that did not complete.
 */
function checkErrors(payload: Record<string, unknown>): void {
  const errors = payload.errors;
  if (errors === false || errors === undefined || errors === null || (Array.isArray(errors) && !errors.length)) return;
  if (errors === true) throw new IndeterminateError(PROVIDER, 'Bombino Express did not complete the lookup');
  if (!Array.isArray(errors) || errors.some((message) => typeof message !== 'string')) {
    throw new SchemaError(PROVIDER, 'Bombino Express returned invalid errors');
  }
  const empty = !list(payload, 'docket_info').length && !list(payload, 'docket_events').length;
  if (empty && errors.every((message) => NOT_FOUND.test(clean(message, 200)))) throw new NotFoundError(PROVIDER);
  throw new IndeterminateError(PROVIDER, 'Bombino Express answered with another error');
}

/** A scan's wall clock: the reply names no zone, and scans abroad may keep their office's clock. */
function scanClock(row: Record<string, unknown>): string {
  const wall = WALL_CLOCK.exec(text(row, 'event_at', 32));
  const local = wall ? `${wall[1]}T${wall[2]}` : '';
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const checked = DateTime.fromISO(local, { zone: 'UTC' });
  // Luxon rolls 24:00:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!wall || !checked.isValid || checked.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'Bombino Express returned an invalid scan time');
  }
  return local;
}

/** Text without the shipment's own names, which a delivery scan could carry. */
function withoutNames(value: string, names: readonly RegExp[]): string {
  return clean(names.reduce((scrubbed, name) => scrubbed.replace(name, ' '), value)).replace(TRAILING, '');
}

function projectRow(row: Record<string, unknown>, names: readonly RegExp[]): { key: string; event: CarrierEvent } {
  const code = text(row, 'event_state', 40);
  if (code && !STATE.test(code)) throw new SchemaError(PROVIDER, 'Bombino Express returned an invalid event state');
  // The page's line for the scan: its own wording, else the state's label.
  const description = withoutNames(text(row, 'event_description'), names) || (code ? bombinoStateLabel(code) ?? '' : '');
  if (!description) throw new SchemaError(PROVIDER, 'Bombino Express returned a scan without wording');
  const local = scanClock(row);
  const location = withoutNames(text(row, 'event_location', 120), names);
  const staged = bombinoStage(code, description);
  const event: CarrierEvent = {
    local_time: local,
    ...(location ? { location } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([local, code, description, location]), event };
}

/** The delivery estimate, a calendar day. */
function estimate(payload: Record<string, unknown>): string | null {
  const day = DAY.exec(text(payload, 'expected_datetime', 40));
  if (!day) return null;
  const parsed = DateTime.fromObject({ year: Number(day[1]), month: Number(day[2]), day: Number(day[3]) }, { zone: 'UTC' });
  return parsed.isValid ? parsed.toISODate() : null;
}

/**
 * The partner that delivers the parcel and its number, from the forwarding
 * number and the partner's tracking link the page shows. The link must carry
 * the number, and its host and path must name one catalog carrier.
 */
function forwarding(payload: Record<string, unknown>, details: unknown[], number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const reference = normalizeTrackingNumber(text(payload, 'forwarding_no', 64) || detail(details, 'forwarding no.')).toUpperCase();
  const link = text(payload, 'forwarding_url', 500);
  if (!/^[A-Z0-9]{4,40}$/.test(reference) || reference === number || !link.toUpperCase().includes(reference)) return {};
  const partner = carrierIdFromPartner('', link);
  return partner && partner !== 'bombino' && partner !== 'unknown' ? { delivery_carrier: partner, delivery_tracking_number: reference } : {};
}

/**
 * The reply of the tracking page's `/api/track/{number}` for one air waybill:
 * the shipment's details as `[label, value]` rows, its scans newest first and
 * each piece's own copy of them. An unknown number is HTTP 200 with the
 * lookup's message in `errors` and no details or scans. The shipment must
 * name the number asked. Names, cities, the customer reference, the weight,
 * the proof of delivery, scan remarks and the pieces are never read.
 */
export function parseBombino(payload: unknown, raw: string): CarrierResult {
  const number = normalizeBombinoNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Bombino Express returned an invalid reply');
  checkErrors(payload);
  const details = list(payload, 'docket_info');
  const asked = text(payload, 'tracking_no', 64) || detail(details, 'awb no.');
  if (!asked) throw new SchemaError(PROVIDER, 'Bombino Express returned a shipment without its number');
  if (normalizeTrackingNumber(asked) !== number) throw new IndeterminateError(PROVIDER, 'Bombino Express answered for another shipment');
  const rows = list(payload, 'docket_events');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Bombino Express returned an oversized history');
  const names = ['consignee name', 'receiver name'].map((label) => detail(details, label)).filter((name) => name.length >= 3)
    .map((name) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, 'giu'));

  const seen = new Set<string>();
  const scans: CarrierEvent[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Bombino Express returned an invalid scan');
    const scan = projectRow(row, names);
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    scans.push(scan.event);
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first by wall clock, as the page sorts them; scans of the same second keep the reply's order.
  if (listsNewestFirst(scans) === false) scans.reverse();
  const clock = (event: CarrierEvent) => event.local_time as string;
  const events = scans.sort((left, right) => (clock(left) === clock(right) ? 0 : clock(left) < clock(right) ? 1 : -1));

  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const destination = text(payload, 'consignee_country', 80) || detail(details, 'destination');
  const country = countryCode(destination);
  const expected = stage === 'delivered' || stage === 'returned' ? null : estimate(payload);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: expected,
    ...(country ? { destination_country: country } : destination ? { destination_country_name: destination } : {}),
    ...forwarding(payload, details, number),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
