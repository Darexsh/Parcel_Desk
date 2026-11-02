import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { colliveryStage, colliveryStatusStage } from './status.js';

export const PROVIDER = 'MDS Collivery';
// A reply is about ten kilobytes, most of it the WhatsApp QR code.
export const COLLIVERY_MAX_BYTES = 512 * 1024;
// A waybill is Collivery's booking id, printed without zeros in front.
const NUMBER = /^[1-9]\d{5,8}$/;
const ZONE = 'Africa/Johannesburg';
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A Collivery waybill number; anything else is not one Collivery issues. */
export function normalizeColliveryNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Collivery waybills are six to nine digits');
  return number;
}

/** A required text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Collivery returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** The waybill a reply is for, which it gives as a number. */
function waybillOf(data: Record<string, unknown>): string {
  const value = data.waybill;
  const waybill = typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value)
    : typeof value === 'string' && /^\d{1,12}$/.test(value.trim()) ? value.trim() : '';
  if (!waybill) throw new SchemaError(PROVIDER, 'Collivery returned a reply without its waybill');
  return waybill;
}

/**
 * A scan's instant. The reply gives Unix seconds, which the page shows in the
 * browser's zone; they match the South African wall clocks of the API's status
 * history for the same scans, and are shown at that offset.
 */
function instantOf(row: Record<string, unknown>): { time: string; millis: number } {
  const value = row.time;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new SchemaError(PROVIDER, 'Collivery returned an invalid scan time');
  const instant = DateTime.fromSeconds(value, { zone: ZONE });
  const time = instant.isValid ? instant.toISO({ suppressMilliseconds: true }) : null;
  if (!time) throw new SchemaError(PROVIDER, 'Collivery returned an invalid scan time');
  return { time, millis: instant.toMillis() };
}

// A run of nine or more digits, with spaces, brackets, dots or hyphens between
// them, as phone numbers are written.
const PHONE = /(?<![A-Z\d])\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
// Who signed for or took the parcel, after the step it ends: "Delivered, signed by …".
const RECEIVER = /\s*[,;:.\-–(]?\s*\b(?:signed(?:\s+for)?|received|collected|accepted)\s+by\b[\s\S]*$/i;

/** A scan's line without the name of whoever took the parcel, or a phone number. */
export function colliveryWording(line: string): string {
  const receiver = RECEIVER.exec(line);
  const own = receiver && receiver.index > 0 ? line.slice(0, receiver.index) : line;
  return clean(own.replace(PHONE, '')).replace(/[\s,;:\-–(]+$/, '');
}

// The branch a "Received in … branch" line names.
const BRANCH = /^Received in (.+?) branch$/i;

interface Scan {
  event: CarrierEvent;
  millis: number;
  index: number;
}

function projectRow(row: Record<string, unknown>, index: number): Scan {
  const description = colliveryWording(text(row, 'text'));
  if (!description) throw new SchemaError(PROVIDER, 'Collivery returned a scan without wording');
  // `type` is `status` for Collivery's own steps, `international` for a partner's.
  if (!/^[a-z_]{1,32}$/.test(text(row, 'type', 40))) throw new SchemaError(PROVIDER, 'Collivery returned an invalid scan type');
  const { time, millis } = instantOf(row);
  const branch = clean(BRANCH.exec(description)?.[1], 80);
  const staged = colliveryStage(description);
  const event: CarrierEvent = {
    time,
    ...(branch ? { location: branch } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { event, millis, index };
}

/**
 * The reply of `ajax/waybill/tracking/{waybill}`, the lookup collivery.net's
 * tracking page makes: `{"data":{…}}` with the current status over a progress
 * rail, the waybill, the collection and delivery addresses, the history oldest
 * first and support links. The waybill must be the one asked. The addresses,
 * which name the recipient, are not read.
 */
export function parseCollivery(payload: unknown, raw: string): CarrierResult {
  const number = normalizeColliveryNumber(raw);
  if (!isRecord(payload) || !isRecord(payload.data)) throw new SchemaError(PROVIDER, 'Collivery returned an invalid envelope');
  const data = payload.data;
  if (waybillOf(data) !== number) throw new IndeterminateError(PROVIDER, 'Collivery answered for another waybill');
  if (!isRecord(data.status)) throw new SchemaError(PROVIDER, 'Collivery returned a waybill without its status');
  const current = text(data.status, 'text', 120);
  const rows = data.history ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Collivery returned an invalid history');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Collivery returned an oversized history');

  const seen = new Set<string>();
  const scans: Scan[] = [];
  rows.forEach((row, index) => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Collivery returned an invalid scan');
    const scan = projectRow(row, index);
    const key = JSON.stringify([scan.millis, scan.event.description]);
    if (seen.has(key)) return;
    seen.add(key);
    scans.push(scan);
  });
  // Newest first; scans of the same second take the later row first.
  const events = scans.sort((left, right) => right.millis - left.millis || right.index - left.index).map(({ event }) => event);
  if (!events.length && !current) throw new NoHistoryError(PROVIDER);

  // The current status covers steps the history leaves out; billing and booking changes defer to the scans.
  const summary = current ? colliveryStatusStage(current) : undefined;
  const scanned = events.find((event) => event.stage);
  const stage = (summary ?? scanned?.stage) as Stage | undefined;
  const source = summary ? 'carrier_map' : scanned?.stage_source;
  const newest = events[0];
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && source ? { current_stage: stage, current_stage_source: source } : {}),
    last_status_text: current || newest?.description || null,
    last_update: newest?.time ?? null,
    expected_delivery: null,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length ? {} : { summary_only: true }),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
