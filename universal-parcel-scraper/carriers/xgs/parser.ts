import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { isRecord } from '../../core/types.js';
import { xgsMappedStage } from './status.js';

export const PROVIDER = 'XGS';
export const CARRIER = 'xgs';
// One probill's reply is under a kilobyte.
export const XGS_MAX_BYTES = 128 * 1024;

// A probill: seven or eight digits.
const NUMBER = /^\d{7,8}$/;
// "20220819": a day.
const DAY = /^(\d{4})(\d{2})(\d{2})$/;
// "93000" or "170100": a wall clock to the second, its leading zero dropped.
const CLOCK = /^\d{5,6}$/;
// Firewall and bot-check pages that could stand in for the API's JSON.
const BLOCK = /<title>\s*(?:Just a moment|Attention Required|Access Denied)|_cf_chl_opt|cf-turnstile|challenge-platform|captcha/i;
// The API's answer when it holds none of the numbers asked.
const UNKNOWN = 'Track(s) not found with provided id(s)';

/** A probill number for XGS's tracker: seven or eight digits. */
export function normalizeXgsNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'XGS probill numbers have seven or eight digits');
  return number;
}

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

/** A day the reply gives, or none when it gives none. */
function dayOf(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const parts = DAY.exec(raw);
  const day = parts ? calendarDay(Number(parts[1]), Number(parts[2]), Number(parts[3])) : null;
  if (!day) throw new SchemaError(PROVIDER, 'XGS returned an invalid day');
  return day;
}

/** A day with its wall clock when the reply gives one; the reply names no zone. */
function wallClock(day: unknown, clock: unknown): string | null {
  const date = dayOf(day);
  const raw = typeof clock === 'number' ? String(clock) : text(clock);
  if (!date || !raw) return date;
  const padded = raw.padStart(6, '0');
  const [hour, minute, second] = [padded.slice(0, 2), padded.slice(2, 4), padded.slice(4, 6)];
  if (!CLOCK.test(raw) || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) {
    throw new SchemaError(PROVIDER, 'XGS returned an invalid time');
  }
  return `${date}T${hour}:${minute}:${second}`;
}

/**
 * The tracking API's reply for one probill: the probill's status, as a code
 * and in words, the bill day, the arrival at the destination hub, the
 * delivery's day and time with its signatory, the day XGS plans to deliver,
 * the hubs, the towns, the consignee's ZIP code, the pieces and the weight.
 * The entry must be the probill asked. The reply has no history: the newest
 * of the delivery, the hub arrival and the bill day dates the status. The
 * signatory, the ZIP code, the towns and the payor are not read.
 */
export function parseXgs(payload: unknown, raw: string): CarrierResult {
  const number = normalizeXgsNumber(raw);
  if (!isRecord(payload) || payload.data === undefined) throw new SchemaError(PROVIDER, 'XGS returned an unexpected reply');
  const entries = (Array.isArray(payload.data) ? payload.data : [payload.data]).filter(isRecord);
  const entry = entries.find((item) => text(item.PROBILL) === number);
  if (!entry) throw new IndeterminateError(PROVIDER, 'XGS answered for another shipment');
  const code = text(entry.STATUS);
  if (!code || code.length > 80) throw new SchemaError(PROVIDER, 'XGS returned a shipment without its status');
  const wording = text(entry.humanReadableStatus) || code;
  const stage = xgsMappedStage(code);
  const delivered = wallClock(entry.PODDATE, entry.PODTIME);
  const arrived = wallClock(entry.SERVICECENTER_ARRIVAL_DATE, entry.SERVICECENTER_ARRIVAL_TIME);
  const billed = dayOf(entry.BILLDATE);
  // The newest dated milestone; a clock to the second sorts after its own day.
  const newest = [delivered, arrived, billed].filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
  const planned = stage === 'delivered' ? null : dayOf(entry.DELIVERBYDATE);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: wording,
    provider_code: code,
    last_update: null,
    last_update_local: newest,
    expected_delivery: planned,
    summary_only: true,
    events: [],
  };
}

/** The API's answer to a probill it does not hold: HTTP 404 with its "not found" error. */
export function isUnknownShipment(body: string): boolean {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return false;
  }
  return isRecord(payload) && payload.code === 404 && payload.error === UNKNOWN;
}

/** The API's reply as JSON, or the reason it is not one. */
export function xgsJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (BLOCK.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'XGS answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'XGS returned a reply that is not JSON', { cause });
  }
}
