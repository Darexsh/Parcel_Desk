import { DateTime } from 'luxon';
import { isValidS10TrackingNumber } from '../../core/detection/s10.js';
import { ChallengeError, IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { countryCode, firstOccurrence } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { ukrposhtaReturnCue, ukrposhtaStatus } from './status.js';

const PROVIDER = 'ukrposhta';
const MAX_SCANS = 500;

export function normalizeUkrposhtaNumber(raw: string): string {
  const number = raw.trim().replace(/[\s-]+/g, '').toUpperCase();
  if (/^\d{13}$/.test(number) || isValidS10TrackingNumber(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Ukrposhta requires a 13-digit domestic or valid S10 postal reference');
}

function text(value: unknown, field: string, required = false): string {
  if (value != null && typeof value !== 'string') throw new SchemaError(PROVIDER, `Ukrposhta returned an invalid ${field}`);
  const result = clean(value, 300);
  if (required && !result) throw new SchemaError(PROVIDER, `Ukrposhta omitted ${field}`);
  return result;
}

function envelope(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new SchemaError(PROVIDER, 'Ukrposhta returned an invalid tracking response');
  if (value.code === 'captcha_failed') throw new ChallengeError(PROVIDER, 'Ukrposhta rejected automatic browser verification');
  return value;
}

/** Validate calendar digits without assigning a timezone to the wall clock. */
export function ukrposhtaWallClock(value: string): string | null {
  const raw = value.trim();
  const format = /^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}$/.test(raw) ? 'dd.MM.yyyy HH:mm'
    : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(raw) ? "yyyy-MM-dd'T'HH:mm:ss" : null;
  if (!format) return null;
  const date = DateTime.fromFormat(raw, format, { zone: 'UTC' });
  return date.isValid && date.toFormat(format) === raw ? date.toFormat("yyyy-MM-dd'T'HH:mm:ss") : null;
}

/**
 * A scan in Ukraine is dated on Kyiv time. The minute is the precision both
 * sources share, so the status API and the portal date one scan alike. A wall
 * clock the zone skips or repeats stays local.
 */
function kyivTime(local: string): string | null {
  const minute = `${local.slice(0, 16)}:00`;
  const parsed = firstOccurrence(DateTime.fromISO(minute, { zone: 'Europe/Kyiv' }));
  if (!parsed.isValid || parsed.toISO({ includeOffset: false, suppressMilliseconds: true }) !== minute
    || parsed.getPossibleOffsets().length !== 1) return null;
  return parsed.toISO({ suppressMilliseconds: true });
}

export interface UkrposhtaOverview {
  number: string;
  count: number;
  date: string;
  code: string;
  label: string;
  location: string;
  country: string;
}

export function parseUkrposhtaOverview(payload: unknown, requested: string): UkrposhtaOverview {
  const number = normalizeUkrposhtaNumber(requested);
  const data = envelope(payload);
  // The native unknown response has no returned barcode. It cannot prove
  // absence for this reference, even though the page calls it not found. Its
  // reason tells a host the portal missed it, not that the history was unsettled.
  if (isRecord(data.result) && data.result.message === 'Shipment not found') throw new IndeterminateError(PROVIDER, undefined, { reason: 'portal_not_found' });
  if (!Array.isArray(data.result)) throw new SchemaError(PROVIDER, 'Ukrposhta omitted its parcel overview');
  if (!data.result.length) throw new IndeterminateError(PROVIDER);
  if (data.result.length !== 1) throw new IndeterminateError(PROVIDER, 'Ukrposhta returned an ambiguous parcel overview');
  const row: unknown = data.result[0];
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Ukrposhta returned an invalid parcel overview');
  if (text(row.barcode, 'overview identity', true).toUpperCase() !== number) throw new SchemaError(PROVIDER, 'Ukrposhta returned a different parcel identity');
  if (!Number.isInteger(row.step) || Number(row.step) < 1 || Number(row.step) > MAX_SCANS) throw new IndeterminateError(PROVIDER, 'Ukrposhta returned an unresolved history count');
  return { number, count: Number(row.step), date: text(row.date, 'overview clock'), code: text(row.event, 'overview event code', true),
    label: text(row.eventName, 'overview status', true), location: text(row.name, 'overview location'), country: text(row.country, 'overview country') };
}

interface ScanRow { date: string; code: string; label: string; location: string; country: string; reason: string }

/**
 * The name the API gives an office of exchange, and an airport or another post's scan abroad: the
 * kind of facility, not a place. The row keeps its country.
 */
const FACILITY_KIND = /^terminal$/i;

/** One result from current-first scans, following a return decision into its own leg. */
function project(rows: ScanRow[]): CarrierResult {
  const latest = rows[0]!;
  // Both native histories are current-first. Keep that order across foreign
  // wall clocks or missing dates instead of sorting them as instants. A row
  // naming Ukraine is a Ukrposhta scan; others keep the clock they were given.
  let returnLeg = false;
  const events = new Array<CarrierEvent>(rows.length);
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]!;
    if (ukrposhtaReturnCue(row.label)) returnLeg = true;
    let classified = ukrposhtaStatus(row.code);
    if (row.reason === '65' || row.reason === '66') classified = { status: 'exception', stage: 'exception' };
    if (classified?.stage === 'delivered' && returnLeg) classified = { status: 'exception', stage: 'returned' };
    const local = ukrposhtaWallClock(row.date);
    const time = local && countryCode(row.country) === 'UA' ? kyivTime(local) : null;
    const site = FACILITY_KIND.test(row.location) ? '' : row.location;
    events[index] = {
      description: row.label, provider_code: row.code,
      ...(site || row.country ? { location: [site, row.country].filter(Boolean).join(', ') } : {}),
      ...(time ? { time } : local ? { local_time: local } : row.date ? { provider_time_text: row.date } : {}),
      ...(classified ? { stage: classified.stage } : {}), ...(returnLeg ? { provider_leg: 'return' } : {}),
    };
  }
  const current = events[0]!;
  const stage = current.stage;
  const status = stage === 'returned' || stage === 'exception' ? 'exception' : ukrposhtaStatus(latest.code)?.status ?? 'unknown';
  const seen = new Set<string>();
  const deduplicated = events.filter(event => { const key = JSON.stringify(event); if (seen.has(key)) return false; seen.add(key); return true; });
  // A delivery scan in Ukraine has an instant to date the delivery; a foreign one keeps its wall clock.
  return { status, ...(stage ? { current_stage: stage } : {}), last_status_text: latest.label, last_update: current.time ?? null,
    ...(stage === 'delivered' && current.time ? { delivered_at: current.time } : {}), events: deduplicated.slice(0, 100) };
}

