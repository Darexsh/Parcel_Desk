import { DateTime } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { lastMovement } from '../../core/result/pickup.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { eltaStage, isEltaNotice } from './status.js';

export const PROVIDER = 'ELTA';
// A reply carries a hundred scan slots, most of them empty: about 8 kB.
export const ELTA_MAX_BYTES = 256_000;

const MAX_SLOTS = 500;
const MAX_EVENTS = 100;
// The tracker's answer for an item without history, in English and in Greek.
const NO_HISTORY = new Set(['No Tracking History', 'Ιστορικό Μη Διαθέσιμο']);
const DAY = /^\d{8}$/;
const TIME = /^\d{4}$/;

/**
 * ELTA's tracker asks for an S10 item code, and says some items from Germany
 * carry a twelve-digit code instead. ELTA Courier vouchers use the S10 layout.
 */
export function normalizeEltaNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (/^\d{12}$/.test(number) || isValidS10TrackingNumber(number)) return number;
  throw new InvalidInputError(PROVIDER, 'ELTA tracks S10 item codes and the twelve-digit codes of some items from Germany');
}

const flagOf = (value: unknown) => typeof value === 'number' ? value
  : typeof value === 'string' && /^\d{1,3}$/.test(value.trim()) ? Number(value) : Number.NaN;

/** The scan's date and time ("20260304", "0915") as a wall clock. They carry no offset. */
function wallClock(day: string, time: string): string | null {
  if (!DAY.test(day) || !TIME.test(time)) return null;
  // UTC only checks the calendar fields. No offset is assigned.
  const parsed = DateTime.fromFormat(`${day}${time}`, 'yyyyMMddHHmm', { zone: 'UTC' });
  return parsed.isValid ? parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") : null;
}

/**
 * The tracker's reply for one item code: its scans, newest first. The reply
 * names the code it answers for; an item without history comes back with a
 * notice instead of scans.
 */
export function parseElta(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeEltaNumber(rawNumber);
  if (!Array.isArray(payload) || payload.length !== 1 || !isRecord(payload[0])) {
    throw new SchemaError(PROVIDER, 'ELTA did not return one item');
  }
  const item = payload[0];
  if (typeof item.code !== 'string' || item.code.trim().toUpperCase() !== number) {
    throw new SchemaError(PROVIDER, 'ELTA answered for a different item');
  }
  const response = item.response;
  if (!isRecord(response)) throw new SchemaError(PROVIDER, 'ELTA returned an item without a response');
  const flag = flagOf(response.out_flag);
  // Flag 4 shows the notice in out_title. Only the tracker's "no history"
  // wording is a missing item; another notice says nothing about it.
  if (flag === 4) {
    if (NO_HISTORY.has(clean(response.out_title, 100))) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'ELTA returned a notice instead of the item history');
  }
  if (flag !== 0) throw new IndeterminateError(PROVIDER, 'ELTA did not return the item history');
  const slots = response.out_status;
  const count = flagOf(response.out_counter);
  if (!Array.isArray(slots) || slots.length > MAX_SLOTS || !Number.isInteger(count) || count < 0 || count > slots.length) {
    throw new SchemaError(PROVIDER, 'ELTA returned an invalid item history');
  }

  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  slots.slice(0, count).forEach((slot) => {
    if (!isRecord(slot)) throw new SchemaError(PROVIDER, 'ELTA returned an invalid scan');
    const day = clean(slot.out_date, 16);
    // The tracker skips a slot without a date.
    if (!day) return;
    const time = wallClock(day, clean(slot.out_time, 16));
    const description = clean(slot.out_status_name, 300);
    if (!time || !description) throw new SchemaError(PROVIDER, 'ELTA returned a scan without a clock or wording');
    const station = clean(slot.out_station, 160);
    const event: CarrierEvent = { local_time: time, description, ...(station ? { location: station } : {}) };
    const identity = JSON.stringify(event);
    if (seen.has(identity)) return;
    seen.add(identity);
    events.push(event);
  });
  if (!events.length) throw new IndeterminateError(PROVIDER, 'ELTA returned no scans');
  // Newest first, as the tracker lists them; equal clocks keep its order.
  if (listsNewestFirst(events) === false) events.reverse();
  events.sort((left, right) => right.local_time! > left.local_time! ? 1 : right.local_time! < left.local_time! ? -1 : 0);

  // Oldest first: a notice keeps the stage of the scan before it.
  let previous: Stage | undefined;
  for (const event of [...events].reverse()) {
    if (isEltaNotice(event.description!)) {
      if (previous) Object.assign(event, { stage: previous, stage_source: 'none' });
      continue;
    }
    const classified = eltaStage(event.description!);
    if (classified) Object.assign(event, { stage: classified.stage, stage_source: classified.source });
    previous = classified?.stage;
  }

  const decider = events.find(event => !isEltaNotice(event.description!)) ?? events[0]!;
  const stage = decider.stage as Stage | undefined;
  // The station an item waits at is its pickup point. A delivered item was
  // collected there when it waited there last before the delivery.
  const deciderIndex = events.indexOf(decider);
  const waiting = stage === 'ready_for_pickup' ? decider
    : stage === 'delivered' && lastMovement(events.slice(deciderIndex + 1)) === 'ready_for_pickup'
      ? events.slice(deciderIndex + 1).find(event => event.stage === 'ready_for_pickup' && !isEltaNotice(event.description!))
      : undefined;
  const point = waiting?.location ?? '';

  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: decider.stage_source } : {}),
    last_status_text: decider.description!,
    last_update: null,
    last_update_local: events[0]!.local_time!,
    expected_delivery: null,
    ...(point ? { pickup_point: point } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
