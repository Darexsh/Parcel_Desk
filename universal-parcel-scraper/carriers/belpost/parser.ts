import { DateTime } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { belpostStage } from './status.js';

export const PROVIDER = 'Belpost';
// A long history is a few kilobytes, with a small barcode image beside it.
export const BELPOST_MAX_BYTES = 512 * 1024;

const MAX_STEPS = 500;
const CLOCK = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/**
 * Belpost's tracker takes S10 item codes only: its own, ending BY, and those
 * of the posts that send mail to Belarus. The code needs a valid check digit.
 */
export function normalizeBelpostNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (isValidS10TrackingNumber(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Belpost tracks S10 item codes');
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength: number): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Belpost returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A scan's numeric code, kept for review: Belpost's scans and another post's are numbered apart. */
function code(step: Record<string, unknown>): string {
  const value = step.code;
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && /^\d{1,6}$/.test(value.trim())) return value.trim();
  throw new SchemaError(PROVIDER, 'Belpost returned an invalid scan code');
}

/**
 * A scan's `created_at`, "2026-03-03 15:28:15": the wall clock of the office
 * that scanned the item, with no zone. Another post's scans keep its own
 * clock, and the reply's `timestamp` reads every clock as Minsk time, so it
 * dates none of them.
 */
function wallClock(value: string): string {
  const local = value.replace(' ', 'T');
  // Parsing in UTC checks the calendar fields only; no offset is assigned.
  const parsed = CLOCK.test(value) ? DateTime.fromISO(local, { zone: 'UTC' }) : null;
  if (!parsed?.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'Belpost returned an invalid scan time');
  }
  return local;
}

function scanOf(step: unknown): CarrierEvent {
  if (!isRecord(step)) throw new SchemaError(PROVIDER, 'Belpost returned an invalid scan');
  const description = text(step, 'event', 200);
  if (!description) throw new SchemaError(PROVIDER, 'Belpost returned a scan without wording');
  const local = wallClock(text(step, 'created_at', 32));
  const location = text(step, 'place', 120);
  const provider = code(step);
  const staged = belpostStage(description);
  return {
    local_time: local,
    ...(location ? { location } : {}),
    description,
    ...(provider ? { provider_code: provider } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/**
 * The reply of the tracker's `POST /api/v1/tracking` for one code: `data`
 * holds one entry naming the code, with its scans newest first. An entry
 * without scans is the page's "no data on this tracking number yet", which
 * it gives a code it never saw and one whose records expired.
 */
export function parseBelpost(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeBelpostNumber(rawNumber);
  if (!isRecord(payload) || !Array.isArray(payload.data)) throw new SchemaError(PROVIDER, 'Belpost returned an invalid reply');
  if (!payload.data.length) throw new IndeterminateError(PROVIDER, 'Belpost returned no entry for the code');
  if (payload.data.length !== 1) throw new SchemaError(PROVIDER, 'Belpost returned several items for one code');
  const item: unknown = payload.data[0];
  if (!isRecord(item) || typeof item.number !== 'string') throw new SchemaError(PROVIDER, 'Belpost returned an item without its code');
  if (normalizeTrackingNumber(clean(item.number, 64)) !== number) throw new SchemaError(PROVIDER, 'Belpost answered for a different item');
  if (!Array.isArray(item.steps)) throw new SchemaError(PROVIDER, 'Belpost returned an item with invalid scans');
  if (!item.steps.length) throw new NotFoundError(PROVIDER);
  if (item.steps.length > MAX_STEPS) throw new SchemaError(PROVIDER, 'Belpost returned an oversized history');

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  item.steps.forEach((step) => {
    const event = scanOf(step);
    // A scan the reply lists twice is kept once.
    const identity = JSON.stringify(event);
    if (seen.has(identity)) return;
    seen.add(identity);
    events.push(event);
  });
  // Newest first by wall clock, as the page lists them; scans at the same second keep the reply's order.
  if (listsNewestFirst(events) === false) events.reverse();
  events.sort((left, right) => right.local_time! > left.local_time! ? 1 : right.local_time! < left.local_time! ? -1 : 0);

  const latest = events[0]!;
  const current = events.find(event => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: null,
    last_update_local: latest.local_time!,
    expected_delivery: null,
    events,
  };
}
