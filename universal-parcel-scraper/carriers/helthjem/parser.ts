import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { hasGs1CheckDigit } from '../../core/detection/numericChecksums.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { helthjemCode, helthjemLabel, helthjemStage, STATE } from './status.js';

export const PROVIDER = 'Helthjem';
// A parcel's reply is a few kilobytes.
export const HELTHJEM_MAX_BYTES = 256_000;

const MAX_ROWS = 500;
const MAX_EVENTS = 100;
const EVENT_CODE = /^\d{1,4}$/;
const IDENTIFIER = /^\d{17,20}$/;
// The states of a home delivery sent on to a pickup point.
const TO_POINT: ReadonlySet<string> = new Set(['CONVERTED_TO_STORE', 'DELIVERING_TO_STORE', 'READY_FOR_PICKUP', 'PICKED_UP']);

/** The number as Helthjem's search takes it, and the identifier the reply names. */
export interface HelthjemNumber {
  /** Sent as typed, without spaces: the service echoes it. */
  readonly reference: string;
  /** The SSCC without its 00, or the shipment number without its 401. */
  readonly identifier: string;
}

/**
 * Helthjem's search takes a parcel's SSCC, with or without the 00 of its GS1
 * identifier, and the seventeen-digit shipment number, with or without the
 * 401 in front. Both end in a GS1 check digit.
 */
export function normalizeHelthjemNumber(raw: string): HelthjemNumber {
  const reference = normalizeTrackingNumber(raw);
  const identifier = /^00\d{18}$/.test(reference) ? reference.slice(2)
    : /^401\d{17}$/.test(reference) ? reference.slice(3)
      : /^\d{17,18}$/.test(reference) ? reference : '';
  if (!identifier || !hasGs1CheckDigit(identifier)) {
    throw new InvalidInputError(PROVIDER, 'Helthjem tracks SSCCs and seventeen-digit shipment numbers');
  }
  return { reference, identifier };
}

const withoutSsccPrefix = (value: string) => (/^00\d{18}$/.test(value) ? value.slice(2) : value);

/**
 * GraphQL can answer with errors beside data. Errors inside the parcel only
 * blank the fields they name; any other error fails the lookup. A query the
 * service no longer accepts is a schema change.
 */
function parcelOf(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Helthjem did not return a tracking reply');
  const errors = payload.errors ?? [];
  if (!Array.isArray(errors)) throw new SchemaError(PROVIDER, 'Helthjem returned invalid errors');
  const data = payload.data;
  const parcel = isRecord(data) ? data.getParcelTrackingDetails : undefined;
  if (errors.length) {
    const local = isRecord(parcel) && errors.every(error => isRecord(error) && Array.isArray(error.path)
      && error.path.length > 1 && error.path[0] === 'getParcelTrackingDetails');
    if (!local) {
      const codes = errors.map(error => (isRecord(error) && isRecord(error.extensions) ? clean(error.extensions.code, 64) : ''));
      if (codes.some(code => code === 'GRAPHQL_VALIDATION_FAILED' || code === 'GRAPHQL_PARSE_FAILED')) {
        throw new SchemaError(PROVIDER, 'Helthjem no longer accepts the tracking query');
      }
      throw new IndeterminateError(PROVIDER, 'Helthjem could not complete the tracking query');
    }
  }
  if (parcel === null) return null;
  if (!isRecord(parcel)) throw new SchemaError(PROVIDER, 'Helthjem did not return a parcel');
  return parcel;
}

interface Scan { readonly event: CarrierEvent; readonly state: string; readonly at: number; readonly index: number }

const MONTHS = ['januar', 'februar', 'mars', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'desember'];
// Code 113 books the parcel on a night round: "Planlagt levering natt til 24. oktober!".
const NIGHT = new RegExp(`\\bnatt til (\\d{1,2})\\. (${MONTHS.join('|')})\\b`, 'i');
const BOOKING = 'DELIVERING/113';

/**
 * The day the night round a booking scan names ends on. The wording gives a
 * day and a month; the year is the scan's own, or the next one for a booking
 * made in December for January.
 */
function bookedNight({ provider_code: code, description, time }: CarrierEvent): string | null {
  const match = code === BOOKING && description && time ? NIGHT.exec(description) : null;
  if (!match || !time) return null;
  const month = MONTHS.indexOf(match[2]!.toLowerCase()) + 1;
  const year = Number(time.slice(0, 4)) + (month < Number(time.slice(5, 7)) ? 1 : 0);
  return calendarDay(year, month, Number(match[1]));
}

/** A delivery is often scanned twice, seconds apart: the first scan of the latest run delivered it. */
function deliveredAt(events: readonly CarrierEvent[]): string | undefined {
  let index = events.findIndex(event => event.stage === 'delivered');
  if (index < 0) return undefined;
  while (events[index + 1]?.stage === 'delivered') index += 1;
  return events[index]!.time;
}

