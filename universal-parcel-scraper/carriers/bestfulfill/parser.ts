import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { bestfulfillStage } from './status.js';

export const PROVIDER = 'BestFulfill Packet';
export const CARRIER = 'bestfulfill';
// A reply is a few kilobytes.
export const BESTFULFILL_MAX_BYTES = 256 * 1024;

const NUMBER = /^BEST\d{14}$/;
const MAX_EVENTS = 300;
// An instant with its offset, as every scan states it.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
// The ZIP code a United States facility's place ends with.
const ZIP = /\s+\d{5}(?:-\d{4})?$/;
// The scan that names the delivery carrier's number: "Last Mile Tracking Number: 9200…".
const LAST_MILE = /^last mile tracking number:\s*([A-Z0-9]{8,40})$/i;

/** A BestFulfill Packet number: BEST and fourteen digits. */
export function normalizeBestfulfillNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'BestFulfill Packet numbers are BEST and fourteen digits');
  return number;
}

const text = (value: unknown, max: number): string => (typeof value === 'string' && value.length <= max * 4 ? clean(value, max) : '');

/** One scan: its instant as stated, its wording, its place without a ZIP code, and its 17TRACK-style sub-status. */
function scanOf(value: unknown): CarrierEvent {
  if (!isRecord(value)) throw new SchemaError(PROVIDER, 'BestFulfill Packet returned an invalid scan');
  const time = typeof value.time === 'string' ? value.time.trim() : '';
  const description = text(value.content, 300);
  const code = text(value.status, 64);
  if (!INSTANT.test(time) || !Number.isFinite(Date.parse(time)) || !description || (code && !/^[A-Za-z]+(?:_[A-Za-z]+)?$/.test(code))) {
    throw new SchemaError(PROVIDER, 'BestFulfill Packet returned an invalid scan');
  }
  const location = text(value.location, 120).replace(ZIP, '');
  const stage = bestfulfillStage(code || null, description);
  return { time, description, ...(location ? { location } : {}), ...(code ? { provider_code: code } : {}),
    ...(stage ? { stage: stage.stage, stage_source: stage.source } : {}) };
}

/**
 * The open tracking service's answer, `GET /openapi/v1/external/tracking?number=`:
 * the number, the origin and destination countries, a summary status and the
 * scans, in no set order, each with an instant and its offset, a place, a
 * wording and a 17TRACK-style sub-status. The number must be the one asked.
 * The summary status is not read; the scans decide.
 */
export function parseBestfulfill(payload: unknown, raw: string): CarrierResult {
  const number = normalizeBestfulfillNumber(raw);
  if (!isRecord(payload) || !Array.isArray(payload.events) || payload.events.length > MAX_EVENTS) {
    throw new SchemaError(PROVIDER, 'BestFulfill Packet returned an invalid reply');
  }
  const shown = typeof payload.number === 'string' && payload.number.length <= 64 ? normalizeTrackingNumber(payload.number) : '';
  if (!shown) throw new SchemaError(PROVIDER, 'BestFulfill Packet returned a reply without the number asked');
  if (shown !== number) throw new IndeterminateError(PROVIDER, 'BestFulfill Packet answered for another number');
  // Scans of one instant keep the reply's order.
  const events = payload.events.map(scanOf).map((event, index) => ({ event, index }))
    .sort((a, b) => Date.parse(b.event.time!) - Date.parse(a.event.time!) || a.index - b.index).map(({ event }) => event);
  const newest = events[0];
  if (!newest) throw new NoHistoryError(PROVIDER, 'BestFulfill Packet has no scans for the shipment yet');
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const destination = text(payload.destCountry, 2).toUpperCase();
  const local = normalizeTrackingNumber(text(payload.localNumber, 40));
  const named = events.map((event) => LAST_MILE.exec(event.description!)?.[1]).find(Boolean);
  const partner = /^[A-Z0-9]{8,40}$/.test(local) ? local : named?.toUpperCase();
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: null,
    ...(/^[A-Z]{2}$/.test(destination) ? { destination_country: destination } : {}),
    ...(partner && partner !== number ? { delivery_tracking_number: partner } : {}),
    events,
  };
}
