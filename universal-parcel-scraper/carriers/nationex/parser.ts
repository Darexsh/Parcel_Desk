import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { nationexQuiet, nationexStage, nationexStateLabel, nationexStateStage } from './status.js';

export const PROVIDER = 'Nationex';
// A parcel takes about ten kilobytes, most of it the tracker's help texts.
export const NATIONEX_MAX_BYTES = 4_000_000;
// A shipment number is nine digits; each parcel's number adds its two-digit
// position in the shipment. The tracker also takes delivery-notice and sender
// reference numbers, which its reply does not name.
const SHIPMENT = /^\d{9}$/;
const PARCEL = /^\d{11}$/;
// The service's whole answer to a number it does not know.
const NOT_FOUND = 'Sorry, no results.';
const CLOCK = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,7})?$/;
const DAY = /^(\d{4}-\d{2}-\d{2})(?:T00:00:00)?$/;
const MAX_PARCELS = 300;
const MAX_ROWS = 3000;
const MAX_EVENTS = 100;
// Stages whose expected day the tracker shows: it says the date is still to
// come before the pickup, and shows none once the parcel is delivered, returned
// or held up.
const ESTIMATED: ReadonlySet<Stage> = new Set(['accepted', 'in_transit', 'out_for_delivery']);
// States the tracker shows as a problem, or a cancellation, when they are the
// newest of the state history, even before the state itself follows.
const ALERTS: ReadonlySet<string> = new Set(['Attention', 'RefusedDelivery', 'PickupAttemptFailed', 'Cancelled', '500', '501']);
// Stages a scan can report after the state's step without the state changing.
const PROBLEMS: ReadonlySet<Stage> = new Set(['failed_attempt', 'exception']);
// States that end the shipment's journey; no scan overrides them.
const SETTLED: ReadonlySet<Stage> = new Set(['delivered', 'returned', 'exception']);

/** A Nationex shipment (nine digits) or parcel (eleven digits) number; anything else is not one the adapter can look up. */
export function normalizeNationexNumber(raw: string): string {
  // The tracker's search box drops a leading "#", as the reply prints numbers.
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw.trim().replace(/^#/, '')) : '';
  if (!SHIPMENT.test(number) && !PARCEL.test(number)) {
    throw new InvalidInputError(PROVIDER, 'Nationex tracks nine-digit shipment and eleven-digit parcel numbers');
  }
  return number;
}

/** An optional text or number field; an object, array or other value is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 500): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' && typeof value !== 'number') throw new SchemaError(PROVIDER, `Nationex returned an invalid ${key}`);
  return cleanScalar(value, maxLength);
}

/** A scan's clock as the wall time it prints, without an offset. */
function wallClock(value: string): string | null {
  const match = CLOCK.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  // UTC only checks the calendar fields; no offset is assigned. Luxon accepts hour 24.
  const parsed = DateTime.fromObject({ year, month, day, hour, minute, second }, { zone: 'UTC' });
  return parsed.isValid && hour! < 24 && year! >= 2000 ? parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") : null;
}

interface Scan {
  readonly event: CarrierEvent & { local_time: string; description: string };
  readonly code: string;
}

/**
 * One parcel's scans: the clock, the code, the depot that scanned it and the
 * English wording. The handheld's position, the person who signed or handed
 * the parcel over, and the photo and signature ids on the same rows are never
 * read.
 */
function parcelScans(parcel: Record<string, unknown>): Scan[] {
  const rows = parcel.History;
  if (rows === null || rows === undefined) return [];
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Nationex returned an invalid parcel history');
  return rows.map((row: unknown) => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Nationex returned an invalid scan');
    const local = wallClock(text(row, 'ProcessedDate', 40));
    const description = text(row, 'DescriptionEn') || text(row, 'DescriptionFr');
    if (!local || !description) throw new SchemaError(PROVIDER, 'Nationex returned a scan without a clock or wording');
    const code = text(row, 'ExceptionId', 16);
    const depot = text(row, 'CityDepot', 100);
    const event: Scan['event'] = { local_time: local, description,
      ...(depot ? { location: depot } : {}), ...(code ? { provider_code: code } : {}) };
    return { event, code };
  });
}

/** The latest expected day of the parcels in view, while the tracker would show one and no newer day's scan has come. */
function expectedDay(parcels: readonly Record<string, unknown>[], stage: Stage | undefined, newest: string | undefined): string | null {
  if (!stage || !ESTIMATED.has(stage)) return null;
  let latest = '';
  for (const parcel of parcels) {
    const day = DAY.exec(text(parcel, 'EstimatedDeliveryDate', 40))?.[1] ?? '';
    if (day && DateTime.fromISO(day, { zone: 'UTC' }).isValid && day > latest) latest = day;
  }
  return latest && (!newest || latest >= newest.slice(0, 10)) ? latest : null;
}

/**
 * The state Nationex keeps for the shipment, or a parcel, as its tracker reads
 * it: the newest entry of the state history wins when it is a problem or a
 * cancellation and the state is not a delivery. Only the state names of the
 * history are read, not their dates or places.
 */
