import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { depponStage } from './status.js';

export const PROVIDER = 'Deppon';
export const DEPPON_MAX_BYTES = 1_000_000;

/** The whole identifier the official request builder accepts, without claiming carrier ownership. */
export function normalizeDepponNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^[A-Z0-9]{8,20}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Deppon requires an eight- to twenty-character waybill');
  return number;
}

function text(row: Record<string, unknown>, key: string, max = 500): string {
  if (row[key] === undefined || row[key] === null) return '';
  if (typeof row[key] !== 'string') throw new SchemaError(PROVIDER, `Deppon returned an invalid ${key}`);
  return clean(row[key], max);
}

/** Failure envelopes also carry HTTP 200. Only the tracker's explicit absence is not found. */
export function depponFailure(payload: Record<string, unknown>): never {
  const message = text(payload, 'message');
  if (/频繁|限流|too many|rate limit/i.test(message)) throw new RateLimitedError(PROVIDER);
  if (/验证码|校验|验证|登录|captcha|verify|verification|login/i.test(message)) throw new ChallengeError(PROVIDER, 'Deppon refused verification');
  if (['fail', 'FAIL'].includes(String(payload.status)) && payload.result === null
    && message === '运单轨迹不存在，请检查运单号是否正确') throw new NotFoundError(PROVIDER);
  throw new IndeterminateError(PROVIDER, 'Deppon could not answer the tracking request');
}

function clock(value: unknown): { time: string } | { local_time: string } {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= Date.UTC(1990, 0, 1) && value <= Date.UTC(2100, 0, 1)) {
    return { time: new Date(value).toISOString().replace('.000Z', 'Z') };
  }
  if (typeof value === 'string') {
    const instant = explicitOffsetTime(value);
    if (instant) return { time: instant.iso };
    const local = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(value) ? value.replace(' ', 'T') : '';
    const parsed = DateTime.fromISO(local, { zone: 'UTC' });
    if (local && parsed.isValid && parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") === local) return { local_time: local };
  }
  throw new SchemaError(PROVIDER, 'Deppon returned an invalid scan clock');
}

/** A queryNewTrack reply after accepted verification, for exactly the requested waybill. */
export function parseDeppon(payload: unknown, raw: string): CarrierResult {
  const number = normalizeDepponNumber(raw);
  if (!isRecord(payload) || !['success', 'SUCCESS', 'fail', 'FAIL', 0].includes(payload.status as string | number)) {
    throw new SchemaError(PROVIDER, 'Deppon returned an invalid tracking envelope');
  }
  if (!['success', 'SUCCESS', 0].includes(payload.status as string | number)) depponFailure(payload);
  const shipment = payload.result;
  if (!isRecord(shipment)) throw new SchemaError(PROVIDER, 'Deppon returned no shipment');
  if (text(shipment, 'billNo', 64).toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'Deppon answered for another waybill');
  if (!Array.isArray(shipment.tracks) || shipment.tracks.length > 500) throw new SchemaError(PROVIDER, 'Deppon returned an invalid history');
  if (!shipment.tracks.length) throw new NoHistoryError(PROVIDER);
  const events: CarrierEvent[] = shipment.tracks.map((row: unknown) => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Deppon returned an invalid scan');
    const code = text(row, 'opreateType', 64);
    if (code && !/^[A-Z][A-Z_]{0,63}$/.test(code)) throw new SchemaError(PROVIDER, 'Deppon returned an invalid operation type');
    const description = text(row, 'contentNoLinkLabel').split(/签收人[：:]|收件人[：:]|联系电话[：:]/)[0]!
      .replace(/1[3-9]\d{9}/g, '').trim();
    if (!description) throw new SchemaError(PROVIDER, 'Deppon returned a scan without wording');
    const classified = depponStage(code, description);
    return { ...clock(row.operateTime), description, ...(code ? { provider_code: code } : {}),
      ...(classified ? { stage: classified.stage, stage_source: classified.source } : {}) };
  });
  // queryNewTrack lists newest first. Its equal clocks retain the server's order.
  const newest = events[0]!;
  const current = depponStage(String(newest.provider_code ?? ''), newest.description!);
  return { status: current ? languageStageStatus(current.stage) : 'unknown',
    ...(current ? { current_stage: current.stage, current_stage_source: current.source } : {}),
    last_status_text: newest.description!, last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}), expected_delivery: null,
    events: events.slice(0, 100), ...(events.length > 100 ? { history_truncated: true } : {}) };
}