/**
 * The status-tracking API's reply to one barcode: a bare array of scans, each naming the
 * barcode and its position in the history.
 */
export function parseUkrposhtaStatuses(payload: unknown, requested: string): CarrierResult {
  const number = normalizeUkrposhtaNumber(requested);
  if (!Array.isArray(payload)) throw new SchemaError(PROVIDER, 'Ukrposhta returned an invalid tracking response');
  if (!payload.length) throw new IndeterminateError(PROVIDER);
  if (payload.length > MAX_SCANS) throw new SchemaError(PROVIDER, 'Ukrposhta returned excessive history');
  const steps = new Set<number>();
  const rows = payload.map((raw: unknown) => {
    if (!isRecord(raw)) throw new SchemaError(PROVIDER, 'Ukrposhta returned an invalid history row');
    if (text(raw.barcode, 'history identity', true).toUpperCase() !== number) throw new SchemaError(PROVIDER, 'Ukrposhta returned a different history identity');
    if (!Number.isInteger(raw.step) || Number(raw.step) < 1 || steps.has(Number(raw.step))) throw new SchemaError(PROVIDER, 'Ukrposhta returned an invalid history position');
    steps.add(Number(raw.step));
    if (!['string', 'number'].includes(typeof raw.event)) throw new SchemaError(PROVIDER, 'Ukrposhta returned an invalid scan code');
    const reason = raw.eventReason_id == null ? '' : cleanScalar(raw.eventReason_id, 16);
    if (raw.eventReason_id != null && !/^\d{1,9}$/.test(reason)) throw new SchemaError(PROVIDER, 'Ukrposhta returned an invalid scan reason code');
    return { step: Number(raw.step), date: text(raw.date, 'scan clock'), code: cleanScalar(raw.event, 64),
      label: text(raw.eventName, 'scan status', true), location: text(raw.name, 'scan location'), country: text(raw.country, 'scan country'),
      reason };
  });
  if (rows.some(row => !row.code)) throw new SchemaError(PROVIDER, 'Ukrposhta omitted scan code');
  // The API lists scans oldest first; the position, not the foreign wall clock, orders them.
  return project(rows.sort((a, b) => b.step - a.step));
}

