import { DateTime } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { firstOccurrence, postalOfficeZone } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { asyadStage } from './status.js';

export const PROVIDER = 'Asyad Express';
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** The app's express lookup takes a shipment code; its postal fallback takes S10 items. */
export function asyadNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (/^\d{4,40}$/.test(number) || isValidS10TrackingNumber(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Asyad Express requires a numeric shipment code or postal S10 item');
}

function text(value: unknown, max = 500): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) throw new SchemaError(PROVIDER, 'Asyad Express returned invalid scan text');
  return clean(value, max);
}

function clock(value: unknown, postal: boolean, zone: string | null): Pick<CarrierEvent, 'time' | 'local_time' | 'time_zone' | 'time_zone_basis'> {
  const raw = text(value, 64);
  const format = postal ? 'M/d/yyyy h:mm:ss a' : 'MMM-dd-yyyy hh:mm a';
  const shape = postal ? /^\d{1,2}\/\d{1,2}\/\d{4} \d{1,2}:\d{2}:\d{2} [AP]M$/ : /^[A-Z][a-z]{2}-\d{2}-\d{4} \d{2}:\d{2} [AP]M$/;
  const wall = DateTime.fromFormat(raw, format, { zone: 'UTC', locale: 'en' });
  if (!shape.test(raw) || !wall.isValid) throw new SchemaError(PROVIDER, 'Asyad Express returned an invalid scan clock');
  const local_time = wall.toFormat("yyyy-MM-dd'T'HH:mm:ss");
  if (!zone) return { local_time };
  const instant = firstOccurrence(DateTime.fromISO(local_time, { zone }));
  if (!instant.isValid || instant.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local_time) return { local_time };
  return { local_time, time: instant.toISO({ suppressMilliseconds: true }), time_zone: zone, time_zone_basis: 'place' };
}

function result(events: CarrierEvent[], postal: boolean): CarrierResult {
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // Express history arrives newest first; postal history arrives oldest first.
  // Keep that sequence across offices whose local clocks differ.
  if (postal) events.reverse();
  const seen = new Set<string>();
  const unique = events.filter(event => { const key = JSON.stringify(event); if (seen.has(key)) return false; seen.add(key); return true; });
  const newest = unique[0]!;
  const staged = asyadStage(newest.provider_code!, newest.description!);
  return {
    status: staged ? languageStageStatus(staged.stage) : 'unknown',
    ...(staged ? { current_stage: staged.stage, current_stage_source: staged.source } : {}),
    last_status_text: newest.description!, last_update: newest.time ?? null, last_update_local: newest.local_time,
    expected_delivery: null, events: unique.slice(0, MAX_EVENTS),
    ...(postal || unique.length > MAX_EVENTS ? { history_truncated: true } : {}),
    ...(newest.stage === 'delivered' && newest.time ? { delivered_at: newest.time } : {}),
  };
}

/** The app's guest express request is bound to the whole code in its URL path. */
export function parseAsyadExpress(payload: unknown, raw: string, httpStatus = 200): CarrierResult | null {
  const number = asyadNumber(raw);
  if (!isRecord(payload) || typeof payload.success !== 'boolean' || !Array.isArray(payload.data) || payload.data.length > MAX_ROWS) {
    throw new SchemaError(PROVIDER, 'Asyad Express returned an invalid tracking envelope');
  }
  if (httpStatus === 404 && payload.status === 404 && !payload.success && !payload.data.length
    && payload.message === `Not found tracking: ${number}`) return null;
  if (httpStatus !== 200 || payload.status !== 200 || !payload.success) throw new IndeterminateError(PROVIDER, 'Asyad Express did not complete the tracking lookup');
  const events = payload.data.map((row): CarrierEvent => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Asyad Express returned an invalid scan');
    const description = text(row.event_code_en || row.status);
    const code = text(row.statusCode, 32);
    if (!/^S\d{3,5}$/.test(code)) throw new SchemaError(PROVIDER, 'Asyad Express returned an invalid event code');
    // The feed includes foreign scans without a place or zone. Only wording
    // explicitly naming an operation at Muscat establishes an Omani clock.
    const muscat = /^(?:Arrived in Muscat \(Oman\) Hub|Departed From Muscat Hub to destination country)$/i.test(description);
    const staged = asyadStage(code, description);
    return { ...clock(row.statusTime, false, muscat ? 'Asia/Muscat' : null), description, provider_code: code,
      ...(muscat ? { location: 'Muscat, Oman' } : {}), ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) };
  });
  return result(events, false);
}

/** The Oman Post fallback echoes the whole code and relays IPS postal events. */
export function parseOmanPost(payload: unknown, raw: string, httpStatus = 200): CarrierResult {
  const number = asyadNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Oman Post returned an invalid tracking envelope');
  if (httpStatus === 404 && payload.content === null && payload.success === 'false' && isRecord(payload.error)
    && payload.error.errorCode === 'error 01' && payload.error.errorMsg === 'no data found') throw new NotFoundError(PROVIDER);
  if (httpStatus !== 200) throw new IndeterminateError(PROVIDER, 'Oman Post did not complete the tracking lookup');
  if (typeof payload.OrderId !== 'string' || payload.OrderId.length > 64) throw new SchemaError(PROVIDER, 'Oman Post returned no item identity');
  if (normalizeTrackingNumber(payload.OrderId) !== number) throw new IndeterminateError(PROVIDER, 'Oman Post answered for another item');
  if (!Array.isArray(payload.track) || payload.track.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Oman Post returned an invalid history');
  const events = payload.track.map((row): CarrierEvent => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Oman Post returned an invalid scan');
    const description = text(row.Eventdesc);
    const code = text(row.EventCode, 16);
    if (!/^\d{1,4}$/.test(code)) throw new SchemaError(PROVIDER, 'Oman Post returned an invalid event code');
    const location = row.city === '' || row.city == null ? '' : text(row.city, 160);
    const zone = postalOfficeZone(location) ?? (/\bOman\b|^(?:Sohar Post Office|Turaiff Delivery Center)$/i.test(location) ? 'Asia/Muscat' : null);
    const staged = asyadStage(code, description);
    return { ...clock(row.EventDate, true, zone), description, provider_code: code,
      ...(location ? { location } : {}), ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) };
  });
  return result(events, true);
}
