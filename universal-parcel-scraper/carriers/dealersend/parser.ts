import { DateTime } from 'luxon';
import { detectCarrierMatch, normalizeTrackingNumber, uspsPackageIdentifier } from '../../core/detection/index.js';
import { USPS_ROUTING_BARCODE } from '../../core/detection/usps.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, firstOccurrence } from '../../core/time/index.js';
import { cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { dealerSendStage } from './status.js';

export const PROVIDER = 'DealerSend';
export const CARRIER = 'dealersend';
// A long history is a few kilobytes.
export const DEALERSEND_MAX_BYTES = 256 * 1024;
// The tracker is asked for letters and digits; the shipment it answers with must name the number asked.
const NUMBER = /^[A-Z0-9]{6,40}$/;
// A wall clock as the tracker writes it, sometimes with a fraction of a second.
const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(:\d{2})?(?:\.\d{1,7})?$/;
// The earliest clock on Earth: a wall clock still ahead of the read on it is not a scan yet.
const EARLIEST_ZONE = 'UTC+14';
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
// A delivering partner named in the rows it relays, when the partner's number fits that carrier.
const NAMED_PARTNERS: readonly (readonly [RegExp, string])[] = [[/\bgofo\b/i, 'gofo']];

/** A number DealerSend's tracker can be asked for; anything else is refused before the lookup. */
export function normalizeDealerSendNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'DealerSend looks parcels up by 6 to 40 letters and digits');
  return number;
}

/** An optional text field; an object or array is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 500): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' && typeof value !== 'number') throw new SchemaError(PROVIDER, `DealerSend returned an invalid ${key}`);
  return cleanScalar(value, maxLength);
}

/** A row's wall clock to the second, or null when it has none; a clock that does not read back is a changed reply. */
function wallClock(raw: string): string | null {
  if (!raw) return null;
  const match = WALL_CLOCK.exec(raw);
  const local = match ? `${match[1]}${match[2] ?? ':00'}` : '';
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  const read = local ? DateTime.fromISO(local, { zone: 'UTC' }) : null;
  if (!read?.isValid || read.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) throw new SchemaError(PROVIDER, 'DealerSend returned an invalid scan time');
  return local;
}

/**
 * A row's place: its name without postcodes or street numbers, each part
 * once, then its country code unless the name ends with that country.
 * "TOWN, ST, 00000" under US is "TOWN, ST, US"; a row with only a country is
 * that code.
 */
function placeOf(row: Record<string, unknown>): string {
  const region = text(row, 'region', 8).toUpperCase();
  const country = /^[A-Z]{2}$/.test(region) && countryCode(region) === region ? region : '';
  const parts: string[] = [];
  for (const raw of text(row, 'regionName', 200).split(',')) {
    const words = raw.trim().split(/\s+/);
    const cut = words.findIndex((word) => /\d/.test(word));
    const part = (cut < 0 ? words : words.slice(0, cut)).join(' ');
    if (part && part.toUpperCase() !== parts.at(-1)?.toUpperCase()) parts.push(part);
  }
  if (country && (!parts.length || countryCode(parts.at(-1)) !== country)) parts.push(country);
  return parts.join(', ');
}

interface Scan { index: number; local: string; ahead: boolean; event: CarrierEvent }

function scanOf(row: unknown, index: number, readAt: number): Scan | null {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'DealerSend returned an invalid scan');
  const local = wallClock(text(row, 'localTime', 64));
  const description = text(row, 'statusDescription');
  // The tracking page leaves out a row without a time, and so does the adapter.
  if (!local || !description) return null;
  const code = text(row, 'status', 64);
  const location = placeOf(row);
  const staged = dealerSendStage(code || null, description);
  const event: CarrierEvent = {
    local_time: local,
    description,
    ...(location ? { location } : {}),
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { index, local, ahead: firstOccurrence(DateTime.fromISO(local, { zone: EARLIEST_ZONE })).toMillis() > readAt, event };
}

/** The scalar numbers the tracker lists under `externalTrackingNumbers`, as an object or an array. */
function externalNumbers(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  const listed = Array.isArray(value) ? value : isRecord(value) ? Object.values(value) : null;
  if (!listed || listed.length > 20) throw new SchemaError(PROVIDER, 'DealerSend returned invalid partner numbers');
  return listed.flatMap((entry) => typeof entry === 'string' || typeof entry === 'number' ? [normalizeTrackingNumber(String(entry)).toUpperCase()] : []);
}