/**
 * The tracking service's reply for one number: the parcel's state, its scans
 * newest first, each with a state, an event code, Norwegian wording and a
 * clock with its offset, and the shop and pickup point. A number it does not
 * know, or no longer keeps, comes back as null.
 */
export function parseHelthjem(payload: unknown, rawNumber: string): CarrierResult {
  const { reference, identifier } = normalizeHelthjemNumber(rawNumber);
  const parcel = parcelOf(payload);
  if (!parcel) throw new NotFoundError(PROVIDER);
  const named = [parcel.trackingNumber, parcel.shipmentNumber].map(value => withoutSsccPrefix(clean(value, 40)));
  // A home delivery sent on to a pickup point is relabelled: the reply names the new label, while
  // the number asked still finds the parcel and comes back as its reference.
  const relabelled = !named.includes(identifier);
  if (relabelled && clean(parcel.parcelReference, 40) !== reference) throw new SchemaError(PROVIDER, 'Helthjem answered for a different parcel');

  const rows = parcel.events ?? [];
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Helthjem returned an invalid parcel history');
  const state = clean(parcel.status, 40);
  if (state && !STATE.test(state)) throw new SchemaError(PROVIDER, 'Helthjem returned an invalid parcel state');

  const scans: Scan[] = [];
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Helthjem returned an invalid scan');
    const at = explicitOffsetTime(row.createdAt);
    const rowState = clean(row.status, 40);
    const code = clean(row.apiKey, 8);
    if (!at || (rowState && !STATE.test(rowState)) || (code && !EVENT_CODE.test(code)) || (!rowState && !code)) {
      throw new SchemaError(PROVIDER, 'Helthjem returned a scan without a state, code or clock');
    }
    const providerCode = helthjemCode(rowState, code);
    const description = (isRecord(row.message) ? clean(row.message.content, 300) : '') || helthjemLabel(rowState) || providerCode;
    const location = clean(row.location, 80);
    const stage = helthjemStage(rowState, code);
    const event: CarrierEvent = { time: at.iso, description, ...(location ? { location } : {}), provider_code: providerCode,
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    const identity = JSON.stringify(event);
    if (seen.has(identity)) return;
    seen.add(identity);
    scans.push({ event, state: rowState, at: at.timestamp, index });
  });
  if (relabelled && !TO_POINT.has(state) && !scans.some(scan => TO_POINT.has(scan.state) || /\bhentested\b/i.test(scan.event.description ?? ''))) {
    throw new SchemaError(PROVIDER, 'Helthjem answered for a different parcel');
  }
  // Newest first; scans at the same instant keep the reply's order.
  scans.sort((left, right) => right.at - left.at || left.index - right.index);
  const events = scans.map(scan => scan.event);
  const newest = events[0];

  // The page headlines the parcel's state; the newest scan stands in without
  // one, and the newest scan in that state for it, since its event code can
  // say more than the state.
  const own = state ? scans.find(scan => scan.state === state)?.event.stage as Stage | undefined : undefined;
  const stateStage = !state ? undefined : own ?? helthjemStage(state);
  if (!newest && !state) throw new IndeterminateError(PROVIDER, 'Helthjem returned a parcel without a state or scans');
  const stage = stateStage ?? (newest?.stage as Stage | undefined);
  const delivered = stage === 'delivered' ? deliveredAt(events) : undefined;
  // The night a booking names, while no scan but a terminal's has followed it.
  const booking = scans.find(scan => scan.state !== 'IN_TRANSIT')?.event;
  const night = booking && stage === 'in_transit' ? bookedNight(booking) : null;
  // The point a parcel waits at, or was collected from, by its name alone.
  const point = state === 'READY_FOR_PICKUP' || state === 'PICKED_UP'
    ? (isRecord(parcel.servicePoint) ? clean(parcel.servicePoint.name, 160) : '') : '';
  const shop = isRecord(parcel.shop) ? clean(parcel.shop.name, 120) : '';
  // The page sends a PostNord parcel's recipient to PostNord's tracker with the shipment number.
  const shipment = clean(parcel.shipmentNumber, 40);
  const postnord = parcel.isPostnordProduct === true && IDENTIFIER.test(shipment);
  // The new label a relabelled parcel is tracked as, its SSCC, else its shipment number.
  const label = relabelled ? named.find(value => /^\d{17,18}$/.test(value) && hasGs1CheckDigit(value)) : undefined;

  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest?.description ?? (helthjemLabel(state) || state),
    ...(events.length ? {} : { provider_code: state, summary_only: true }),
    last_update: newest?.time ?? null,
    expected_delivery: night,
    ...(delivered ? { delivered_at: delivered } : {}),
    ...(point ? { pickup_point: point } : {}),
    ...(shop ? { sender_name: shop } : {}),
    ...(postnord ? { delivery_carrier: 'postnord', delivery_tracking_number: shipment } : {}),
    ...(label ? { canonical_tracking_number: label } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
