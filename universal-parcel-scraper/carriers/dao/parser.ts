import { returnedTrackingNumber } from '../../core/detection/returned.js';
import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { isValidSscc, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { CODE, daoCode, daoStage } from './status.js';

export const PROVIDER = 'DAO';
// A parcel's reply is a few kilobytes.
export const DAO_MAX_BYTES = 256_000;

const MAX_ROWS = 300;
const MAX_EVENTS = 200;
// The backend's clock, a wall time without an offset: "2026-10-06 23:24:15".
const CLOCK = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/;
const LEG = /^[A-Za-z]{1,20}$/;
const EVENT = /^\d{1,4}$/;

/** A number as DAO's tracker takes it. */
export interface DaoNumber {
  readonly number: string;
  /**
   * A nine-digit e-label code or a thirteen-digit parcel number, which the
   * tracker may answer with the parcel's SSCC.
   */
  readonly alias: boolean;
}

/**
 * DAO's tracker takes its twenty-digit SSCCs, thirteen-digit parcel numbers
 * starting with 7 and the nine-digit e-label code a sender writes on a parcel
 * without a label. An SSCC must pass its check digit.
 */
export function normalizeDaoNumber(raw: string): DaoNumber {
  const number = normalizeTrackingNumber(raw);
  if (/^00\d{18}$/.test(number) && isValidSscc(number)) return { number, alias: false };
  if (/^(?:7\d{12}|\d{9})$/.test(number)) return { number, alias: true };
  throw new InvalidInputError(PROVIDER, 'DAO tracks twenty-digit SSCCs, thirteen-digit numbers starting with 7 and nine-digit e-label codes');
}

/** The parcel number the reply names, in the forms DAO issues. */
function issued(value: unknown): string {
  const barcode = returnedTrackingNumber(value, true);
  return /^(?:00\d{18}|7\d{12}|\d{9})$/.test(barcode) ? barcode : '';
}

/** A clock as a wall time, validated. The reply gives no offset. */
function wallClock(value: unknown): string | null {
  const match = CLOCK.exec(clean(value, 32));
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  if (!calendarDay(Number(year), Number(month), Number(day)) || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
}

interface Scan { readonly event: CarrierEvent; readonly local: string }

/**
 * One row of the parcel's history, from the `raw` record the page's service
 * passes through from DAO's backend: its clock, leg, event number, wording and
 * place. A home delivery's scan has no wording of its own: the delivered text
 * is in its place field.
 */
function scanOf(row: unknown): Scan {
  const raw = isRecord(row) ? row.raw : undefined;
  if (!isRecord(raw)) throw new SchemaError(PROVIDER, 'DAO returned a scan without its record');
  const local = wallClock(raw.tidspunkt);
  const leg = clean(raw.pakketype, 24);
  const event = cleanScalar(raw.haendelse, 8);
  if (!local || !EVENT.test(event) || (leg && !LEG.test(leg))) throw new SchemaError(PROVIDER, 'DAO returned a scan without its clock or event');
  const wording = clean(raw.beskrivelse, 300);
  const place = clean(raw.sted, 120);
  const description = wording || place;
  if (!description) throw new SchemaError(PROVIDER, 'DAO returned a scan without wording');
  const code = daoCode(leg, event);
  if (!CODE.test(code)) throw new SchemaError(PROVIDER, 'DAO returned an invalid event code');
  const stage = daoStage(code);
  return {
    local,
    event: { local_time: local, description, ...(wording && place ? { location: place } : {}), provider_code: code,
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}) },
  };
}

/** The partner and number a parcel sent abroad is tracked under, as the page links them. */
function abroad(parcel: Record<string, unknown>, number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const partnerNumber = returnedTrackingNumber(parcel.dist_barcode);
  if (!/^[A-Z0-9]{4,40}$/.test(partnerNumber) || partnerNumber === number) return {};
  const partner = carrierIdFromPartner('', clean(parcel.external_tracking, 500));
  return { delivery_tracking_number: partnerNumber, ...(partner && partner !== 'dao' ? { delivery_carrier: partner } : {}) };
}

/**
 * The reply of DAO's tracking page service for one number: `{"found":false}`
 * for a number it does not know, else the parcel with its number, its scans
 * newest first, the pickup point and, for a parcel sent abroad, the partner's
 * number and tracking link. The masked sender and recipient, the recipient's
 * postcode and the pickup point's address, opening hours and coordinates are
 * never read.
 */
export function parseDao(payload: unknown, raw: string): CarrierResult {
  const { number, alias } = normalizeDaoNumber(raw);
  if (!isRecord(payload) || typeof payload.found !== 'boolean') throw new SchemaError(PROVIDER, 'DAO returned an unexpected reply');
  if (!payload.found) throw new NotFoundError(PROVIDER);
  // The page shows its not-found notice for this too, but no reply showed one.
  if (!isRecord(payload.parcel)) throw new IndeterminateError(PROVIDER, 'DAO returned no parcel for a number it knows');
  const parcel = payload.parcel;
  const barcode = issued(parcel.barcode);
  // An e-label code or a thirteen-digit number may be answered with the parcel's SSCC.
  if (barcode !== number && !(alias && barcode)) throw new SchemaError(PROVIDER, 'DAO answered for a different parcel');

  const rows = parcel.events ?? [];
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'DAO returned an invalid parcel history');
  const seen = new Set<string>();
  const scans = rows.map(scanOf).filter(({ event }) => {
    // A consignment's parcels can repeat one scan.
    const identity = JSON.stringify(event);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the reply lists them.
  if (listsNewestFirst(scans.map(({ event }) => event)) === false) scans.reverse();
  scans.sort((left, right) => (left.local < right.local ? 1 : left.local > right.local ? -1 : 0));
  const events = scans.map(({ event }) => event);
  const newest = events[0]!;
  const stage = newest.stage as Stage | undefined;
  // The daoSHOP the parcel goes to or waits at, by its name alone.
  const point = isRecord(parcel.pickup) ? clean(parcel.pickup.name, 160) : '';

  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time!,
    expected_delivery: null,
    ...(barcode !== number ? { canonical_tracking_number: barcode } : {}),
    ...(point ? { pickup_point: point } : {}),
    ...abroad(parcel, barcode),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