export function parseUkrposhtaHistory(payload: unknown, overview: UkrposhtaOverview): CarrierResult {
  const data = envelope(payload);
  if (!isRecord(data.from_to) || !Array.isArray(data.result)) throw new SchemaError(PROVIDER, 'Ukrposhta omitted its parcel history');
  if (![0, false, '0'].includes(data.from_to.ISSEVERALPLACES as number | boolean | string)
    || data.several_places === true) throw new IndeterminateError(PROVIDER, 'Ukrposhta returned a shipment with multiple pieces');
  // This auxiliary flag is false for both positive histories and unknown
  // references. It is not a barcode-recognition signal.
  if (data.date_by_barcode != null && typeof data.date_by_barcode !== 'boolean') throw new SchemaError(PROVIDER, 'Ukrposhta returned an invalid auxiliary date flag');
  if (!data.result.length) throw new IndeterminateError(PROVIDER);
  if (data.result.length > MAX_SCANS) throw new SchemaError(PROVIDER, 'Ukrposhta returned excessive history');
  if (data.result.length !== overview.count) throw new IndeterminateError(PROVIDER, 'Ukrposhta returned incomplete or changed history');
  const checkIdentity = (value: unknown) => {
    if (value != null && text(value, 'history identity', true).toUpperCase() !== overview.number) throw new SchemaError(PROVIDER, 'Ukrposhta returned a different history identity');
  };
  checkIdentity(data.nod_barcode);
  const rows = data.result.map((raw: unknown) => {
    if (!isRecord(raw)) throw new SchemaError(PROVIDER, 'Ukrposhta returned an invalid history row');
    checkIdentity(raw.nod_barcode);
    return { date: text(raw.gtt_date, 'scan clock'), code: text(raw.gtt_event, 'scan code', true),
      label: text(raw.gtt_event_name, 'scan status', true), location: text(raw.gtt_name, 'scan location'), country: text(raw.gtt_country, 'scan country'),
      reason: text(raw.gtt_eventreason_id, 'scan reason code') };
  });
  const latest = rows[0]!;
  const latestClock = ukrposhtaWallClock(latest.date), overviewClock = ukrposhtaWallClock(overview.date);
  // The overview carries seconds that the full native history omits. Bind
  // at the history's minute precision without promoting overview seconds.
  const sameClock = latestClock !== null && overviewClock !== null
    ? latestClock.slice(0, 16) === overviewClock.slice(0, 16) : latest.date === overview.date;
  if (!sameClock || latest.code !== overview.code || latest.label !== overview.label
    || latest.location !== overview.location || latest.country !== overview.country) throw new IndeterminateError(PROVIDER, 'Ukrposhta overview and current history disagree');

  return project(rows);
}

