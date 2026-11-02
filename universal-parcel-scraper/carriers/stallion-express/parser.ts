import { DateTime } from 'luxon';
import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime, type ParsedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { stallionOwnScan, stallionStage } from './status.js';

export const PROVIDER = 'Stallion Express';
// A shipment's reply is a few kilobytes: its details and some twenty scans.
export const STALLION_MAX_BYTES = 256 * 1024;
// Stallion's shipment code: the shipping day, year first, and four letters or
// digits. Its own label prints the code behind SE.
const SHIP_CODE = /^\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])[0-9A-Z]{4}$/;
// The tracker's whole answer for a number it does not know.
const NOT_FOUND = 'No shipment found';
// Stallion stamps Intelcom's scans with Intelcom's UTC clock read as Toronto time.
const RELAY_ZONE = 'America/Toronto';
const MAX_ROWS = 300;
const MAX_EVENTS = 100;

export interface StallionNumber {
  /** The number as the tracker is asked for it. */
  readonly number: string;
  /** The shipment code without SE. */
  readonly shipCode: string;
}

/** A Stallion shipment code, bare or behind SE; anything else is a number Stallion does not issue. */
export function normalizeStallionNumber(raw: string): StallionNumber {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  const shipCode = number.startsWith('SE') ? number.slice(2) : number;
  if (!SHIP_CODE.test(shipCode)) {
    throw new InvalidInputError(PROVIDER, 'Stallion Express shipment codes are a six-digit date and four letters or digits, bare or behind SE');
  }
  return { number, shipCode };
}

/** An optional text field; an object, array or number is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 500): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Stallion Express returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** Intelcom's clock back from Stallion's stamp: the stamp's Toronto wall time is the UTC one. */
function relayedClock(stamp: ParsedTime): ParsedTime | null {
  const wall = DateTime.fromMillis(stamp.timestamp, { zone: RELAY_ZONE });
  const { year, month, day, hour, minute, second, millisecond } = wall;
  const utc = DateTime.fromObject({ year, month, day, hour, minute, second, millisecond }, { zone: 'utc' });
  const iso = utc.isValid ? utc.toISO({ suppressMilliseconds: true }) : null;
  return iso ? { iso, timestamp: utc.toMillis() } : null;
}

interface Scan {
  readonly event: CarrierEvent & { time: string; description: string };
  readonly at: number;
  readonly index: number;
  readonly carrier: string;
}

function projectScan(row: unknown, index: number): Scan | null {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Stallion Express returned an invalid scan');
  const description = text(row, 'status');
  const carrier = text(row, 'carrier', 80);
  const stamp = text(row, 'datetime', 64);
  const location = text(row, 'location', 200);
  // The partner's own label announcement can come undated; it moved nothing.
  if (!stamp || !description) return null;
  const parsed = explicitOffsetTime(stamp);
  if (!parsed) throw new SchemaError(PROVIDER, 'Stallion Express returned a scan without a UTC time');
  const relayed = carrier.toLowerCase() === 'intelcom' && !stallionOwnScan(description);
  const time = relayed ? relayedClock(parsed) : parsed;
  if (!time) throw new SchemaError(PROVIDER, 'Stallion Express returned an invalid scan time');
  const classified = stallionStage(description);
  return {
    event: {
      time: time.iso,
      description,
      // A bare country code is the label's country, not where a scan happened.
      ...(location && !/^[A-Z]{2}$/.test(location) ? { location } : {}),
      ...(classified ? { stage: classified.stage, stage_source: classified.source } : {}),
    },
    at: time.timestamp,
    index,
    carrier,
  };
}

/** The delivering partner when Stallion's link to its tracker names the same carrier as its name. */
function deliveryPartner(name: string, url: string): string | undefined {
  if (!name || !url) return undefined;
  const named = carrierIdFromPartner(name, url);
  return named && named !== 'stallion-express' && named === carrierIdFromPartner('', url) ? named : undefined;
}

/**
 * The reply of the tracking page's `se_track_form_submission` action. The
 * tracker also finds a shipment by the number its partner tracks it under, so
 * the reply counts only when its shipment code is the one asked for, and an SE
 * number only when it is the label's own tracking number. The ship-to town and
 * province and the carrier's phone number are never read.
 */
