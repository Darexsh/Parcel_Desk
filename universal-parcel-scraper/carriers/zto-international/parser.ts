import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { ztoInternationalStage } from './status.js';

export const PROVIDER = 'ZTO International';
// A long history is a few kilobytes.
export const ZTO_INTERNATIONAL_MAX_BYTES = 512 * 1024;
// 771 and eleven digits: ZTO's own pattern for its international waybills.
const NUMBER = /^771\d{11}$/;
const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
// ZTO dates every scan on Shanghai's clock, abroad too.
const HOME_ZONE = 'Asia/Shanghai';
// The image code the page asks for when the tracker refuses a lookup.
const CHALLENGE_CODES = new Set(['19001', '19002', '50003', '60005']);
// The English line of a parcel taken in for the recipient says "Delivered".
const WORDING = new Map([['16', 'Received on the recipient\'s behalf']]);
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

const BRACKET = /[[【]([^\]】]*)[\]】]/g;
// A clause naming who scanned, picked up, delivered or signed for the parcel,
// a phone number or a bag, and everything after it.
const PERSONAL_EN = /[\s,，;；]*(?:and\s+)?the\s+(?:(?:scanner|dispatcher|picker|courier|operator|signer|recipient|receiver|sign for the outlet|package number)\s+is\b|(?:dispatch\s+)?phone number\b)[\s\S]*$|[\s,，]*Bulk packaging bag No\.[\s\S]*$/i;
// The same people and contacts in a Chinese line, with the brackets naming them.
const PERSONAL_ZH = /(?:业务员|快递员|派件员|扫描员|取件员|签收人|操作员|(?:派件|联系)?电话|包袋号)(?:是)?[:：]?(?:\s*[[【][^\]】]*[\]】])*|(?:如有(?:疑问|问题)请电联|请保持电话畅通)[^。！!]*[。！!]?/g;
const CONTACT = /@[\w.]+|\+?\d[\d\s-]{5,}\d/g;
// Bracketed words that are not a place.
const NOT_PLACE = /已签收|已揽件|已揽收|操作员|海外|\d{4}|@/;

/** A ZTO International waybill number; anything else is a number its tracker is not asked for. */
export function normalizeZtoInternationalNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'ZTO International waybill numbers are 771 and eleven digits');
  return number;
}

/** An optional text field; an object or array is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 500): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' && typeof value !== 'number') throw new SchemaError(PROVIDER, `ZTO International returned an invalid ${key}`);
  return cleanScalar(value, maxLength);
}

/** Bracketed words as plain words, and no space before punctuation. */
function unwrap(value: string): string {
  return clean(value.replace(BRACKET, ' $1 ').replace(CONTACT, ' ')).replace(/\s+([,.，。:：])/g, '$1').replace(/[\s,，;；:：]+$/, '');
}

/**
 * The scan's own sentence without the people in it. The English line is
 * read first; a line that opens with its place in brackets loses it, since
 * the place is kept apart.
 */
function descriptionOf(code: string, english: string, chinese: string): string {
  const own = WORDING.get(code);
  if (own) return own;
  const fromEnglish = unwrap(english.replace(PERSONAL_EN, '').replace(/^\s*[[【][^\]】]*[\]】]\s*/, ''));
  if (fromEnglish) return fromEnglish;
  // Every bracket goes: those no role word introduces still name collection points and operators.
  return unwrap(chinese.replace(PERSONAL_ZH, '').replace(BRACKET, ''));
}

/**
 * The place a Chinese line names: the station a delivery was signed at, else
 * its first bracket, which is the station, warehouse, city or country of the
 * scan. Later brackets name couriers, operators and collection points.
 */
function placeOf(chinese: string): string {
  const signed = /(?:快件已在|签收网点是)[[【]([^\]】]{1,60})[\]】]/.exec(chinese)?.[1];
  const place = clean(signed ?? /[[【]([^\]】]{1,60})[\]】]/.exec(chinese)?.[1], 60);
  return place && !NOT_PLACE.test(place) ? place : '';
}

