import { DateTime, FixedOffsetZone } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean, cleanScalar, textFromHtml } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { jAndTMiddleEastStage } from './status.js';

export const PROVIDER = 'J&T Express Middle East';
// A long history is a few dozen kilobytes.
export const J_AND_T_MIDDLE_EAST_MAX_BYTES = 512 * 1024;
// The waybill the tracking form takes: JTE and twelve digits.
const NUMBER = /^JTE\d{12}$/;
const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
/**
 * The zone the lookup is asked for, as the page names its visitor's: the
 * tracker gives every scan's time in it. Saudi Arabia's UTC+3, which has no
 * daylight saving.
 */
export const J_AND_T_MIDDLE_EAST_REQUEST_ZONE = 'GMT+0300';
const REQUEST_OFFSET = FixedOffsetZone.instance(3 * 60);
// The reply's codes the page reads: an unknown waybill, and a lookup that wants a solved captcha.
const UNKNOWN_WAYBILL = 135020020;
const CAPTCHA_REQUIRED = 1350200260;
// Missing or invalid request parameters: the lookup no longer takes the request as sent.
const REFUSED_REQUEST = new Set([999001010, 999001030]);
const THROTTLED = /too many|too frequent|frequently|rate limit|请求(?:过于)?频繁|访问(?:过于)?频繁/i;
// Fields that could name the waybill a scan belongs to; the answer names it in `keyword`.
const IDENTITY = ['waybillNo', 'billCode', 'keyword'] as const;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A waybill for J&T Express Middle East's tracker, in upper case; anything else is not one it issues. */
export function normalizeJAndTMiddleEastNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'J&T Express Middle East waybills are JTE and twelve digits');
  return number;
}

/** Any waybill a record names must be the one asked; a record naming none is bound by the one-waybill request. */
function checkIdentity(row: Record<string, unknown>, number: string): void {
  for (const key of IDENTITY) {
    const value = row[key];
    if (value === null || value === undefined || value === '') continue;
    if (typeof value !== 'string') throw new SchemaError(PROVIDER, `J&T Express Middle East returned an invalid ${key}`);
    if (normalizeTrackingNumber(value).toUpperCase() !== number) {
      throw new IndeterminateError(PROVIDER, 'J&T Express Middle East answered for another waybill');
    }
  }
}

/**
 * A scan's instant. The tracker turns each `scanTime` into the zone the request
 * names, so it is read at that offset, whichever country scanned the parcel.
 */
function scanInstant(row: Record<string, unknown>): { iso: string; timestamp: number } {
  const match = WALL_CLOCK.exec(typeof row.scanTime === 'string' ? row.scanTime.trim() : '');
  const local = match ? `${match[1]}T${match[2]}` : '';
  const parsed = firstOccurrence(DateTime.fromISO(local, { zone: REQUEST_OFFSET }));
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  const iso = match && parsed.isValid && parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") === local
    ? parsed.toISO({ suppressMilliseconds: true }) : null;
  if (!iso) throw new SchemaError(PROVIDER, 'J&T Express Middle East returned an invalid scan time');
  return { iso, timestamp: parsed.toMillis() };
}

/**
 * One scan: its instant, the label the page heads it with, its status code
 * and the scanning branch's town and province. The sentence under the label
 * (`customerTracking`) and the fields for the courier, the signer, the
 * branch's contact and the pictures are not read.
 */
function projectRow(row: Record<string, unknown>, number: string): { key: string; timestamp: number; event: CarrierEvent } {
  checkIdentity(row, number);
  if (row.status !== null && row.status !== undefined && typeof row.status !== 'string') {
    throw new SchemaError(PROVIDER, 'J&T Express Middle East returned an invalid scan status');
  }
  const description = textFromHtml(row.status, 120);
  if (!description) throw new SchemaError(PROVIDER, 'J&T Express Middle East returned a scan without a status');
  const { iso, timestamp } = scanInstant(row);
  const raw = cleanScalar(row.statusCode, 8);
  const code = /^\d{1,4}$/.test(raw) ? raw : '';
  const location = [clean(row.scanNetworkCity, 100), clean(row.scanNetworkProvince, 100)].filter(Boolean).join(', ');
  const staged = jAndTMiddleEastStage(description);
  const event: CarrierEvent = {
    time: iso,
    description,
    ...(location ? { location } : {}),
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([timestamp, code, description, location]), timestamp, event };
}

/** The refusal or failure a reply that is not a success stands for. */
function failure(payload: Record<string, unknown>): Error {
  const code = payload.code;
  const message = clean(payload.msg, 200);
  if (code === UNKNOWN_WAYBILL) return new NotFoundError(PROVIDER);
  if (code === CAPTCHA_REQUIRED) return new ChallengeError(PROVIDER, 'J&T Express Middle East asked for a captcha before the lookup');
  if (THROTTLED.test(message)) return new RateLimitedError(PROVIDER, undefined, 'J&T Express Middle East refused more lookups for now');
  if (typeof code === 'number' && REFUSED_REQUEST.has(code)) {
    return new SchemaError(PROVIDER, 'J&T Express Middle East refused the lookup’s parameters');
  }
  return new IndeterminateError(PROVIDER, 'J&T Express Middle East did not complete the lookup');
}

/**
 * The reply of `getDetailByWaybillNo` for one waybill: `succ` with one answer
 * in `data`, which names the waybill in `keyword` and lists its scans in
 * `details`, newest first. An unknown waybill is code 135020020, which the
 * page reports as not found.
 */
export function parseJAndTMiddleEast(payload: unknown, raw: string): CarrierResult {
  const number = normalizeJAndTMiddleEastNumber(raw);
  if (!isRecord(payload) || typeof payload.succ !== 'boolean') throw new SchemaError(PROVIDER, 'J&T Express Middle East returned an invalid envelope');
  if (!payload.succ) throw failure(payload);
  const answers = payload.data;
  if (!Array.isArray(answers) || answers.length !== 1 || !isRecord(answers[0])) {
    throw new SchemaError(PROVIDER, 'J&T Express Middle East returned no single answer for the waybill');
  }
  const answer = answers[0];
  if (typeof answer.keyword !== 'string' || !answer.keyword) throw new SchemaError(PROVIDER, 'J&T Express Middle East did not name the waybill it answered for');
  checkIdentity(answer, number);
  const rows = answer.details ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'J&T Express Middle East returned invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'J&T Express Middle East returned an oversized history');

  const seen = new Set<string>();
  const scans: { timestamp: number; index: number; event: CarrierEvent }[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'J&T Express Middle East returned an invalid scan');
    const scan = projectRow(row, number);
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    scans.push({ timestamp: scan.timestamp, index: scans.length, event: scan.event });
  }
  // The page tells a waybill without scans that it cannot track it.
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the page lists them; scans at one instant keep the reply's order.
  const newestFirst = scans.sort((a, b) => b.timestamp - a.timestamp || a.index - b.index).map(({ event }) => event);

  const newest = newestFirst[0]!;
  const staged = newestFirst.find((event) => event.stage);
  const stage = staged?.stage as Stage | undefined;
  const delivered = stage === 'delivered' ? staged!.time as string : null;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time,
    expected_delivery: null,
    ...(delivered ? { delivered_at: delivered } : {}),
    events: newestFirst.slice(0, MAX_EVENTS),
    ...(newestFirst.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