export function parseStallion(payload: unknown, raw: string): CarrierResult {
  const { number, shipCode } = normalizeStallionNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Stallion Express returned an unexpected reply');
  if (payload.success !== true) return stallionFailure(payload);
  if (!isRecord(payload.details) || !Array.isArray(payload.events)) {
    throw new SchemaError(PROVIDER, 'Stallion Express returned a shipment without details or scans');
  }
  const details = payload.details;
  const code = normalizeTrackingNumber(text(details, 'ship_code', 64));
  const tracking = normalizeTrackingNumber(text(details, 'tracking', 64));
  if (code !== shipCode) {
    // Found by another number of the shipment: the partner's, which is not Stallion's code.
    if (tracking === number) throw new IndeterminateError(PROVIDER, 'Stallion Express found another shipment by its partner number');
    throw new SchemaError(PROVIDER, 'Stallion Express returned another shipment');
  }
  if (number !== shipCode && tracking !== number) throw new SchemaError(PROVIDER, 'Stallion Express returned another tracking number');

  const rows = payload.events as unknown[];
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Stallion Express returned an oversized history');
  const seen = new Set<string>();
  const scans: Scan[] = [];
  rows.forEach((row, index) => {
    const scan = projectScan(row, index);
    if (!scan) return;
    const key = JSON.stringify([scan.at, scan.event.description, scan.event.location ?? '']);
    if (seen.has(key)) return;
    seen.add(key);
    scans.push(scan);
  });
  // The page itself reports a shipment without scans as not tracked yet.
  if (!scans.length) throw new IndeterminateError(PROVIDER, 'Stallion Express has no scans for the shipment yet');
  // Newest first by instant; equal ones keep the reply's order.
  scans.sort((left, right) => right.at - left.at || left.index - right.index);

  // A receipt after the parcel moved on is the next depot's or the partner's, not its acceptance.
  let moved = false;
  for (const scan of [...scans].reverse()) {
    const stage = scan.event.stage as Stage | undefined;
    if (stage === 'accepted' && moved) scan.event.stage = 'in_transit';
    if (stage && !['registered', 'accepted', 'exception'].includes(stage)) moved = true;
  }

  const events = scans.map((scan) => scan.event);
  const newest = events[0]!;
  // A partner's label announcement after Stallion took the parcel is no step back.
  const current = events.find((event) => event.stage && event.stage !== 'registered')
    ?? events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const delivered = stage === 'delivered' ? current!.time : undefined;
  const service = text(details, 'service', 80);
  const partner = deliveryPartner(scans[0]!.carrier, text(details, 'url', 500));
  const country = text(details, 'destination', 200).split(',').pop()?.trim() ?? '';
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description,
    last_update: newest.time,
    expected_delivery: null,
    ...(delivered ? { delivered_at: delivered } : {}),
    ...(service ? { service_name: service } : {}),
    ...(partner ? { delivery_carrier: partner } : {}),
    ...(/^[A-Z0-9]{4,40}$/.test(tracking) && tracking !== number ? { delivery_tracking_number: tracking } : {}),
    ...(/^[A-Z]{2}$/.test(country) ? { destination_country: country } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}

/**
 * A reply without a shipment. "No shipment found" alone is the tracker's
 * answer for an unknown number. The site throttles the lookups of all its
 * visitors together and says when to ask again; any other reply proves nothing.
 */
export function stallionFailure(payload: Record<string, unknown>): never {
  if (payload.success === false && Array.isArray(payload.errors)) {
    if (payload.errors.length === 1 && payload.errors[0] === NOT_FOUND) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Stallion Express refused the lookup');
  }
  if (payload.message === 'Too many requests') {
    const seconds = payload.retryAfterSeconds;
    throw new RateLimitedError(PROVIDER, typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0
      ? Math.min(seconds, 3_600) * 1_000 : undefined);
  }
  throw new IndeterminateError(PROVIDER, 'Stallion Express returned no answer about the shipment');
}
