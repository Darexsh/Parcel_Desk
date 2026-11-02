import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime, zonedTime, type ParsedTime } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { exelotCodeKey, exelotStage } from './status.js';

export const PROVIDER = 'Exelot';
// A long history is a few kilobytes.
export const EXELOT_MAX_BYTES = 256 * 1024;
const NUMBER = /^XLT\d{9}$/;
// The tracker page's own checks: an ISO clock with its offset, and the clock it prints, which it reads in UTC.
const ISO_CLOCK = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:?\d{2})$/;
const PRINTED_CLOCK = /^\d{1,2} [A-Za-z]{3} \d{4}, (?:0?[1-9]|1[0-2]):[0-5]\d (?:AM|PM)$/i;
// A town and its country code, or a country code alone, as Exelot names the places of its scans.
const PLACE = /^(?:\p{L}[\p{L}\p{M} .'’-]{0,58} )?[A-Z]{2}$/u;
const CODE = /^[0-9A-Z][0-9A-Z-]{0,11}$/i;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** An Exelot number as its tracker looks it up: `XLT` and nine digits. */
export function normalizeExelotNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Exelot numbers are XLT and nine digits');
  return number;
}

function scanTime(row: Record<string, unknown>): ParsedTime {
  const iso = clean(row.dateISO, 40);
  const parsed = ISO_CLOCK.test(iso) ? explicitOffsetTime(iso.replace(/[ t]/, 'T')) : null;
  if (parsed) return parsed;
  // A scan without its ISO clock keeps the one the page prints, in UTC as the page reads it;
  // where a scan has both, they agree.
  const printed = clean(row.date, 40);
  const legacy = PRINTED_CLOCK.test(printed) ? zonedTime(printed, 'd MMM yyyy, h:mm a', 'UTC', { locale: 'en' }) : null;
  if (!legacy) throw new SchemaError(PROVIDER, 'Exelot returned an invalid scan time');
  return legacy;
}

/**
 * The place of a scan. A delivery, a refusal or an attempt happens at the
 * recipient's address, so its place is not kept; elsewhere only a town with its
 * country code, or a country code, is.
 */
function place(value: unknown, code: string, stage: Stage | undefined): string {
  if (stage === 'delivered' || stage === 'failed_attempt' || exelotCodeKey(code) === '67') return '';
  const text = clean(value, 64);
  return PLACE.test(text) ? text : '';
}

function scan(row: unknown): { timestamp: number; event: CarrierEvent } {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Exelot returned an invalid scan');
  const description = clean(row.statusText, 200);
  if (!description) throw new SchemaError(PROVIDER, 'Exelot returned a scan without its status');
  const main = cleanScalar(row.statusCode, 16);
  const sub = cleanScalar(row.statusSubCode, 16);
  if ((main && !CODE.test(main)) || (sub && (!main || !CODE.test(sub)))) {
    throw new SchemaError(PROVIDER, 'Exelot returned an invalid status code');
  }
  // The page names a scan's status by its code and sub-code together, as `42_14`.
  const code = sub ? `${main}_${sub}` : main;
  const stage = code ? exelotStage(code) : undefined;
  const location = place(row.statusLocations, code, stage);
  const { iso, timestamp } = scanTime(row);
  return { timestamp, event: {
    time: iso,
    description,
    ...(location ? { location } : {}),
    ...(code ? { provider_code: code } : {}),
    ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
  } };
}

/** The pickup point the page shows: its name, then its street and town. */
function pickupPoint(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const name = clean(value.name, 120);
  if (!name) return undefined;
  const address = isRecord(value.address) ? value.address : {};
  const street = [clean(address.stAddress, 120), cleanScalar(address.houseNumber, 16)].filter(Boolean).join(' ');
  return [name, street, clean(address.city, 80)].filter(Boolean).join('\n');
}

/**
 * The reply of the lookup Exelot's tracker page makes,
 * `GET apiv2p.exelot.com/api/v2/parcels/tracking/details/{number}`: one parcel
 * per number asked. A number Exelot does not have comes back with its `id` and
 * `parcelStatus: "notFound"`. A parcel it has carries its scans newest first,
 * each with a code, an optional sub-code, its English wording, an ISO clock
 * with its offset and the place of the scan.
 */
export function parseExelot(payload: unknown, raw: string): CarrierResult {
  const number = normalizeExelotNumber(raw);
  if (!Array.isArray(payload) || !payload.length || !payload.every((item) => isRecord(item) && typeof item.id === 'string')) {
    throw new SchemaError(PROVIDER, 'Exelot returned a reply that is not a parcel');
  }
  const parcel = payload[0] as Record<string, unknown>;
  // One number was asked; the one parcel answered must be that number.
  if (payload.length > 1 || normalizeTrackingNumber(parcel.id as string) !== number
    || (parcel.xltID !== undefined && (typeof parcel.xltID !== 'string' || normalizeTrackingNumber(parcel.xltID) !== number))) {
    throw new IndeterminateError(PROVIDER, 'Exelot answered for another parcel');
  }
  const history = parcel.statusHistory;
  if (parcel.parcelStatus === 'notFound') {
    if (Array.isArray(history) && history.length) throw new SchemaError(PROVIDER, 'Exelot returned scans for a parcel it did not find');
    throw new NotFoundError(PROVIDER);
  }
  if (!Array.isArray(history)) throw new SchemaError(PROVIDER, 'Exelot returned a parcel without its history');
  if (history.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Exelot returned an oversized history');
  if (!history.length) throw new NoHistoryError(PROVIDER, 'Exelot has no scans for the parcel yet');
  // Newest first; scans at the same instant keep the reply's order.
  const events = history.map((row, index) => ({ ...scan(row), index }))
    .sort((a, b) => b.timestamp - a.timestamp || a.index - b.index)
    .map(({ event }) => event);
  const newest = events[0]!;
  const stage = events.find((event) => event.stage)?.stage as Stage | undefined;
  const delivery = stage === 'delivered' ? events.find((event) => event.stage === 'delivered') : undefined;
  const destination = clean(parcel.destinationCountry, 3).toUpperCase();
  const pickup = pickupPoint(parcel.pudoPoint);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(delivery?.time ? { delivered_at: delivery.time } : {}),
    ...(/^[A-Z]{2}$/.test(destination) ? { destination_country: destination } : {}),
    ...(pickup ? { pickup_point: pickup } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
