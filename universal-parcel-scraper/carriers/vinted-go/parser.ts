import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { hasLuhnCheckDigit } from '../../core/detection/numericChecksums.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { lastMovement } from '../../core/result/pickup.js';
import { classifyWording, languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { vintedGoCode, vintedGoStage } from './status.js';

export const PROVIDER = 'Vinted Go';
// A parcel's reply is a few kilobytes; its scans and a few questions and answers.
export const VINTED_GO_MAX_BYTES = 512 * 1024;
// Sixteen digits: the label's creation in Unix milliseconds, two more digits
// and a Luhn check digit. The service answers a number whose check fails as if
// it did not exist, whatever its age.
const NUMBER = /^1\d{15}$/;
// `VGS` and fourteen digits, the other number the service answers. They hold
// no timestamp and no Luhn check digit.
const VGS_NUMBER = /^VGS\d{13,14}$/;
// Sixteen capital letters and digits, letters among them, which the service
// answers like the others. A VGS number with a digit missing is not one.
const CODE = /^(?!VGS?\d+$)(?=\d*[A-Z])[A-Z\d]{16}$/;
// A sorting centre's town and country, the only place a scan's wording names
// as the parcel's own. "In transit to" names where it is going. Some towns come
// with a space before the comma.
const SORTING_CENTER = /^(?:Return: )?At sorting center in ([^,]{2,80}?) ?, ([A-Z]{2})$/;
// The point a parcel is on its way to. Only lockers and parcel shops are named:
// a neighbourhood point can be someone's home.
const ON_ITS_WAY = /^The parcel is on its way to the (locker|parcel shop) \((.{1,120})\)$/;
const READY_AT = /^Ready to collect at the (locker|parcel shop)$/;
// The milestones whose scan can carry a new tracking code on another network.
const HANDOVER = new Set(['redirected', 'left_our_network']);
const MAX_ROWS = 500;
// A sorting centre's scan can come dated up to hours after the lookup that shows it: not a scan yet.
const CLOCK_SKEW_MS = 5 * 60_000;
const MAX_EVENTS = 100;

/** A Vinted Go parcel number; anything else is a number Vinted Go does not issue. */
export function normalizeVintedGoNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!VGS_NUMBER.test(number) && !CODE.test(number) && !(NUMBER.test(number) && hasLuhnCheckDigit(number))) {
    throw new InvalidInputError(PROVIDER, 'Vinted Go numbers are sixteen digits starting 1 whose last digit passes the Luhn check, VGS and thirteen or fourteen digits, or sixteen capital letters and digits');
  }
  return number;
}

/** An optional text field; an object, array or other non-scalar is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 500): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' && typeof value !== 'number') throw new SchemaError(PROVIDER, `Vinted Go returned an invalid ${key}`);
  return typeof value === 'number' ? cleanScalar(value, maxLength) : clean(value, maxLength);
}

interface Scan {
  readonly event: CarrierEvent & { time: string; description: string };
  readonly at: number;
  readonly index: number;
  readonly group: string;
  readonly state: string;
  readonly metadata: Record<string, unknown>;
}

function projectScan(row: unknown, index: number): { id: string; scan: Scan } {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Vinted Go returned an invalid scan');
  const stamp = text(row, 'timestamp', 64);
  const time = explicitOffsetTime(stamp);
  if (!time) throw new SchemaError(PROVIDER, 'Vinted Go returned a scan without an offset time');
  const description = text(row, 'message');
  if (!description) throw new SchemaError(PROVIDER, 'Vinted Go returned a scan without wording');
  const group = text(row, 'group', 64);
  const state = text(row, 'state', 64);
  const stage = vintedGoStage(state, group);
  const place = SORTING_CENTER.exec(description);
  const event = {
    time: time.iso,
    description,
    ...(place ? { location: `${place[1]}, ${place[2]}` } : {}),
    ...(group && state ? { provider_code: vintedGoCode(state, group) } : {}),
    ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
  };
  const metadata = isRecord(row.metadata) ? row.metadata : {};
  return { id: text(row, 'id', 64), scan: { event, at: time.timestamp, index, group, state, metadata } };
}

/**
 * The locker or parcel shop a parcel waits at: the point the scan before its
 * newest ready-to-collect scan sent it on to, when no redirection came between.
 * On a delivered parcel, the point it was collected from.
 */
function pickupPoint(scans: readonly Scan[], stage: Stage | undefined): string {
  const events = scans.map((scan) => scan.event);
  const ready = scans.findIndex((scan) => scan.event.stage === 'ready_for_pickup');
  if (ready < 0) return '';
  if (stage === 'delivered') {
    if (lastMovement(events.slice(1)) !== 'ready_for_pickup') return '';
  } else if (stage !== 'ready_for_pickup' || ready !== 0) {
    return '';
  }
  const kind = READY_AT.exec(scans[ready]!.event.description)?.[1];
  if (!kind) return '';
  for (const scan of scans.slice(ready + 1)) {
    if (scan.group === 'redirected') return '';
    if (scan.group !== 'in_transit') continue;
    const match = ON_ITS_WAY.exec(scan.event.description);
    if (match) return match[1] === kind ? match[2]! : '';
  }
  return '';
}

