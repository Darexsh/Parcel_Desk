import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { chunghwaPostStage } from './status.js';

export const PROVIDER = 'Chunghwa Post';
const TAIWAN = 'Asia/Taipei';
export const isSupportedChunghwaPostNumber = (number: string): boolean => /^(?:[CELR][A-Z]\d{9}[A-Z]{2}|(?:F[TZ]|UH)\d{9}TW)$/.test(number);
export function normalizeChunghwaPostNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!isSupportedChunghwaPostNumber(number)) {
    throw new InvalidInputError(PROVIDER, 'Chunghwa Post requires an international postal S10 number');
  }
  return number;
}

export function isChunghwaCaptchaFailure(payload: unknown): boolean {
  return Array.isArray(payload) && payload.some(row => isRecord(row) && isRecord(row.body) && row.body.cptCheck === false);
}

function text(row: Record<string, unknown>, key: string, max = 200): string {
  if (row[key] == null) return '';
  if (typeof row[key] !== 'string' || row[key].length > max) throw new SchemaError(PROVIDER, 'Chunghwa Post returned an invalid scan field');
  return clean(row[key], max);
}
function clock(value: unknown): string {
  if (typeof value === 'string' && /^\d{14}$/.test(value)) {
    const parsed = DateTime.fromFormat(value, 'yyyyMMddHHmmss', { zone: 'UTC' });
    if (parsed.isValid && parsed.toFormat('yyyyMMddHHmmss') === value) return parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss");
  }
  throw new SchemaError(PROVIDER, 'Chunghwa Post returned an invalid scan clock');
}

/**
 * Whether Chunghwa Post's own branch made the scan. The official client reads a
 * branch code of digits or a `TW` office of exchange as one of its own
 * branches, and links another post's site for a scan made abroad.
 */
function ownBranch(row: Record<string, unknown>): boolean {
  const branch = typeof row.BRHNO === 'string' ? row.BRHNO.trim().slice(0, 6) : '';
  const abroad = row.POST_URL != null && (typeof row.POST_URL !== 'string' || row.POST_URL.trim() !== '');
  return /^(?:\d{6}|TW[A-Z]{4})$/.test(branch) && !abroad;
}

/** A wall clock of Chunghwa Post's own branch: Taiwan keeps one zone, without daylight saving. */
function taiwanInstant(wall: string): string | undefined {
  const placed = firstOccurrence(DateTime.fromISO(wall, { zone: TAIWAN }));
  return placed.isValid ? placed.toUTC().toISO({ suppressMilliseconds: true }) ?? undefined : undefined;
}

export function parseChunghwaPost(payload: unknown, raw: string): CarrierResult {
  const number = normalizeChunghwaPostNumber(raw);
  if (!Array.isArray(payload) || !payload.length || payload.length > 4) throw new SchemaError(PROVIDER, 'Chunghwa Post returned an invalid envelope');
  if (isChunghwaCaptchaFailure(payload)) throw new ChallengeError(PROVIDER, 'Chunghwa Post rejected the text verification');
  const screens: Record<string, unknown>[] = [];
  for (const row of payload) {
    if (!isRecord(row) || !isRecord(row.header) || !isRecord(row.body)) throw new SchemaError(PROVIDER, 'Chunghwa Post returned an invalid message');
    if (row.header.OutputType === 'Message') {
      const message = text(row.body, 'msgData', 1000);
      const parts = message.split('|');
      if (parts[0]?.trim().toUpperCase() === number && parts[2] === 'Z993'
        && /資料不存在|Tracking is not available for this item/i.test(parts.slice(3).join('|'))) throw new NotFoundError(PROVIDER);
      if (/頻繁|too many|rate limit/i.test(message)) throw new RateLimitedError(PROVIDER);
      if (/驗證碼|captcha|session/i.test(message)) throw new ChallengeError(PROVIDER, 'Chunghwa Post refused verification');
      throw new IndeterminateError(PROVIDER, 'Chunghwa Post could not answer this lookup');
    }
    if (row.header.OutputType === 'Screen') screens.push(row.body);
  }
  if (screens.length !== 1) throw new SchemaError(PROVIDER, 'Chunghwa Post returned no unique tracking result');
  const body = screens[0]!;
  if (body.cptCheck !== true) throw new SchemaError(PROVIDER, 'Chunghwa Post did not confirm verification');
  if (body.incorrectList != null && !Array.isArray(body.incorrectList)) throw new SchemaError(PROVIDER, 'Chunghwa Post returned an invalid validation result');
  if (Array.isArray(body.incorrectList) && body.incorrectList.length) throw new IndeterminateError(PROVIDER, 'Chunghwa Post cannot query this postal reference');
  const host = body.host_rs;
  if (!isRecord(host) || host.Status !== 'S' || typeof host.MAILNO !== 'string' || host.MAILNO.trim().toUpperCase() !== number) {
    throw new IndeterminateError(PROVIDER, 'Chunghwa Post did not return the requested item');
  }
  if (!Array.isArray(host.ITEM) || host.ITEM.length > 500) throw new SchemaError(PROVIDER, 'Chunghwa Post returned an invalid history');
  if (!host.ITEM.length) throw new NoHistoryError(PROVIDER);
  const events: CarrierEvent[] = host.ITEM.map((row: unknown) => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Chunghwa Post returned an invalid scan');
    const description = text(row, 'STATUS');
    const code = text(row, 'EVCODE', 8);
    if (!description || !/^[A-Z0-9]{1,8}$/.test(code)) throw new SchemaError(PROVIDER, 'Chunghwa Post returned an invalid scan status');
    const classified = chunghwaPostStage(description);
    const location = text(row, 'BRHNAT', 100);
    const localTime = clock(row.DATIME);
    // A scan abroad is on that country's local clock, as the tracker's notes say, so it keeps its wall clock.
    const time = ownBranch(row) ? taiwanInstant(localTime) : undefined;
    return { ...(time ? { time } : {}), local_time: localTime, description, provider_code: code, ...(location ? { location } : {}),
      ...(classified ? { stage: classified.stage, stage_source: classified.source } : {}) };
  });
  const newest = events[0]!;
  const classified = chunghwaPostStage(newest.description!);
  return { status: classified ? languageStageStatus(classified.stage) : 'unknown',
    ...(classified ? { current_stage: classified.stage, current_stage_source: classified.source } : {}),
    provider_code: newest.provider_code!, last_status_text: newest.description!, last_update: newest.time ?? null,
    last_update_local: newest.local_time!, expected_delivery: null, events: events.slice(0, 100),
    ...(events.length > 100 ? { history_truncated: true } : {}) };
}
