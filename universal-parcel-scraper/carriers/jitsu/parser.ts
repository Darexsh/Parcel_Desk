import { DateTime, IANAZone } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { jitsuCode, jitsuStage } from './status.js';

export const PROVIDER = 'Jitsu';
// A delivery's reply is about ten kilobytes, most of it the tracker's settings.
export const JITSU_MAX_BYTES = 1_000_000;
// Jitsu's own codes are twelve or sixteen letters and digits, and it tracks some
// shippers' numbers as they are, such as SCD and sixteen characters. The
// service matches them whatever their case.
const NUMBER = /^[A-Z0-9]{4,40}$/;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
// The page drops a facility's first scan within a minute of its receipt scan, which repeats it.
const FIRST_SCAN_WINDOW_MS = 60_000;
// Stages whose scheduled window the tracker shows; it shows the attempt or the
// delivery instead once the parcel has one, and nothing for a problem.
const ESTIMATED: ReadonlySet<Stage> = new Set(['registered', 'in_transit', 'out_for_delivery']);
// The tracker's milestones before the parcel reaches Jitsu, whose window a shipper can hide.
const EARLY_MILESTONES: ReadonlySet<string> = new Set(['Processing', 'Processed']);
// How many days the tracker looks ahead for a service day when a round runs late.
const MAX_ROLL_DAYS = 5;

/** A tracking code the service can look up: letters and digits, upper-cased as the library stores them. */
export function normalizeJitsuNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw.trim()) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Jitsu tracking codes are four to forty letters and digits');
  return number;
}

/** An optional text field; an object, array or other value is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 500): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Jitsu returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** An instant as the tracker shows it, on the shipment's own clock when it names a valid zone, to the second. */
function shown(timestamp: number, zone: string | null): string {
  return DateTime.fromMillis(Math.floor(timestamp / 1000) * 1000, { zone: zone ?? 'UTC' }).toISO({ suppressMilliseconds: true })!;
}

interface Row {
  readonly event: CarrierEvent & { time: string; description: string; provider_code: string };
  readonly timestamp: number;
  readonly code: string;
  readonly index: number;
}

/**
 * One row of `outbound_events`: its clock, type and signal, the wording the
 * service gives it and, on facility and linehaul scans, the town and state the
 * tracker prints under them. The driver's remark, the merchant's name and the
 * linehaul carrier's ids on the same rows are never read, nor is a postcode.
 */
function rowOf(value: unknown, index: number, zone: string | null): Row | null {
  if (!isRecord(value)) throw new SchemaError(PROVIDER, 'Jitsu returned an invalid event');
  const type = text(value, 'type', 40);
  const signal = text(value, 'signal', 80);
  const stamp = text(value, 'ts', 40);
  if (!type || !signal) throw new SchemaError(PROVIDER, 'Jitsu returned an event without its type or signal');
  // The tracker leaves out an event without a clock.
  if (!stamp) return null;
  const time = explicitOffsetTime(stamp);
  if (!time) throw new SchemaError(PROVIDER, 'Jitsu returned an event clock without an offset');
  // A trailing separator is left over from an empty place.
  const description = text(value, 'description', 1_000).replace(/[\s,]+$/, '') || text(value, 'milestone', 100);
  if (!description) return null;
  const event: Row['event'] = { time: shown(time.timestamp, zone), description, provider_code: jitsuCode(type, signal) };
  const attributes = value.attributes;
  if (attributes !== null && attributes !== undefined && !isRecord(attributes)) throw new SchemaError(PROVIDER, 'Jitsu returned invalid event details');
  if ((type === 'INBOUND' || type === 'OTHER') && attributes) {
    const town = text(attributes, 'city', 80);
    const state = text(attributes, 'state', 40);
    if (town && state) event.location = `${town}, ${state}`;
  }
  return { event, timestamp: time.timestamp, code: event.provider_code, index };
}

/** The window a late round moves to: the same hours on the next service day, as the tracker counts it. */
function nextServiceDay(from: DateTime, to: DateTime, offDays: ReadonlySet<string>): [DateTime, DateTime] | null {
  let start = from;
  let end = to;
  for (let day = 1; day <= MAX_ROLL_DAYS; day += 1) {
    start = start.plus({ days: 1 });
    end = end.plus({ days: 1 });
    if (!offDays.has(end.toFormat('yyyy-MM-dd'))) return [start, end];
  }
  return null;
}

/** A window of two instants in the shipment's zone, or null when either is missing or they run backwards. */
function windowOf(holder: unknown, zone: string): [DateTime, DateTime] | null {
  if (!isRecord(holder)) return null;
  const from = explicitOffsetTime(text(holder, 'dropoff_earliest_ts', 40));
  const to = explicitOffsetTime(text(holder, 'dropoff_latest_ts', 40));
  if (!from || !to || from.timestamp > to.timestamp) return null;
  return [DateTime.fromMillis(from.timestamp, { zone }), DateTime.fromMillis(to.timestamp, { zone })];
}

/**
 * The delivery window the tracker schedules, while the parcel is on its way and
 * the window has not passed its newest scan. A round that runs late moves the
 * window to the next service day, as the tracker shows it, and a shipper can
 * hide it before the parcel reaches Jitsu.
 */
