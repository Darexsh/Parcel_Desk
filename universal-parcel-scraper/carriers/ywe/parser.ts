import { DateTime, FixedOffsetZone } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { yweStage } from './status.js';

export const PROVIDER = 'YWE';
// One parcel's reply is a few kilobytes.
export const YWE_MAX_BYTES = 512 * 1024;

// YWE and fourteen digits, as the catalog's `ywe-1` rule reads them.
const NUMBER = /^YWE\d{14}$/;
const OFFSET = /^([+-])(\d{2}):([0-5]\d)$/;
const CODE = /^\d{1,4}$/;
// Scans from 2000 to 2100: anything else is a changed field, not a clock.
const EARLIEST_MS = Date.UTC(2000, 0, 1);
const LATEST_MS = Date.UTC(2100, 0, 1);
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
// Who took a delivered parcel, as a delivery line can name them.
const RECEIVER = /\s*[,;:.\-–]?\s*\b(?:(?:signed|received|collected|accepted)(?:\s+for)?\s+by|signatory|signature)\b.*$/i;

/** A YWE parcel number; anything else is not one its tracker answers. */
export function normalizeYweNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'YWE parcel numbers are YWE and fourteen digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `YWE returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A scan's instant at the offset the tracker states for it. */
function scanTime(row: Record<string, unknown>): { iso: string; timestamp: number } {
  const offset = OFFSET.exec(text(row, 'timeZone', 8));
  const timestamp = row.timestamp;
  if (!offset || Number(offset[2]) > 14 || typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp)
    || timestamp < EARLIEST_MS || timestamp >= LATEST_MS) throw new SchemaError(PROVIDER, 'YWE returned an invalid scan time');
  const minutes = (offset[1] === '-' ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3]));
  // To the second, as the page shows it and other sources give it.
  const second = Math.floor(timestamp / 1000) * 1000;
  const iso = DateTime.fromMillis(second, { zone: FixedOffsetZone.instance(minutes) }).toISO({ suppressMilliseconds: true });
  if (!iso) throw new SchemaError(PROVIDER, 'YWE returned an invalid scan time');
  return { iso, timestamp: second };
}

/** The town, state and country of a scan; the street lines are never read. */
function place(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (!isRecord(value)) throw new SchemaError(PROVIDER, 'YWE returned an invalid scan place');
  return [text(value, 'city', 80), text(value, 'state', 40), text(value, 'country', 40)].filter(Boolean).join(', ');
}

/**
 * The reply of the tracking page's `/server` lookup: a list with an entry per
 * number asked, each its `expressCode` and its scans, newest first. A scan
 * is epoch milliseconds with the hub's offset, a message, a place, the
 * category the page groups parcels by and a code. A number the tracker has
 * nothing for comes back with its `expressCode` alone. Only the entry whose
 * `expressCode` is the whole number asked is read.
 */
export function parseYwe(payload: unknown, raw: string): CarrierResult {
  const number = normalizeYweNumber(raw);
  if (!Array.isArray(payload)) throw new SchemaError(PROVIDER, 'YWE returned an invalid reply');
  const bound = payload.filter((item: unknown) => isRecord(item) && typeof item.expressCode === 'string'
    && normalizeTrackingNumber(item.expressCode) === number) as Record<string, unknown>[];
  if (bound.length !== 1) throw new SchemaError(PROVIDER, 'YWE did not answer for the parcel asked');
  const rows = bound[0]!.events;
  if (rows === undefined || rows === null) throw new NoHistoryError(PROVIDER);
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'YWE returned a parcel with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'YWE returned an oversized history');

  const seen = new Set<string>();
  const scans: { event: CarrierEvent; timestamp: number }[] = [];
  rows.forEach((row: unknown) => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'YWE returned an invalid scan');
    const time = scanTime(row);
    const wording = text(row, 'message');
    const code = text(row, 'operationTip', 8);
    const location = place(row.location);
    // A row without wording says nothing.
    if (!wording) return;
    const staged = yweStage(wording);
    const description = clean(staged?.stage === 'delivered' ? wording.replace(RECEIVER, '') : wording, 300) || wording;
    const key = JSON.stringify([time.timestamp, location, description]);
    if (seen.has(key)) return;
    seen.add(key);
    scans.push({ timestamp: time.timestamp, event: {
      time: time.iso,
      ...(location ? { location } : {}),
      description,
      ...(CODE.test(code) ? { provider_code: code } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  });
  if (!scans.length) throw new NoHistoryError(PROVIDER);

  // Newest first, as the tracker lists them.
  if (listsNewestFirst(scans.map(({ event }) => event)) === false) scans.reverse();
  scans.sort((left, right) => right.timestamp - left.timestamp);
  const events = scans.map((scan) => scan.event);
  const newest = events[0]!;
  const staged = events.find((event) => event.stage);
  const stage = staged?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: null,
    ...(stage === 'delivered' ? { delivered_at: staged!.time! } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
