import { DateTime } from 'luxon';
import { DELIVERY_POSTCODE, deliveryPostcodeText } from '../../core/catalog/postcode.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InputRequiredError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime, type ParsedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { relaytechMappedStage, relaytechStage } from './status.js';

export const PROVIDER = 'Relay';
// A shipment with a long history is a few kilobytes.
export const RELAYTECH_MAX_BYTES = 256 * 1024;
const NUMBER = /^RELR[A-Z0-9]{8}$/;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
// An offset-less ISO clock, to the minute or finer.
const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2})(?:\.\d{1,6})?)?$/;
// The app writes a status as a slug in places; one shown that way is turned into words.
const SLUG = /^[a-z0-9]+(?:[-_][a-z0-9]+)+$/;
const COLLECTION = new Set(['customer_collection', 'return_to_sender_customer_collection']);
const SETTLED: ReadonlySet<Stage> = new Set(['delivered', 'returned', 'exception', 'ready_for_pickup']);
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A Relay tracking ID in capitals, as the tracking app sends it; anything else is not one Relay issues. */
export function normalizeRelaytechNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Relay tracking IDs are RELR and eight letters and digits');
  return number;
}

/**
 * The postcode the tracker asks for with every tracking ID: trimmed and in
 * capitals, as the tracking app sends it. Without it Relay opens nothing, so
 * no request is made.
 */
