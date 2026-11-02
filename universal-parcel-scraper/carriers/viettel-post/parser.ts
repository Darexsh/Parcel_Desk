import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { clean, cleanScalar } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { viettelPostStage } from './status.js';

export const PROVIDER = 'Viettel Post';
export const VIETTEL_MAX_BYTES = 512_000;

export function normalizeViettelPostNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^(?:\d{9,13}|V\d{11})$/.test(number)) throw new InvalidInputError(PROVIDER, 'Viettel Post requires a numeric waybill or V and eleven digits');
  return number;
}

export function isViettelCaptchaError(payload: unknown): boolean {
  return isRecord(payload) && payload.error === true && payload.status === 201 && typeof payload.message === 'string'
    && /captcha/i.test(payload.message);
}

/** The legacy endpoint returns a shipment record, which can lag the history on the current tracker. */
export function parseViettelPost(payload: unknown, raw: string): CarrierResult {
  const number = normalizeViettelPostNumber(raw);
  if (!isRecord(payload) || typeof payload.error !== 'boolean' || typeof payload.status !== 'number') throw new SchemaError(PROVIDER, 'Viettel Post returned an invalid envelope');
  if (payload.status === 429) throw new RateLimitedError(PROVIDER);
  if (isViettelCaptchaError(payload) || payload.status === 401 || payload.status === 403) throw new ChallengeError(PROVIDER, 'Viettel Post refused verification');
  if (payload.error || payload.status !== 200) throw new IndeterminateError(PROVIDER, 'Viettel Post could not answer the tracking request');
  if (!Array.isArray(payload.data) || payload.data.length > 10) throw new SchemaError(PROVIDER, 'Viettel Post returned an invalid shipment list');
  if (!payload.data.length) throw new NotFoundError(PROVIDER);
  if (payload.data.length !== 1 || !isRecord(payload.data[0])) throw new SchemaError(PROVIDER, 'Viettel Post returned several shipments');
  const shipment = payload.data[0];
  if (typeof shipment.MA_KIEN !== 'string' || shipment.MA_KIEN.trim().toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'Viettel Post answered for another waybill');
  if (typeof shipment.GHI_CHU !== 'string' || !shipment.GHI_CHU.trim()) throw new SchemaError(PROVIDER, 'Viettel Post returned no shipment wording');
  const wording = clean(shipment.GHI_CHU);
  const stage = viettelPostStage(wording);
  const code = cleanScalar(shipment.MA_TRANGTHAI, 16);
  if (!/^\d{1,4}$/.test(code)) throw new SchemaError(PROVIDER, 'Viettel Post returned an invalid status code');
  const clock = shipment.TIME_TRANGTHAI;
  if (typeof clock !== 'string' || !/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/.test(clock)) throw new SchemaError(PROVIDER, 'Viettel Post returned no status clock');
  const date = DateTime.fromFormat(clock, 'dd/MM/yyyy HH:mm', { zone: 'UTC' });
  if (!date.isValid || date.toFormat('dd/MM/yyyy HH:mm') !== clock) throw new SchemaError(PROVIDER, 'Viettel Post returned an invalid status clock');
  const local = date.toFormat("yyyy-MM-dd'T'HH:mm:ss");
  const service = typeof shipment.DICH_VU === 'string' ? clean(shipment.DICH_VU, 80) : '';
  return { status: stage ? languageStageStatus(stage.stage) : 'unknown',
    ...(stage ? { current_stage: stage.stage, current_stage_source: stage.source } : {}), provider_code: code,
    last_status_text: wording, last_update: null, last_update_local: local, expected_delivery: null,
    ...(service ? { service_name: service } : {}), summary_only: true,
    events: [{ local_time: local, description: wording, provider_code: code, ...(stage ? { stage: stage.stage, stage_source: stage.source } : {}) }] };
}
