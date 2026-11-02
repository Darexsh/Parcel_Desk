import { DateTime } from 'luxon';
import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { boxtalStage } from './status.js';

export const PROVIDER = 'Boxtal';
export const CARRIER = 'boxtal';
// A delivered booking of one parcel is under four kilobytes.
export const BOXTAL_MAX_BYTES = 512 * 1024;
// Ten digits that start with the booking's date, the collecting carrier's four letters, four letters or digits and FR.
const REFERENCE = /^\d{10}[A-Z]{4}[A-Z0-9]{4}FR$/;
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
// Boxtal's state letter for a scan.
const STATE = /^[A-Z]$/;
// The collecting carrier's number beside its tracking link.
const PARTNER_NUMBER = /^[A-Z0-9]{6,40}$/;
const MAX_PACKAGES = 50;
const MAX_LINES = 500;

/** A Boxtal reference, in capitals as the tracker needs it; anything else is not one Boxtal issues. */
export function normalizeBoxtalReference(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!REFERENCE.test(number)) {
    throw new InvalidInputError(PROVIDER, 'Boxtal references are ten digits, four letters, four letters or digits and FR');
  }
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Boxtal returned an invalid ${key}`);
  return clean(value, maxLength);
}

function list(row: Record<string, unknown>, key: string, max: number): Record<string, unknown>[] {
  const value = row[key];
  if (!Array.isArray(value) || value.length > max || !value.every(isRecord)) throw new SchemaError(PROVIDER, `Boxtal returned invalid ${key}`);
  return value;
}

/** Whether a reply is the tracker's answer for a reference it does not know. */
export function isUnknownReference(payload: unknown, reference: string): boolean {
  return isRecord(payload) && isRecord(payload.responseStatus) && payload.responseStatus.successful === false
    && payload.responseStatus.description === `The given tracking reference ${reference} could not be found.`
    && Array.isArray(payload.packageTrackings) && payload.packageTrackings.length === 0;
}

interface Scan { local: string; index: number; event: CarrierEvent }

function scan(line: Record<string, unknown>, index: number): Scan {
  const clock = text(line, 'trackingDate', 64);
  const parsed = WALL_CLOCK.test(clock) ? DateTime.fromISO(clock, { zone: 'UTC' }) : null;
  // UTC only checks the calendar fields; Luxon rolls 24:00:00 over, so only a clock that reads back unchanged is kept.
  if (!parsed?.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== clock) throw new SchemaError(PROVIDER, 'Boxtal returned an invalid event time');
  const state = text(line, 'boxtalState', 8);
  if (state && !STATE.test(state)) throw new SchemaError(PROVIDER, 'Boxtal returned an invalid state');
  // The collecting carrier's text and its detail, as the page joins them, else Boxtal's own.
  const description = [text(line, 'message'), text(line, 'description')].filter(Boolean).join(' - ') || text(line, 'boxtalMessage');
  if (!description) throw new SchemaError(PROVIDER, 'Boxtal returned an event without a text');
  const location = text(line, 'localization', 160);
  const staged = boxtalStage(state || null, description);
  const event: CarrierEvent = {
    local_time: clock,
    description,
    ...(location ? { location } : {}),
    ...(state ? { provider_code: state } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { local: clock, index, event };
}

/** The collecting carrier its tracking link names, for the number beside it. The link carries the shipper's account, so it is not kept. */
function collectingCarrier(parcel: Record<string, unknown>, reference: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const number = normalizeTrackingNumber(text(parcel, 'carrierReference', 64)).toUpperCase();
  let url: URL;
  try {
    url = new URL(text(parcel, 'trackingUrl', 2_000));
  } catch {
    return {};
  }
  if (!['https:', 'http:'].includes(url.protocol) || !PARTNER_NUMBER.test(number) || number === reference) return {};
  if (!url.href.toUpperCase().includes(number)) return {};
  const partner = carrierIdFromPartner('', url.href);
  return partner && partner !== CARRIER && partner !== 'unknown' ? { delivery_carrier: partner, delivery_tracking_number: number } : {};
}

/**
 * Boxtal's tracking for one booking reference: a list of parcels, each with
 * the collecting carrier's code, its number and tracking link, and the scans
 * Boxtal received for it, newest first. Scan clocks are wall clocks with no
 * offset. A reference the tracker does not know gets HTTP 404 with a message
 * naming it, which the adapter reads before this.
 */
export function parseBoxtal(payload: unknown, raw: string): CarrierResult {
  const reference = normalizeBoxtalReference(raw);
  if (isUnknownReference(payload, reference)) throw new NotFoundError(PROVIDER);
  if (!isRecord(payload) || payload.responseStatus !== null) throw new SchemaError(PROVIDER, 'Boxtal returned an invalid tracking reply');
  const parcels = list(payload, 'packageTrackings', MAX_PACKAGES);
  if (!parcels.length) throw new IndeterminateError(PROVIDER, 'Boxtal returned no parcel for the booking');
  const lines: Record<string, unknown>[] = [];
  for (const parcel of parcels) {
    if (text(parcel, 'boxtalReference', 64).toUpperCase() !== reference) throw new IndeterminateError(PROVIDER, 'Boxtal answered for another booking');
    lines.push(...list(parcel, 'lines', MAX_LINES));
  }
  if (lines.length > MAX_LINES) throw new SchemaError(PROVIDER, 'Boxtal returned an oversized history');
  if (!lines.length) throw new NoHistoryError(PROVIDER);

  // Newest first; scans on one clock keep the reply's order, which lists the newest first.
  const seen = new Set<string>();
  const events = lines.map((line, index) => scan(line, index))
    .sort((a, b) => b.local.localeCompare(a.local) || a.index - b.index)
    .map(({ event }) => event)
    .filter((event) => {
      const key = JSON.stringify([event.local_time, event.description, event.location ?? null]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    // Only a booking of one parcel names one collecting carrier's number.
    ...(parcels.length === 1 ? collectingCarrier(parcels[0]!, reference) : {}),
    events,
  };
}