export function normalizeRelaytechPostcode(raw: string | null | undefined): string {
  const postcode = deliveryPostcodeText(raw ?? '');
  if (!postcode) throw new InputRequiredError(PROVIDER, 'the delivery postcode', 'Relay shows a parcel only with its delivery postcode');
  if (!DELIVERY_POSTCODE.test(postcode)) throw new InvalidInputError(PROVIDER, 'Relay requires a valid delivery postcode');
  return postcode;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Relay returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A status code, in the lower case the app compares it in. */
function code(row: Record<string, unknown>, key: string): string {
  const value = text(row, key, 64).toLowerCase();
  if (value && !CODE.test(value)) throw new SchemaError(PROVIDER, `Relay returned an invalid ${key}`);
  return value;
}

/** A code or slug in words: `out_for_delivery` reads "Out for delivery". */
function words(value: string): string {
  const spaced = value.replace(/[-_]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** An instant the reply gives with its offset; anything else is not read. */
function instant(row: Record<string, unknown>, key: string): ParsedTime | null {
  return explicitOffsetTime(text(row, key, 64));
}

interface Scan { event: CarrierEvent; order: number; index: number; key: string }

/**
 * A scan's clock. The app reads `timestamp` as an instant; one with an offset
 * keeps it. Without one it stays the wall clock the page shows: no offset is
 * assumed. `order` only sorts the scans.
 */
function scanClock(raw: string): { clock: Pick<CarrierEvent, 'time'> & { local_time?: string }; order: number } {
  const offset = explicitOffsetTime(raw);
  if (offset) return { clock: { time: offset.iso }, order: offset.timestamp };
  const match = WALL_CLOCK.exec(raw);
  const local = match ? `${match[1]}T${match[2]}:${match[3] ?? '00'}` : '';
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!match || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'Relay returned an invalid scan time');
  }
  return { clock: { local_time: local }, order: parsed.toMillis() };
}

/** One scan of `events`: its status, the words the page shows for it, and its clock. Notes and photos are not read. */
function projectRow(row: unknown, index: number): Scan {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Relay returned an invalid scan');
  const status = code(row, 'status');
  const shown = text(row, 'status_display_slug', 200);
  const description = shown ? (SLUG.test(shown) ? words(shown) : shown) : words(status);
  if (!description) throw new SchemaError(PROVIDER, 'Relay returned a scan without a status');
  const raw = text(row, 'timestamp', 64);
  if (!raw) throw new SchemaError(PROVIDER, 'Relay returned a scan without a time');
  const { clock, order } = scanClock(raw);
  const staged = relaytechStage(status, description);
  const event: CarrierEvent = {
    ...clock,
    description,
    ...(status ? { provider_code: status } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { event, order, index, key: JSON.stringify([clock.time ?? clock.local_time, status, description]) };
}

/** The tracking ID, label ID or barcode the shipment answers to; one of them must be the number asked. */
function answersTo(data: Record<string, unknown>, number: string): boolean {
  const ids = ['tracking_number', 'parcel_label_id', 'barcode_number'].map((key) => normalizeTrackingNumber(text(data, key, 64)));
  if (!ids[0]) throw new SchemaError(PROVIDER, 'Relay returned a shipment without its tracking ID');
  return ids.includes(number);
}

/** The shop a parcel sent for collection waits at: its name, then its address. */
function pickupPoint(data: Record<string, unknown>): string | null {
  if (!COLLECTION.has(code(data, 'objective'))) return null;
  const name = text(data, 'pitstop_name', 120);
  if (!name) return null;
  const address = text(data, 'pitstop_address', 300);
  const postcode = text(data, 'pitstop_postcode', 12);
  const lines = [name, address, postcode && !address.toUpperCase().includes(postcode.toUpperCase()) ? postcode : ''];
  return lines.filter(Boolean).join('\n');
}

/**
 * The delivery window the page shows on the day: from its start to its end,
 * while the parcel is still on its way and the window has not passed its
 * newest scan. Out for delivery without a window, the courier's estimate.
 */
function estimate(data: Record<string, unknown>, stage: Stage | undefined, newest: number | null):
  Pick<CarrierResult, 'expected_delivery' | 'expected_delivery_from'> {
  if (stage && SETTLED.has(stage)) return { expected_delivery: null };
  const from = instant(data, 'estimated_arrival_window_start_at');
  const to = instant(data, 'estimated_arrival_window_end_at');
  if (from && to && from.timestamp < to.timestamp && (newest === null || to.timestamp >= newest)) {
    return { expected_delivery_from: from.iso, expected_delivery: to.iso };
  }
  const eta = stage === 'out_for_delivery' ? instant(data, 'first_delivery_eta') : null;
  return { expected_delivery: eta && (newest === null || eta.timestamp >= newest) ? eta.iso : null };
}

/**
 * The tracker's reply for one tracking ID and postcode: the shipment, with its
 * scans in `events`. Relay answers an unknown ID and a wrong postcode alike
 * with a 404 the adapter reads, so a reply here is a shipment. It must answer
 * to the number asked. Its recipient's address, safe-place and door codes,
 * courier notes and proof-of-delivery photos are not read.
 */
export function parseRelaytech(payload: unknown, raw: string): CarrierResult {
  const number = normalizeRelaytechNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Relay returned an invalid shipment');
  if (!answersTo(payload, number)) throw new IndeterminateError(PROVIDER, 'Relay answered for another shipment');
  const rows = payload.events ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Relay returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Relay returned an oversized history');

  const seen = new Set<string>();
  const scans: Scan[] = [];
  rows.forEach((row, index) => {
    const scan = projectRow(row, index);
    if (seen.has(scan.key)) return;
    seen.add(scan.key);
    scans.push(scan);
  });
  // Newest first. The app reads the last scan of a status as its newest, so a tie keeps the later one first.
  scans.sort((left, right) => right.order - left.order || right.index - left.index);
  const events = scans.map(({ event }) => event);

  const current = code(payload, 'delivery_status');
  if (!events.length && !current) throw new NoHistoryError(PROVIDER);
  const scanned = events.find((event) => event.stage);
  const summary = current ? relaytechMappedStage(current) : undefined;
  const stage = summary ?? (scanned?.stage as Stage | undefined);
  const source = summary ? 'carrier_map' : scanned?.stage_source;
  const shown = current ? events.find((event) => event.provider_code === current) : events[0];
  const newest = events[0];
  const newestInstant = newest?.time ? explicitOffsetTime(newest.time)?.timestamp ?? null : null;

  const deliveredScan = events.find((event) => event.stage === 'delivered');
  const deliveredAt = stage === 'delivered'
    ? instant(payload, 'parcel_delivered_at')?.iso ?? (deliveredScan?.time || null) : null;
  const pickup = pickupPoint(payload);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: shown?.description ?? words(current),
    ...(current && !shown ? { provider_code: current } : {}),
    last_update: newest?.time ?? null,
    ...(newest?.local_time ? { last_update_local: newest.local_time } : {}),
    ...estimate(payload, stage, newestInstant),
    ...(pickup ? { pickup_point: pickup } : {}),
    ...(deliveredAt ? { delivered_at: deliveredAt } : {}),
    ...(events.length ? {} : { summary_only: true }),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