/**
 * The delivering partner's number, when the tracker lists exactly one other
 * than the number asked. A whole USPS package barcode is USPS's. A routing
 * barcode keeps its package identifier, or nothing when that is unclear, so
 * that its ZIP code goes nowhere. Another partner is named only when its rows
 * name it and the number fits that carrier.
 */
function partnerOf(value: unknown, number: string, wording: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const numbers = [...new Set(externalNumbers(value).filter((other) => other !== number && NUMBER.test(other)))];
  if (numbers.length !== 1) return {};
  const partner = numbers[0]!;
  const usps = uspsPackageIdentifier(partner);
  if (usps) return { delivery_carrier: 'usps', delivery_tracking_number: usps };
  if (USPS_ROUTING_BARCODE.test(partner)) return {};
  const named = NAMED_PARTNERS.find(([name, carrier]) => name.test(wording) && (detectCarrierMatch(partner).candidates as string[]).includes(carrier));
  return { ...(named ? { delivery_carrier: named[1] } : {}), delivery_tracking_number: partner };
}

/** The one shipment of a reply, keyed by the number asked; null when the tracker does not know it. */
function shipmentFor(payload: unknown, number: string): Record<string, unknown> | null {
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'DealerSend returned an invalid tracking reply');
  const keys = Object.keys(payload);
  if (keys.length !== 1 || keys[0] !== number) throw new IndeterminateError(PROVIDER, 'DealerSend answered for another parcel');
  const shipment = payload[number];
  if (shipment === null) return null;
  if (!isRecord(shipment)) throw new SchemaError(PROVIDER, 'DealerSend returned an invalid shipment');
  if (normalizeTrackingNumber(text(shipment, 'trackingNumber', 64)).toUpperCase() !== number) {
    throw new IndeterminateError(PROVIDER, 'DealerSend answered for another parcel');
  }
  return shipment;
}

/**
 * The reply of `GET /myapi/trackings/track?trackingNumbers=<n>`, the lookup
 * DealerSend's tracking page makes: an object keyed by the number asked, with
 * null for a number the tracker does not know, else the shipment with its
 * service, its destination, the partner's numbers and its rows. A row has a
 * wall clock without an offset, a status (a GUID for DealerSend's own rows,
 * the partner's code for the rows it relays), its wording, and a country code
 * and place name. The rows keep their wall clocks; the sender's country, the
 * carrier's name and logo and the latest status repeated on the shipment are
 * not read.
 */
export function parseDealerSend(payload: unknown, raw: string, readAt = Date.now()): CarrierResult {
  const number = normalizeDealerSendNumber(raw);
  const shipment = shipmentFor(payload, number);
  if (!shipment) throw new NotFoundError(PROVIDER);
  const rows = shipment.trackingEvents ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'DealerSend returned an invalid history');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'DealerSend returned an oversized history');

  // As on the tracking page: a row once per wall clock and wording, newest
  // wall clock first, rows on one clock in the reply's order.
  const seen = new Set<string>();
  const scans = rows.map((row, index) => scanOf(row, index, readAt)).filter((scan): scan is Scan => {
    const key = scan && JSON.stringify([scan.local, scan.event.description]);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const ahead = scans.filter((scan) => scan.ahead);
  const events = scans.filter((scan) => !scan.ahead)
    .sort((a, b) => (a.local < b.local ? 1 : a.local > b.local ? -1 : a.index - b.index)).map(({ event }) => event);
  if (!events.length) {
    throw new NoHistoryError(PROVIDER, 'DealerSend has no scans for the parcel yet', ahead.length
      ? { reason: 'written_ahead', writtenAhead: [...new Set(ahead.map(({ local }) => local))] } : undefined);
  }

  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const destination = text(shipment, 'receiverCountryCode', 8).toUpperCase();
  const service = text(shipment, 'carrierServiceName', 80);
  const wording = events.map((event) => event.description).join('\n');
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time!,
    expected_delivery: null,
    ...(service ? { service_name: service } : {}),
    ...(/^[A-Z]{2}$/.test(destination) && countryCode(destination) === destination ? { destination_country: destination } : {}),
    ...partnerOf(shipment.externalTrackingNumbers, number, wording),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
    ...(ahead.length ? { written_ahead: [...new Set(ahead.map(({ local }) => local))] } : {}),
  };
}
