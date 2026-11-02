import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { isRecord } from '../../core/types.js';
import { anterajaStatus } from './status.js';

export const PROVIDER = 'Anteraja';
export const ANTERAJA_MAX_BYTES = 1_000_000;

/** Whole domestic waybills; booking references are a separate input on the website. */
export function normalizeAnterajaNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^\d{14}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Anteraja requires a fourteen-digit waybill');
  return number;
}

function localClock(value: unknown): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    const clock = DateTime.fromFormat(value, 'yyyy-MM-dd HH:mm:ss', { zone: 'UTC' });
    if (clock.isValid && clock.toFormat('yyyy-MM-dd HH:mm:ss') === value) return value.replace(' ', 'T');
  }
  throw new SchemaError(PROVIDER, 'Anteraja returned an invalid scan clock');
}

/** The mobile guest reply repeats the waybill; HTTP 200 can still report a refused request. */
export function parseAnteraja(payload: unknown, raw: string): CarrierResult {
  const number = normalizeAnterajaNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Anteraja returned an invalid tracking envelope');
  if (payload.status === 429) throw new RateLimitedError(PROVIDER);
  if (payload.status === 401 || payload.status === 403) throw new ChallengeError(PROVIDER, 'Anteraja refused guest tracking');
  if (payload.status === 404 && payload.info === 'NOT FOUND' && payload.content == null) throw new NotFoundError(PROVIDER);
  if (payload.status !== 200) throw new IndeterminateError(PROVIDER, 'Anteraja could not answer the tracking request');
  if (!Array.isArray(payload.content) || payload.content.length > 1) throw new SchemaError(PROVIDER, 'Anteraja returned an invalid shipment list');
  if (!payload.content.length) throw new NoHistoryError(PROVIDER);
  const shipment: unknown = payload.content[0];
  if (!isRecord(shipment) || shipment.awb !== number || !isRecord(shipment.detail)
    || (shipment.detail.waybill != null && shipment.detail.waybill !== number)) {
    throw new IndeterminateError(PROVIDER, 'Anteraja answered for another waybill');
  }
  if (!Array.isArray(shipment.history) || shipment.history.length > 500) throw new SchemaError(PROVIDER, 'Anteraja returned an invalid history');
  if (!shipment.history.length) throw new NoHistoryError(PROVIDER);
  const events: CarrierEvent[] = shipment.history.map((row: unknown) => {
    if (!isRecord(row) || !isRecord(row.message) || typeof row.message.id !== 'string' || row.message.id.length > 4000) {
      throw new SchemaError(PROVIDER, 'Anteraja returned an invalid scan');
    }
    const code = typeof row.tracking_code === 'number' || typeof row.tracking_code === 'string' ? String(row.tracking_code) : '';
    if (!/^\d{1,4}$/.test(code)) throw new SchemaError(PROVIDER, 'Anteraja returned an invalid scan code');
    const status = anterajaStatus(code);
    // Only the hub-labelled part of these facility scans names a location.
    const location = ['300', '334', '500'].includes(code)
      ? /\bhub\s+([\p{L} .'-]{2,80})(?=\s*\(|[.!]?\s*$)/iu.exec(row.message.id)?.[1]?.replace(/[.\s]+$/, '').trim()
      : undefined;
    return { local_time: localClock(row.timestamp), provider_code: code, description: status.wording,
      ...(location ? { location } : {}), ...(status.stage ? { stage: status.stage, stage_source: 'carrier_map' as const } : {}) };
  });
  // The guest API lists newest first, including tied clocks. Do not invent offsets or re-order ties.
  const newest = events[0]!;
  const stage = anterajaStatus(newest.provider_code!).stage;
  const service = shipment.detail.service_code;
  if (service != null && (typeof service !== 'string' || !/^[A-Z0-9_-]{1,32}$/.test(service))) throw new SchemaError(PROVIDER, 'Anteraja returned an invalid service code');
  return { status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    provider_code: newest.provider_code!, last_status_text: newest.description!, last_update: null,
    last_update_local: newest.local_time!, expected_delivery: null,
    ...(service ? { service_name: service } : {}), events: events.slice(0, 100),
    ...(events.length > 100 ? { history_truncated: true } : {}) };
}
