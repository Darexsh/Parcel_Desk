import { DateTime } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { cleanScalar, textFromHtml } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { postLuxembourgStage } from './status.js';

export const PROVIDER = 'POST Luxembourg';
// One item's history is a kilobyte or two.
export const POST_LUXEMBOURG_MAX_BYTES = 256_000;

const MAX_ROWS = 500;
const MAX_EVENTS = 100;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CODE = /^[A-Z0-9_]{1,16}$/;
// The service's word for a number it holds no item under.
const NOT_FOUND = 'item.not.found';
// A Luxembourg postcode, which an office's name could carry.
const POSTCODE = /,?\s*\bL-\d{4}\b/g;

/** POST Luxembourg tracks UPU S10 items, its own and those it delivers for other posts. */
export function normalizePostLuxembourgNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (isValidS10TrackingNumber(number)) return number;
  throw new InvalidInputError(PROVIDER, 'POST Luxembourg tracks S10 item codes');
}

/** The scan's day ("2026-03-04"). The service gives no time of day. */
function day(value: unknown): string | null {
  if (typeof value !== 'string' || !DAY.test(value)) return null;
  // UTC only checks the calendar fields. No offset is assigned.
  return DateTime.fromFormat(value, 'yyyy-MM-dd', { zone: 'UTC' }).isValid ? value : null;
}

interface Scan { readonly event: CarrierEvent; readonly order: number }

/**
 * The tracking service's reply: one entry per number asked, naming the
 * number, an error word or the item's events newest first. Each event has a
 * day, a UPU event code, its wording and sometimes the office or facility.
 */
export function parsePostLuxembourg(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizePostLuxembourgNumber(rawNumber);
  if (!isRecord(payload) || !Array.isArray(payload.items)) throw new SchemaError(PROVIDER, 'POST Luxembourg did not return its list of items');
  // One entry, for the one number asked, which it names in capitals.
  const item: unknown = payload.items[0];
  if (payload.items.length !== 1 || !isRecord(item) || typeof item.trackingNumber !== 'string'
    || normalizeTrackingNumber(item.trackingNumber) !== number) {
    throw new SchemaError(PROVIDER, 'POST Luxembourg did not answer for the requested item');
  }
  // The page asks again while a batch is still being looked up; one number is answered at once.
  if (payload.status !== 'DONE') throw new IndeterminateError(PROVIDER, 'POST Luxembourg has not finished the lookup');
  const rows = item.trackedEvents;
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'POST Luxembourg returned an invalid item history');
  if (item.error != null) {
    if (item.error === NOT_FOUND && rows.length === 0) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'POST Luxembourg returned an error instead of the item history');
  }

  const scans: Scan[] = [];
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'POST Luxembourg returned an invalid event');
    const code = cleanScalar(row.eventTypeCode, 16);
    const date = day(row.eventDate);
    if (!CODE.test(code) || !date) throw new SchemaError(PROVIDER, 'POST Luxembourg returned an event without a code or day');
    const location = textFromHtml(row.place, 200).replace(POSTCODE, '').trim();
    const event: CarrierEvent = { local_time: date, description: textFromHtml(row.label, 300) || code, provider_code: code,
      ...(location ? { location } : {}) };
    const identity = JSON.stringify(event);
    if (seen.has(identity)) return;
    seen.add(identity);
    // The service numbers the events from 1, the newest.
    const order = Number.isInteger(row.displayOrder) ? row.displayOrder as number : MAX_ROWS + index;
    scans.push({ event, order });
  });
  if (!scans.length) throw new IndeterminateError(PROVIDER, 'POST Luxembourg returned no events');
  // Newest day first; within a day, the service's own order.
  scans.sort((left, right) => (right.event.local_time! > left.event.local_time! ? 1
    : right.event.local_time! < left.event.local_time! ? -1 : left.order - right.order));
  const events = scans.map(({ event }) => event);
  for (const event of events) {
    const classified = postLuxembourgStage(event.provider_code!, event.description!);
    if (classified) Object.assign(event, { stage: classified.stage, stage_source: classified.source });
  }

  const latest = events[0]!;
  const stage = latest.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: latest.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: null,
    last_update_local: latest.local_time!,
    expected_delivery: null,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
