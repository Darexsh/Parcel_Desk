import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { ccfsStage } from './status.js';

export const PROVIDER = 'CCFS';
// A shipment's reply is a few kilobytes.
export const CCFS_MAX_BYTES = 256 * 1024;
// A pro number is twelve digits; a freight bill number one letter and seven digits.
const PRO = /^\d{12}$/;
const FREIGHT_BILL = /^[A-Z]\d{7}$/;
// A clock as the reply writes it: a wall time to the second, some with a fraction, without an offset.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,7})?$/;
// The lookup's answer for a number it does not know, with the number asked.
const NOT_FOUND = /^Tracking number '([^']{1,64})' was not found\.$/;
// The steps of the page's progress rail, furthest first, with the page's label for each.
const RAIL: readonly { key: string; stage: Stage; text: string }[] = [
  { key: 'Delivered', stage: 'delivered', text: 'Delivered' },
  { key: 'OutForDelivery', stage: 'out_for_delivery', text: 'Out for Delivery' },
  { key: 'InTransit', stage: 'in_transit', text: 'In Transit' },
  { key: 'PickedUp', stage: 'accepted', text: 'Picked Up' },
  { key: 'PickupRequested', stage: 'registered', text: 'Pick Up Requested' },
];
// The stages a shipment moves forward through, in order.
const FORWARD: readonly Stage[] = ['registered', 'accepted', 'in_transit', 'out_for_delivery', 'delivered'];
const MAX_SHIPMENTS = 100;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A CCFS pro or freight bill number, as typed; anything else is not one the adapter looks up. */
export function normalizeCcfsNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!PRO.test(number) && !FREIGHT_BILL.test(number)) {
    throw new InvalidInputError(PROVIDER, 'CCFS pro numbers are twelve digits and freight bill numbers one letter and seven digits');
  }
  return number;
}