function scheduled(payload: Record<string, unknown>, shipment: Record<string, unknown>, rows: readonly unknown[],
  stage: Stage | undefined, newest: Row, zone: string | null, declared: string): Pick<CarrierResult, 'expected_delivery' | 'expected_delivery_from'> | null {
  if (stage && !ESTIMATED.has(stage)) return null;
  const settings = isRecord(payload.settings) ? payload.settings : {};
  // The tracker reads the milestone of the first event in the reply, which lists the newest first.
  const milestone = rows.map((row) => (isRecord(row) && typeof row.milestone === 'string' ? row.milestone.trim() : ''))
    .find(Boolean) ?? 'Processing';
  if (settings.hide_delivery_datetime === 'true' && EARLY_MILESTONES.has(milestone)) return null;
  // The tracker's clock when the shipment names none.
  const clock = zone ?? 'America/Los_Angeles';
  let window = windowOf(shipment, clock);
  // The newest late-round notice that names the window it was running for. The
  // tracker moves no window on a clock it does not know.
  const delays = declared && !zone ? [] : rows.filter((row): row is Record<string, unknown> => isRecord(row)
    && row.signal === 'PICKUP_DELAY' && isRecord(row.attributes) && !!windowOf(row.attributes, clock) && !!explicitOffsetTime(row.ts));
  const delay = delays.sort((left, right) => explicitOffsetTime(right.ts)!.timestamp - explicitOffsetTime(left.ts)!.timestamp)[0];
  if (delay) {
    const offDays = new Set(Array.isArray(payload.no_service_dates) ? payload.no_service_dates
      .filter((day): day is Record<string, unknown> => isRecord(day) && day.off === true && typeof day.date === 'string')
      .map((day) => day.date as string) : []);
    const [from, to] = windowOf(delay.attributes, clock)!;
    const rolled = nextServiceDay(from, to, offDays);
    // The later of the two windows.
    if (rolled && (!window || rolled[1] > window[1])) window = rolled;
  }
  if (!window) return null;
  const [from, to] = window;
  if (to.toMillis() < newest.timestamp) return null;
  return { expected_delivery: shown(to.toMillis(), zone), expected_delivery_from: shown(from.toMillis(), zone) };
}

/**
 * The reply of `GET /delivery/{code}` on Jitsu's recipient service: the
 * shipment, its events newest first, and the tracker's settings. The shipment's
 * tracking code must be the one requested, in any case. Events are read as
 * the tracker lists them: by clock, newest first, without the address updates
 * the recipient made, and without a facility's first scan that repeats its
 * receipt. The recipient's contact details, address, postcode and position,
 * the driver, delivery remarks, photos, signatures and access codes are never
 * read.
 */
export function parseJitsu(payload: unknown, raw: string): CarrierResult {
  const number = normalizeJitsuNumber(raw);
  if (!isRecord(payload) || !isRecord(payload.shipment)) throw new SchemaError(PROVIDER, 'Jitsu returned an unexpected reply');
  const shipment = payload.shipment;
  const code = text(shipment, 'tracking_code', 64);
  if (!code) throw new SchemaError(PROVIDER, 'Jitsu returned a shipment without its tracking code');
  if (code.toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'Jitsu answered with a shipment the number does not identify');
  const declared = text(shipment, 'timezone', 64);
  const zone = declared && IANAZone.isValidZone(declared) ? declared : null;

  const listed = payload.outbound_events ?? [];
  if (!Array.isArray(listed) || listed.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Jitsu returned an invalid event list');
  const rows = listed as unknown[];
  const read = rows.map((row, index) => rowOf(row, index, zone))
    // An address the recipient changed is no movement; the tracker shows it under another event's wording.
    .filter((row): row is Row => !!row && row.code !== 'OUTBOUND.UPDATE_DROPOFF');
  const receipts = read.filter((row) => row.code === 'INBOUND.RECEIVED_OK').map((row) => row.timestamp);
  const seen = new Set<string>();
  const scans = read.filter((row) => {
    if (row.code === 'INBOUND.FIRST_SCAN' && receipts.some((at) => Math.abs(at - row.timestamp) <= FIRST_SCAN_WINDOW_MS)) return false;
    const key = JSON.stringify(row.event);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Newest first; equal clocks keep the reply's order.
  scans.sort((left, right) => right.timestamp - left.timestamp || left.index - right.index);

  // Oldest first, so a scan that moves nothing keeps the stage before it.
  let previous: Stage | undefined;
  let received = false;
  for (const { event, code: scanCode } of [...scans].reverse()) {
    const classified = jitsuStage(scanCode, event.description, { moved: !!previous && previous !== 'registered', received });
    if (classified === 'quiet') {
      Object.assign(event, { stage: previous ?? 'registered', stage_source: 'none' });
    } else if (classified) {
      Object.assign(event, { stage: classified.stage, stage_source: classified.source });
      previous = classified.stage;
    }
    if (scanCode.startsWith('INBOUND.') && event.stage === 'in_transit' && event.stage_source !== 'none') received = true;
  }

  const newest = scans[0];
  if (!newest) throw new NoHistoryError(PROVIDER);
  const decider = scans.find((row) => row.event.stage && row.event.stage_source !== 'none');
  const stage = decider?.event.stage as Stage | undefined;
  const window = scheduled(payload, shipment, rows, stage, newest, zone, declared);
  const events = scans.map((row) => row.event);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: decider!.event.stage_source } : {}),
    last_status_text: newest.event.description,
    last_update: newest.event.time,
    expected_delivery: window?.expected_delivery ?? null,
    ...(window ? { expected_delivery_from: window.expected_delivery_from } : {}),
    ...(stage === 'delivered' && decider?.code === 'OUTBOUND.DROPOFF_SUCCEEDED' ? { delivered_at: decider.event.time } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}

/**
 * Whether a 404 is the service's own answer that it has no delivery for the
 * code: its servlet's not-found body naming the path asked. A route the service
 * no longer serves answers another body.
 */
export function isJitsuNotFound(payload: unknown, number: string): boolean {
  return isRecord(payload) && payload.servlet === 'jersey' && payload.message === 'Not Found'
    && String(payload.status) === '404' && payload.url === `/delivery/${number}`;
}