const homeClock = (local: string) => firstOccurrence(DateTime.fromISO(local, { zone: HOME_ZONE }));

/** A scan's wall clock, checked by reading it back. */
function localTimeOf(row: Record<string, unknown>): string {
  const wall = WALL_CLOCK.exec(text(row, 'time', 64));
  const local = wall ? `${wall[1]}T${wall[2]}` : '';
  const home = local ? homeClock(local) : null;
  // Luxon rolls 24:00:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!home?.isValid || home.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) throw new SchemaError(PROVIDER, 'ZTO International returned an invalid scan time');
  return local;
}

function projectRow(row: unknown, number: string): CarrierEvent | null {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'ZTO International returned an invalid scan');
  const own = text(row, 'mailNo', 64);
  if (own && normalizeTrackingNumber(own) !== number) throw new IndeterminateError(PROVIDER, 'ZTO International returned a scan of another waybill');
  const chinese = text(row, 'message', 1000);
  const code = text(row, 'status', 16);
  const description = descriptionOf(code, text(row, 'messageEng', 1000), chinese).slice(0, 300);
  if (!description) return null;
  const local_time = localTimeOf(row);
  const location = placeOf(chinese);
  const staged = ztoInternationalStage(code, description);
  return {
    time: homeClock(local_time).toISO({ suppressMilliseconds: true })!,
    local_time,
    time_zone: HOME_ZONE,
    time_zone_basis: 'carrier',
    description,
    ...(location ? { location } : {}),
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/** The tracker's refusal: an image code is a challenge, anything else is inconclusive. */
function failure(error: unknown): never {
  const code = isRecord(error) ? cleanScalar(error.code, 32) : '';
  const message = isRecord(error) ? clean(error.message, 200) : '';
  if (CHALLENGE_CODES.has(code) || /verification code|验证码/i.test(message)) {
    throw new ChallengeError(PROVIDER, 'ZTO International asks for an image code before the lookup');
  }
  throw new IndeterminateError(PROVIDER, 'ZTO International did not complete the lookup');
}

/**
 * The reply of `POST /applet/track/queryFromMainSite`, the lookup the tracking
 * page on m.ztoglobal.com makes: one entry per waybill found, with its number
 * and its scans, newest first. Each scan has a wall clock, a code, a Chinese
 * line and its English version. A waybill the tracker does not know, and a
 * request it could not read, both get `{"success":true}` alone.
 */
export function parseZtoInternational(payload: unknown, raw: string): CarrierResult {
  const number = normalizeZtoInternationalNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'ZTO International returned an invalid envelope');
  if (payload.success === false) failure(payload.error);
  if (payload.success !== true) throw new SchemaError(PROVIDER, 'ZTO International returned an invalid envelope');
  const data = payload.data ?? [];
  if (!Array.isArray(data) || !data.every(isRecord)) throw new SchemaError(PROVIDER, 'ZTO International returned invalid waybills');
  if (!data.length) {
    throw new IndeterminateError(PROVIDER, 'ZTO International has nothing under the number', { reason: 'portal_not_found' });
  }
  const matching = data.filter((entry) => isRecord(entry.mail) && normalizeTrackingNumber(text(entry.mail, 'mailNo', 64)) === number);
  if (matching.length !== 1) throw new IndeterminateError(PROVIDER, 'ZTO International answered for another waybill');
  const rows = matching[0]!.tracks ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'ZTO International returned an invalid history');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'ZTO International returned an oversized history');

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    const event = projectRow(row, number);
    const key = event && JSON.stringify([event.local_time, event.provider_code, event.description, event.location]);
    if (!event || seen.has(key!)) continue;
    seen.add(key!);
    events.push(event);
  }
  if (!events.length) throw new NoHistoryError(PROVIDER, 'ZTO International has no scans for the waybill yet');

  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    last_update_local: newest.local_time!,
    expected_delivery: null,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