function invalid(message: string): never {
  throw new SchemaError(PROVIDER, message);
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') invalid(`CCFS returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A clock's wall time, or null when the reply gives none. No clock names its zone. */
function clockOf(row: Record<string, unknown>, key: string): string | null {
  const value = text(row, key, 40);
  if (!value) return null;
  const match = CLOCK.exec(value);
  if (!match) invalid(`CCFS returned an invalid ${key}`);
  const [, year, month, date, hour, minute, second] = match;
  const day = calendarDay(Number(year), Number(month), Number(date));
  // The clock's fields are checked here, since date libraries accept hour 24.
  if (!day || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) invalid(`CCFS returned an invalid ${key}`);
  return `${day}T${hour}:${minute}:${second}`;
}

/** A row's town and state, without a ZIP code; a place still holding a digit is left out. */
function placeOf(raw: string): string {
  const place = raw.replace(/\s+\d{5}(?:-\d{4})?$/, '');
  return /\d/.test(place) ? '' : place;
}

/** The furthest step the page's progress rail has reached, if any. */
function railStep(shipment: Record<string, unknown>): (typeof RAIL)[number] | null {
  const progress = shipment.Progress;
  if (progress === null || progress === undefined) return null;
  if (!isRecord(progress)) invalid('CCFS returned an invalid Progress');
  for (const step of RAIL) {
    const value = progress[step.key];
    if (value !== null && value !== undefined && typeof value !== 'boolean') invalid('CCFS returned an invalid Progress');
  }
  return RAIL.find((step) => progress[step.key] === true) ?? null;
}

/** One row of `Locations`: its `Date`, `Status` and `Location`. */
function projectRow(row: unknown): CarrierEvent {
  if (!isRecord(row)) invalid('CCFS returned an invalid history row');
  const description = text(row, 'Status', 160);
  if (!description) invalid('CCFS returned a history row without its status');
  const local_time = clockOf(row, 'Date');
  if (!local_time) invalid('CCFS returned a history row without its time');
  const location = placeOf(text(row, 'Location', 80));
  const staged = ccfsStage(description);
  return {
    local_time,
    ...(location ? { location } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/** The number the lookup's not-found answer names, or null when the body is not that answer. */
export function ccfsNotFoundNumber(payload: unknown): string | null {
  if (!isRecord(payload) || typeof payload.Message !== 'string') return null;
  return NOT_FOUND.exec(payload.Message.trim())?.[1] ?? null;
}

/** The one shipment of the search whose pro or freight bill number is the number asked. */
function shipmentOf(payload: unknown, number: string): Record<string, unknown> {
  if (!isRecord(payload) || !Array.isArray(payload.List)) invalid('CCFS returned an invalid search');
  const list: unknown[] = payload.List;
  if (!list.length) invalid('CCFS returned an empty search');
  if (list.length > MAX_SHIPMENTS) invalid('CCFS returned an oversized search');
  const matches = list.map((entry) => (isRecord(entry) ? entry : invalid('CCFS returned an invalid shipment')))
    .filter((entry) => [text(entry, 'ProNum', 40), text(entry, 'BillNum', 40)].some((value) => value.toUpperCase() === number));
  // The lookup also finds shipments by their references; one found only that way is not the shipment asked.
  if (!matches.length) throw new IndeterminateError(PROVIDER, 'CCFS answered for another shipment');
  if (matches.length > 1) throw new IndeterminateError(PROVIDER, 'CCFS answered with several shipments for the number');
  return matches[0]!;
}

/**
 * The reply of `api/web/V2/Consignments/Basics?TrackingNum={number}`, the
 * lookup the shipment page at `auth.ccfs.com/track/detail/{number}` makes:
 * `{"List":[…]}`, the shipments whose pro number, freight bill number or
 * references match. A number it does not know is an HTTP 404 naming the
 * number. The shipment must carry the number asked as its pro or freight bill
 * number. Its history, `Locations`, lists the rows oldest first unless the
 * reply says `Descending`. The shipment also holds the shipper's and the
 * consignee's towns with their ZIP codes, the pickup day, the delivery's
 * arrival and departure, its signer and comment, its images and partners'
 * tracking links; none of them is read.
 */
export function parseCcfs(reply: { status: number; body: unknown }, raw: string): CarrierResult {
  const number = normalizeCcfsNumber(raw);
  if (reply.status === 404) {
    const named = ccfsNotFoundNumber(reply.body);
    // Any other 404 is a moved route.
    if (named === null) throw new TransportError(PROVIDER, 'CCFS tracking lookup is unavailable');
    if (named.toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'CCFS answered for another number');
    throw new NotFoundError(PROVIDER);
  }
  if (reply.status !== 200) invalid('CCFS returned an unexpected reply');
  const shipment = shipmentOf(reply.body, number);

  const rows = shipment.Locations ?? [];
  if (!Array.isArray(rows)) invalid('CCFS returned an invalid history');
  if (rows.length > MAX_ROWS) invalid('CCFS returned an oversized history');
  const seen = new Set<string>();
  const listed: CarrierEvent[] = [];
  for (const event of rows.map(projectRow)) {
    const key = JSON.stringify([event.local_time, event.description, event.location ?? '']);
    if (seen.has(key)) continue;
    seen.add(key);
    listed.push(event);
  }
  // Newest first, in the reply's order rather than by clock: the clocks name no zone.
  const descending = isRecord(reply.body) && reply.body.Descending === true;
  const events = descending ? listed : listed.reverse();
  const status = text(shipment, 'Status', 120);
  const rail = railStep(shipment);
  if (!events.length && !rail && !status) throw new NoHistoryError(PROVIDER);

  // A delivery ends the shipment, whether a row or the rail records it. A problem in the newest
  // staged row is the current state; otherwise the further of that row and the rail's step is.
  // Without a history, the shipment's status says it.
  const delivery = events.find((event) => event.stage === 'delivered');
  const staged = events.find((event) => event.stage);
  const row: ClassifiedWording | null = staged ? { stage: staged.stage as Stage, source: staged.stage_source! } : null;
  const ahead = rail !== null && (rail.stage === 'delivered' || !row
    || (FORWARD.includes(row.stage) && FORWARD.indexOf(rail.stage) > FORWARD.indexOf(row.stage)));
  const fromRail = !delivery && ahead;
  const decided: ClassifiedWording | null = delivery ? { stage: 'delivered', source: delivery.stage_source! }
    : fromRail ? { stage: rail.stage, source: 'carrier_map' }
      : row ?? (events.length || !status ? null : ccfsStage(status));
  const stage = decided?.stage;
  // A rail step ahead of every row is the current state, without a clock.
  const current = fromRail ? undefined : events[0];
  const settled = stage === 'delivered' || stage === 'returned';
  const pro = text(shipment, 'ProNum', 40);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(decided ? { current_stage: decided.stage, current_stage_source: decided.source } : {}),
    last_status_text: fromRail ? rail.text : current?.description ?? (status || null),
    last_update: null,
    ...(current?.local_time ? { last_update_local: current.local_time } : {}),
    // Until the delivery, the page shows the day of the delivery window's start as the estimate.
    expected_delivery: settled ? null : clockOf(shipment, 'ExpectedAfter')?.slice(0, 10) ?? null,
    // The page heads the shipment with its pro number.
    ...(pro !== number && PRO.test(pro) ? { canonical_tracking_number: pro } : {}),
    ...(rows.length ? {} : { summary_only: true }),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
