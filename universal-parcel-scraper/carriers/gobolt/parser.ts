import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { goboltStage } from './status.js';

export const PROVIDER = 'GoBolt';
// A long history is a few kilobytes.
export const GOBOLT_MAX_BYTES = 256 * 1024;
// Twelve letters and digits with at least one digit: the twelve digits and the twelve letters
// and digits of the archived and live replies.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{12}$/;
// An instant with its offset, to the millisecond.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
// A step name, such as label_out_for_delivery.
const CODE = /^[a-z][a-z0-9_]{0,63}$/i;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A number for GoBolt's tracker, in upper case; anything else is not one GoBolt tracks. */
export function normalizeGoboltNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'GoBolt tracking numbers are twelve letters and digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `GoBolt returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * An instant the reply gives with its offset, such as `2026-01-01T09:00:00.000-05:00`,
 * cut to the second and keeping that offset. An empty field is null.
 */
function instant(row: Record<string, unknown>, key: string): { iso: string; millis: number } | null {
  const raw = text(row, key, 64);
  if (!raw) return null;
  const parsed = DateTime.fromISO(raw, { setZone: true });
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!INSTANT.test(raw) || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== raw.slice(0, 19)) {
    throw new SchemaError(PROVIDER, `GoBolt returned an invalid ${key}`);
  }
  return { iso: parsed.startOf('second').toISO({ suppressMilliseconds: true }), millis: parsed.toMillis() };
}

// A digit in a place could be a street number or a postcode; the steps name a facility's town.
const ADDRESS = /\d/;

interface Scan {
  key: string;
  event: CarrierEvent;
  millis: number;
  index: number;
}

function projectRow(row: Record<string, unknown>, index: number, isReturn: boolean): Scan {
  const code = text(row, 'name', 64);
  if (!CODE.test(code)) throw new SchemaError(PROVIDER, 'GoBolt returned a step without its name');
  const description = text(row, 'description');
  if (!description) throw new SchemaError(PROVIDER, 'GoBolt returned a step without wording');
  const time = instant(row, 'created_at');
  if (!time) throw new SchemaError(PROVIDER, 'GoBolt returned a step without its time');
  const place = text(row, 'location', 200);
  const location = place && !ADDRESS.test(place) ? place : '';
  const staged = goboltStage(code, description, isReturn);
  const event: CarrierEvent = {
    time: time.iso,
    ...(location ? { location } : {}),
    description,
    provider_code: code,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([time.iso, code, description, location]), event, millis: time.millis, index };
}

/** Whether the steps the page lays out are a customer's return, which has pickup steps of its own. */
function returnFlow(payload: Record<string, unknown>): boolean {
  const flow = payload.transit_flow ?? [];
  if (!Array.isArray(flow) || flow.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'GoBolt returned an invalid transit flow');
  return flow.some((step) => {
    if (!isRecord(step)) throw new SchemaError(PROVIDER, 'GoBolt returned an invalid transit flow');
    return text(step, 'name', 64).toLowerCase().startsWith('label_return_');
  });
}

/**
 * The reply of `bolt_shipping_labels/search` for one number, the lookup GoBolt's
 * tracking page makes. A number it does not know is HTTP 404 with
 * `Tracking number not found`, and one whose tracking it no longer serves is
 * `Tracking number is expired`. A shipment must name the number asked; its
 * steps, newest first, make the history.
 */
export function parseGobolt(payload: unknown, raw: string): CarrierResult {
  const number = normalizeGoboltNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'GoBolt returned an invalid reply');
  if (payload.type === 'error') {
    const message = text(payload, 'message', 200) || text(payload, 'error_message', 200);
    if (/^Tracking number not found\.?$/i.test(message)) throw new NotFoundError(PROVIDER);
    if (/^Tracking number is expired\.?$/i.test(message)) {
      throw new IndeterminateError(PROVIDER, 'GoBolt no longer serves the tracking of this number', { reason: 'history_expired' });
    }
    throw new IndeterminateError(PROVIDER, 'GoBolt did not complete the lookup');
  }
  if (typeof payload.tracking_number !== 'string') throw new SchemaError(PROVIDER, 'GoBolt returned a shipment without its number');
  // The lookup matches the whole number in any case.
  if (clean(payload.tracking_number, 64).toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'GoBolt answered for another shipment');
  const listed = payload.transit_steps ?? [];
  if (!Array.isArray(listed)) throw new SchemaError(PROVIDER, 'GoBolt returned a shipment with invalid steps');
  const rows: unknown[] = listed;
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'GoBolt returned an oversized history');
  const isReturn = returnFlow(payload);

  const seen = new Set<string>();
  const scans: Scan[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'GoBolt returned an invalid step');
    const scan = projectRow(row, scans.length, isReturn);
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    scans.push(scan);
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the page lists them; steps at one instant keep the reply's order.
  const events = scans.sort((a, b) => b.millis - a.millis || a.index - b.index).map(({ event }) => event);

  const newest = events[0]!;
  const staged = events.find((event) => event.stage);
  const stage = staged?.stage as Stage | undefined;
  const delivered = stage === 'delivered' ? instant(payload, 'label_delivered_at')?.iso ?? staged!.time! : null;
  // The estimate is an instant the page shows as the expected time; its day is kept, in the reply's own offset.
  const estimate = stage === 'delivered' || stage === 'returned' ? null : instant(payload, 'estimated_delivery_date');
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: estimate ? estimate.iso.slice(0, 10) : null,
    ...(delivered ? { delivered_at: delivered } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