function currentState(holder: Record<string, unknown>, key: string, historyKey: string, historyField: string): string {
  const state = text(holder, key, 64);
  const history = holder[historyKey];
  if (history === null || history === undefined) return state;
  if (!Array.isArray(history) || history.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Nationex returned an invalid state history');
  const last: unknown = history.at(-1);
  if (last === undefined) return state;
  if (!isRecord(last)) throw new SchemaError(PROVIDER, 'Nationex returned an invalid state history');
  const latest = text(last, historyField, 64);
  return ALERTS.has(latest) && nationexStateStage(state) !== 'delivered' ? latest : state;
}

/**
 * A reply of `GET /api/nationex/get-shipment/{number}` that is not a shipment:
 * the not-found notice, or the error the site's API returns when the lookup
 * failed, such as Nationex's own service being out of reach.
 */
function notShipment(payload: Record<string, unknown>): never {
  if (payload.code === 404 && clean(payload.message, 100) === NOT_FOUND) throw new NotFoundError(PROVIDER);
  if ('message' in payload || 'code' in payload || 'status' in payload) {
    throw new IndeterminateError(PROVIDER, 'Nationex could not look the shipment up');
  }
  throw new SchemaError(PROVIDER, 'Nationex returned an unexpected reply');
}

/**
 * The shipment the tracker's service returns for a number. It searches
 * shipment, parcel, delivery-notice and sender reference numbers alike, so the
 * reply counts only when its shipment number, or one of its parcel numbers,
 * is the one requested. A shipment number covers every parcel in it; a parcel
 * number only that parcel. The recipient's postcode, town, address and map
 * position, the driver's position, the sender, references, weights, notes and
 * the tracker's help texts are never read.
 */
export function parseNationex(payload: unknown, raw: string): CarrierResult {
  const number = normalizeNationexNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Nationex returned an unexpected reply');
  if (!('ShipmentId' in payload)) notShipment(payload);
  const shipment = text(payload, 'ShipmentId', 20);
  const parcels = payload.Parcels;
  if (!SHIPMENT.test(shipment) || !Array.isArray(parcels) || parcels.length > MAX_PARCELS || !parcels.every(isRecord)) {
    throw new SchemaError(PROVIDER, 'Nationex returned an unexpected shipment');
  }
  const byParcel = PARCEL.test(number);
  const scope = byParcel ? parcels.filter((parcel) => text(parcel, 'ParcelId', 20) === number) : parcels;
  if (byParcel ? scope.length !== 1 : shipment !== number) {
    // The number is another shipment's delivery notice or sender reference.
    throw new IndeterminateError(PROVIDER, 'Nationex answered with a shipment the number does not identify');
  }

  // Each parcel of a shipment repeats the scans they share; identical rows are kept once.
  const seen = new Set<string>();
  const scans: Scan[] = [];
  for (const parcel of scope) {
    for (const { event, code } of parcelScans(parcel)) {
      const key = JSON.stringify(event);
      if (seen.has(key)) continue;
      seen.add(key);
      const stage = nationexStage(code, event.description);
      if (stage) Object.assign(event, { stage: stage.stage, stage_source: stage.source });
      scans.push({ event, code });
    }
    if (scans.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Nationex returned too many scans');
  }
  // Newest first; equal clocks keep the reply's order.
  if (listsNewestFirst(scans.map(({ event }) => event)) === false) scans.reverse();
  scans.sort((left, right) => right.event.local_time > left.event.local_time ? 1
    : right.event.local_time < left.event.local_time ? -1 : 0);

  // The state Nationex keeps for the shipment, or for the parcel asked for, is
  // the step its tracker shows; for a shipment of several parcels it says when
  // only some are delivered. The scans decide when the state is unknown, and a
  // problem scan stands until the shipment is settled.
  const state = byParcel ? currentState(scope[0]!, 'Status', 'ParcelStatusHistories', 'ParcelStatus')
    : currentState(payload, 'ShipmentStatus', 'StatusHistories', 'ShipmentStatus');
  const stateStage = nationexStateStage(state);
  // A message to the recipient or a photo moves nothing.
  const moving = scans.find((scan) => !nationexQuiet(scan.code))?.event ?? scans[0]?.event;
  const scanStage = moving?.stage as Stage | undefined;
  const byScan = !stateStage || (!SETTLED.has(stateStage) && !!scanStage && PROBLEMS.has(scanStage));
  const stage = byScan ? scanStage : stateStage;
  const source = byScan ? moving?.stage_source : 'carrier_map';
  const events = scans.map((scan) => scan.event);
  const newest = events[0];
  const expected = expectedDay(scope, stage, newest?.local_time);

  if (!newest) {
    if (!stateStage) throw new NoHistoryError(PROVIDER);
    return { status: languageStageStatus(stateStage), current_stage: stateStage, current_stage_source: 'carrier_map',
      last_status_text: nationexStateLabel(state), last_update: null, expected_delivery: expected, summary_only: true, events: [] };
  }
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source } : {}),
    // When the state outranks the newest scan, its name says why.
    last_status_text: !byScan && stage !== scanStage ? nationexStateLabel(state) : moving!.description,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: expected,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
