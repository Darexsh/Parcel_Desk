import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { returnedTrackingNumber } from '../../core/detection/returned.js';
import {
  ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError,
} from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean, textFromHtml } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { linearStage } from './status.js';

export const PROVIDER = 'Linear Logistics';
export const LINEAR_MAX_BYTES = 256 * 1024;
// The DX secure-delivery references in Linear's own tracking history.
const NUMBER = /^70\d{8}$/;
const DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
// The feed appends future delivery dates and windows to actual scan wording.
const ESTIMATE = /\s*\((?:ETA:|Due for delivery\b)[^)]*\)/gi;
const RECEIVER = /\s+(?:and\s+)?(?:received|signed|collected)\s+by\b(?!\s+DX\b)[\s\S]*$/i;
const DELIVERY_PLACE = /\b(delivered|left)\s+(?:to|at)\b[\s\S]*$/i;
const PRIVATE = /https?:\/\/|mailto:|tel:|\S+@\S+|\b(?:OTP|PIN)\s*[:=]?\s*\d|(?<![A-Z\d])\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/i;

export function normalizeLinearNumber(raw: string): string {
  const number = raw.length <= 128 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Linear Logistics cannot look up this tracking number');
  return number;
}

function invalid(message: string): never {
  throw new SchemaError(PROVIDER, message);
}

function text(row: Record<string, unknown>, field: string, limit = 500): string {
  const value = row[field];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') invalid('Linear Logistics returned an invalid text field');
  return clean(value, limit);
}

/** Keep the activity without the receiver, delivery place, contact or future estimate. */
export function linearWording(raw: string): string {
  let wording = textFromHtml(raw, 4_000).replace(ESTIMATE, '').replace(RECEIVER, '');
  // This fixed activity names no actual address; it is evidence of an attempted delivery.
  if (!/^Calling card has been left at the address[.\s]*$/i.test(wording)) wording = wording.replace(DELIVERY_PLACE, '$1');
  const privateAt = wording.search(PRIVATE);
  if (privateAt >= 0) wording = wording.slice(0, privateAt);
  return clean(wording, 500).replace(/[\s|,;:.\-–]+$/, '');
}

/** The page displays these date and time strings directly, without a zone. */
function wallClock(row: Record<string, unknown>): string {
  const date = DATE.exec(text(row, 'date', 32));
  const clock = CLOCK.exec(text(row, 'time', 32));
  const day = date ? calendarDay(Number(date[3]), Number(date[2]), Number(date[1])) : null;
  if (!day || day < '2000-01-01' || !clock) invalid('Linear Logistics returned an invalid scan time');
  return `${day}T${clock[1]}:${clock[2]}:00`;
}

function refusal(payload: Record<string, unknown>): never {
  const error = payload.error;
  if (!isRecord(error) || !Array.isArray(error.message) || error.message.length !== 1 || typeof error.message[0] !== 'string'
    || !Number.isSafeInteger(error.status_code) || Number(error.status_code) < 100 || Number(error.status_code) > 599) {
    invalid('Linear Logistics returned an invalid refusal');
  }
  if (payload.data !== undefined && (!Array.isArray(payload.data) || payload.data.length)) {
    invalid('Linear Logistics returned data under a refusal');
  }
  if (error.status_code === 200 && error.message[0] === 'That tracking code was not found') throw new NotFoundError(PROVIDER);
  if (error.status_code === 429) throw new RateLimitedError(PROVIDER);
  if (error.status_code === 401 || error.status_code === 403) throw new ChallengeError(PROVIDER, 'Linear Logistics refused the tracking lookup');
  throw new IndeterminateError(PROVIDER, 'Linear Logistics did not complete the lookup');
}

/**
 * Linear's guest lookup names the whole lpn on every row and relays DX scans.
 * A matching customer reference or one matching row cannot bind a mixed history.
 */
export function parseLinear(payload: unknown, raw: string): CarrierResult {
  const number = normalizeLinearNumber(raw);
  if (!isRecord(payload) || typeof payload.success !== 'boolean') invalid('Linear Logistics returned an invalid envelope');
  if (!payload.success) refusal(payload);
  if (payload.error !== undefined && payload.error !== null) invalid('Linear Logistics returned an error beside its history');
  if (!Array.isArray(payload.data)) invalid('Linear Logistics returned invalid scans');
  if (payload.data.length > MAX_ROWS) invalid('Linear Logistics returned an oversized history');
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of payload.data) {
    if (!isRecord(row)) invalid('Linear Logistics returned an invalid scan');
    const identity = returnedTrackingNumber(row.lpn);
    if (!NUMBER.test(identity)) invalid('Linear Logistics returned a scan without its whole tracking number');
    if (identity !== number) throw new IndeterminateError(PROVIDER, 'Linear Logistics answered for another shipment');
    if (typeof row.carrier !== 'string') invalid('Linear Logistics returned a scan without its carrier');
    if (row.carrier.trim().toUpperCase() !== 'DX') {
      throw new IndeterminateError(PROVIDER, 'Linear Logistics returned an unverified carrier feed');
    }
    const local = wallClock(row);
    const description = linearWording(text(row, 'description', 4_000));
    if (!description) invalid('Linear Logistics returned a scan without its activity');
    const place = text(row, 'location', 200);
    const location = place === '-' || PRIVATE.test(place) ? '' : place;
    const key = JSON.stringify([local, description, location]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = linearStage(description);
    events.push({ local_time: local, description, ...(location ? { location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) });
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  if (listsNewestFirst(events) === false) events.reverse();
  events.sort((a, b) => String(b.local_time).localeCompare(String(a.local_time)));
  const newest = events[0]!;
  const staged = events.find((event) => event.stage);
  const stage = staged?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source } : {}),
    last_status_text: newest.description!, last_update: null, last_update_local: newest.local_time,
    expected_delivery: null,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
