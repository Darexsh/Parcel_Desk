import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { saudiPostStage } from './status.js';

export const PROVIDER = 'Saudi Post';
// A long history is under ten kilobytes.
export const SAUDI_POST_MAX_BYTES = 512 * 1024;
// The tracker's own check for its numbers: letters, or one digit, then digits, then two
// letters or a digit. Digit runs are Naqel's waybills, which the tracker also takes.
const NUMBER = /^(?:[A-Z]{1,9}|\d)\d{4,25}(?:[A-Z]{2}|\d)$/;
const DIGITS = /^\d+$/;
const CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const DATE = /^(\d{4}-\d{2}-\d{2})(?:T00:00:00)?$/;
// The step of a scan that only announces the parcel: its office is the sender's.
const ANNOUNCED = 12;
const MAX_SHIPMENTS = 20;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A number for SPL's tracker, in upper case as the page sends it; anything else is not one SPL issues. */
export function normalizeSaudiPostNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number) || DIGITS.test(number)) {
    throw new InvalidInputError(PROVIDER, 'Saudi Post numbers mix letters and digits; digit runs are Naqel waybills');
  }
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Saudi Post returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A scan's clock, the wall clock the page shows, to the second. */
function scanClock(row: Record<string, unknown>): string {
  const local = text(row, 'EventDateTime', 32);
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!CLOCK.test(local) || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'Saudi Post returned an invalid scan time');
  }
  return local;
}

/**
 * The office the page shows under a scan. An office the reply has no name for
 * reads "<country> - <code>", and the country can be wrong there, so it is no place.
 */
function office(row: Record<string, unknown>, step: number): string {
  const name = text(row, 'Office', 120);
  const code = text(row, 'OfficeCode', 32);
  if (step === ANNOUNCED || /^(?:NA|N\/A|-+)$/i.test(name)) return '';
  if (code && name.toUpperCase().endsWith(` - ${code.toUpperCase()}`)) return '';
  return name;
}

// SPL's own "on its way to" scan shows the office the parcel goes to under it,
// and some name it in the line too. The origin post's "on its way to destination"
// shows the office it left.
const BOUND = /\bon its way to(?:\s+(.+))?$/i;

/** A scan's line and place: the office a parcel is on its way to completes the line and is not where it is. */
function placed(line: string, location: string): { description: string; location: string } {
  const bound = BOUND.exec(line);
  if (!bound || !location) return { description: line, location };
  if (!bound[1]) return { description: `${line} ${location}`, location: '' };
  return bound[1].toUpperCase() === location.toUpperCase() ? { description: line, location: '' } : { description: line, location };
}

function projectRow(row: Record<string, unknown>): { key: string; event: CarrierEvent } {
  const step = row.Status;
  if (typeof step !== 'number' || !Number.isInteger(step) || step < 0 || step > 999) {
    throw new SchemaError(PROVIDER, 'Saudi Post returned a scan without its step');
  }
  const line = text(row, 'EventDescription') || text(row, 'StatusMessage');
  if (!line) throw new SchemaError(PROVIDER, 'Saudi Post returned a scan without wording');
  const local = scanClock(row);
  const code = String(step);
  const { description, location } = placed(line, office(row, step));
  const staged = saudiPostStage(code, description);
  const event: CarrierEvent = {
    local_time: local,
    ...(location ? { location } : {}),
    description,
    provider_code: code,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([local, code, description, location]), event };
}

/** The delivery estimate, a calendar day, or nothing. */
function estimate(shipment: Record<string, unknown>): string | null {
  const day = DATE.exec(text(shipment, 'EstimatedDeliveryDate', 32))?.[1];
  return day && DateTime.fromISO(day, { zone: 'UTC' }).isValid ? day : null;
}

/**
 * The reply of the tracking page's `/umbraco/api/tools/trackshipment` for one
 * number: a list with one shipment per number it found. For a number it does
 * not know, the list holds one shipment whose fields are all null, which the
 * page reports as "No data matches entered tracking number". The shipment must
 * name the number asked.
 */
export function parseSaudiPost(payload: unknown, raw: string): CarrierResult {
  const number = normalizeSaudiPostNumber(raw);
  if (!Array.isArray(payload) || !payload.length || payload.length > MAX_SHIPMENTS || !payload.every(isRecord)) {
    throw new SchemaError(PROVIDER, 'Saudi Post returned an invalid shipment list');
  }
  const named = payload.filter((shipment) => shipment.TrackingCode !== null && shipment.TrackingCode !== undefined);
  if (!named.length) throw new NotFoundError(PROVIDER);
  if (named.some((shipment) => typeof shipment.TrackingCode !== 'string')) {
    throw new SchemaError(PROVIDER, 'Saudi Post returned a shipment without its number');
  }
  const shipment = named.find((candidate) => clean(candidate.TrackingCode, 64).toUpperCase() === number);
  if (!shipment) throw new IndeterminateError(PROVIDER, 'Saudi Post answered for another shipment');
  const rows = shipment.TrackingInfoItemList ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Saudi Post returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Saudi Post returned an oversized history');

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Saudi Post returned an invalid scan');
    const scan = projectRow(row);
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    events.push(scan.event);
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // The reply lists the scans oldest first and the page shows them the other way round.
  const newestFirst = events.reverse();

  const newest = newestFirst[0]!;
  const staged = newestFirst.find((event) => event.stage);
  const stage = staged?.stage as Stage | undefined;
  const expected = stage === 'delivered' || stage === 'returned' ? null : estimate(shipment);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: expected,
    events: newestFirst.slice(0, MAX_EVENTS),
    ...(newestFirst.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