/** The newest new tracking code the parcel was handed over under, with its network when its link names one. */
function handover(scans: readonly Scan[], number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  for (const scan of scans) {
    if (scan.state !== 'delivery' || !HANDOVER.has(scan.group)) continue;
    const code = normalizeTrackingNumber(text(scan.metadata, 'tracking_code', 64));
    if (!/^[A-Z0-9]{4,40}$/.test(code) || code === number) continue;
    const partner = carrierIdFromPartner('', text(scan.metadata, 'external_link', 500));
    return { delivery_tracking_number: code, ...(partner && partner !== 'vinted-go' ? { delivery_carrier: partner } : {}) };
  }
  return {};
}

/**
 * A collection written a second time: the service follows "Parcel was collected
 * by the recipient" with a bare "Delivered" under the same milestone within a
 * second. The first line says more, so the second is left out.
 */
function collectedAgain(scan: Scan, older: Scan | undefined): boolean {
  return Boolean(older) && scan.group === 'delivered' && older!.group === 'delivered' && scan.state === older!.state
    && scan.at - older!.at < 1000 && /^delivered$/i.test(scan.event.description);
}

/**
 * The reply of `GET /public/v3/tracking_events/{number}`. It does not echo the
 * number: the scans belong to the one in the request's path. The pickup
 * point's address, its id, the pickup deadline, banners and questions in the
 * same reply are never read.
 */
export function parseVintedGo(payload: unknown, raw: string, readAt = Date.now()): CarrierResult {
  const number = normalizeVintedGoNumber(raw);
  if (!isRecord(payload) || !Array.isArray(payload.tracking_events)) throw new SchemaError(PROVIDER, 'Vinted Go returned an unexpected reply');
  const rows = payload.tracking_events as unknown[];
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Vinted Go returned an oversized history');
  // The tracker treats an empty list like an unknown number, but no reply showed one. Vinted Go
  // answered, so the reason tells it from an outage.
  if (!rows.length) throw new IndeterminateError(PROVIDER, 'Vinted Go returned no scans for the parcel', { reason: 'portal_not_found' });

  const seen = new Set<string>();
  const scans: Scan[] = [];
  rows.forEach((row, index) => {
    const { id, scan } = projectScan(row, index);
    const key = id || JSON.stringify(scan.event);
    // Held back until due, when it comes back with the same instant.
    if (seen.has(key) || scan.at > readAt + CLOCK_SKEW_MS) return;
    seen.add(key);
    scans.push(scan);
  });
  if (!scans.length) throw new SchemaError(PROVIDER, 'Vinted Go returned only scans dated after the lookup');
  // The reply lists scans newest first. Instants order them; equal ones keep its order.
  scans.sort((left, right) => right.at - left.at || left.index - right.index);
  const listed = scans.filter((scan, index) => !collectedAgain(scan, scans[index + 1]));
  const newest = listed[0]!.event;
  const current = newest.stage
    ? { stage: newest.stage as Stage, source: 'carrier_map' }
    : classifyWording(newest.description, 'in_transit');
  const known = current.source !== 'none';
  const stage = known ? current.stage : undefined;
  const point = pickupPoint(listed, stage);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current.source } : {}),
    last_status_text: newest.description,
    last_update: newest.time,
    expected_delivery: null,
    ...(stage === 'delivered' ? { delivered_at: newest.time } : {}),
    ...(point ? { pickup_point: point } : {}),
    ...handover(listed, number),
    events: listed.slice(0, MAX_EVENTS).map((scan) => scan.event),
    ...(listed.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}

/**
 * A 404 from the service. An unknown number gets an empty body in the type
 * asked for; a number whose label is over six months old gets
 * `shipment_expired`, whether the parcel existed or not. A missing route
 * answers "Not found" in plain text and says nothing about the parcel.
 */
export function parseVintedGoMissing(body: string, contentType: string | null): never {
  const type = (contentType ?? '').toLowerCase();
  if (!body.trim()) {
    if (type.includes('application/json')) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Vinted Go tracking service is unavailable');
  }
  let reply: unknown;
  try {
    reply = JSON.parse(body);
  } catch {
    throw new IndeterminateError(PROVIDER, 'Vinted Go tracking service is unavailable');
  }
  const code = isRecord(reply) && typeof reply.error_code === 'string' ? reply.error_code : '';
  if (code === 'shipment_expired') {
    throw new IndeterminateError(PROVIDER, 'Vinted Go no longer keeps the history of parcels over six months old', { reason: 'history_expired' });
  }
  throw new IndeterminateError(PROVIDER, 'Vinted Go refused the lookup');
}
