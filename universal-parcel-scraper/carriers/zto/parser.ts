import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { isZtoTrackingNumber } from '../../core/detection/zto.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { ztoEnglish, ztoStage } from './status.js';

export const API = 'https://hdgateway.zto.com/batchGetTrace';
export const PAGE = 'https://www.zto.com/check/detail';
export const PROVIDER = 'ZTO';
export const MAX_BYTES = 1_000_000;

export function normalizeZtoNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!isZtoTrackingNumber(number)) throw new InvalidInputError(PROVIDER, 'ZTO requires a domestic waybill');
  return number;
}

function text(value: unknown, max: number): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' || value.length > max) throw new SchemaError(PROVIDER);
  return clean(value, max);
}

export function parseZto(payload: unknown, raw: string): CarrierResult {
  const number = normalizeZtoNumber(raw);
  if (!isRecord(payload) || typeof payload.status !== 'boolean') throw new SchemaError(PROVIDER);
  const code = text(payload.statusCode, 64);
  if (!payload.status) {
    const message = text(payload.message, 1000);
    if (/频繁|限流|too many|rate limit/i.test(message)) throw new RateLimitedError(PROVIDER);
    if (['10201', '10202'].includes(code) || /验证码|验证|登录|captcha|verification/i.test(message)) throw new ChallengeError(PROVIDER);
    throw new IndeterminateError(PROVIDER);
  }
  if (code !== 'E0000' || !isRecord(payload.result) || !Array.isArray(payload.result.items)
    || payload.result.items.length !== 1) throw new SchemaError(PROVIDER);
  const item: unknown = payload.result.items[0];
  if (!isRecord(item) || item.billCode !== number || !Array.isArray(item.traces) || item.traces.length > 500) throw new SchemaError(PROVIDER);
  if (!item.traces.length) throw new NoHistoryError(PROVIDER);
  const events: CarrierEvent[] = item.traces.map((row: unknown) => {
    if (!isRecord(row) || typeof row.traceTime !== 'number' || !Number.isSafeInteger(row.traceTime)
      || row.traceTime < Date.UTC(1990, 0, 1) || row.traceTime > Date.UTC(2100, 0, 1)) throw new SchemaError(PROVIDER);
    const code = text(row.traceTypeCode, 64);
    if (!/^[A-Z][A-Z_]{0,63}$/.test(code)) throw new SchemaError(PROVIDER);
    // The generic milestone and facility omit courier contacts and recipient wording.
    const description = text(row.traceTypeDesc, 200);
    if (!description) throw new SchemaError(PROVIDER);
    const location = text(row.traceSiteName, 200);
    const classified = ztoStage(code, description);
    return { time: new Date(row.traceTime).toISOString().replace('.000Z', 'Z'), description: ztoEnglish(code, description) ?? description,
      provider_code: code, ...(location ? { location } : {}),
      ...(classified ? { stage: classified.stage, stage_source: classified.source } : {}) };
  });
  events.sort((a, b) => b.time!.localeCompare(a.time!));
  const newest = events[0]!;
  const current = ztoStage(newest.provider_code!, newest.description!);
  return { status: current ? languageStageStatus(current.stage) : 'unknown',
    ...(current ? { current_stage: current.stage, current_stage_source: current.source } : {}),
    last_status_text: newest.description!, last_update: newest.time!, expected_delivery: null,
    // The public PC client suppresses earlier order traces even after verification.
    events: events.slice(0, 100), history_truncated: true };
}
