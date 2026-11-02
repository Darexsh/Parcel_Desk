import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryTimeZone, isoTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { countryZones } from '../../places/zones.js';
import { imileStage } from './status.js';
import { imileDisplayWording } from './wording.js';

export const PROVIDER = 'iMile';
// A long history is a few kilobytes.
export const IMILE_MAX_BYTES = 512 * 1024;
// Letters and digits with at least one digit: iMile's own thirteen digits and the partners' references its tracker also answers.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,40}$/;
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const CODE = /^\d{1,6}$/;
// How a service words a refusal to answer more requests.
const THROTTLED = /too many|too frequent|frequently|rate limit|请求(?:过于)?频繁|访问(?:过于)?频繁/i;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/**
 * iMile's country codes, from its own country list: mostly ISO's three
 * letters, but `KSA`, `UAE`, `RSA` and `BIH` (Bahrain) are its own. The page
 * also names `USA`.
 */
const COUNTRIES: Readonly<Record<string, string>> = {
  AUS: 'AU', AUT: 'AT', BIH: 'BH', BRA: 'BR', CHN: 'CN', COL: 'CO', DOM: 'DO', SLV: 'SV', DEU: 'DE', GTM: 'GT',
  HND: 'HN', HUN: 'HU', ITA: 'IT', KWT: 'KW', LBN: 'LB', MEX: 'MX', NZL: 'NZ', MKD: 'MK', OMN: 'OM', PER: 'PE',
  POL: 'PL', QAT: 'QA', KSA: 'SA', SRB: 'RS', SVK: 'SK', RSA: 'ZA', ESP: 'ES', TUR: 'TR', UAE: 'AE', GBR: 'GB', USA: 'US',
};

// New Zealand's other zone is the Chatham Islands': its delivery stations keep Auckland's clock.
const MAINLAND_ZONES: Readonly<Record<string, string>> = { NZ: 'Pacific/Auckland' };

/**
 * The zone of the recipient country's clock, where iMile delivers on one. iMile
 * names a country, never a state or province, so Peru's code is Peru's.
 */
function countryClock(country: string): string | null {
  const zones = countryZones(country);
  return countryTimeZone(country) ?? (zones.length === 1 ? zones[0]! : MAINLAND_ZONES[country] ?? null);
}

/** A number for iMile's tracker, in upper case; anything else is not one it answers. */
export function normalizeImileNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'iMile numbers are letters and digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 500): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `iMile returned an invalid ${key}`);
  return clean(value, maxLength);
}

// The proof-of-delivery link some countries' delivery scans carry, the only markup the page
// reads in a wording: it shows the rest as text, angle brackets included.
const PROOF = /<div[^>]*\bviewPic\b[^>]*>[\s\S]*?<\/div>/gi;
// The driver's phone an out-for-delivery scan offers: "You can contact him by clicking +966 …".
const CONTACT = /\s*You can contact\b[\s\S]*$/i;
// iMile's support footer after a Brazilian delivery or a return: "If you have any questions, …".
const SUPPORT = /\s*If you have any questions?\b[\s\S]*$/i;
// Who took the parcel, in 【】: "received by 【Self】", ", Receiver Type:【Self】".
const RECEIVER = /\s*[,，;；]?\s*(?:\bby|\bReceiver Type\s*[:：]?)\s*【[^】]*】/gi;
// A run of nine or more digits, with spaces, brackets, dots or hyphens
// between them, as phone numbers are written; a date stays.
const PHONE = /(?<![A-Z\d])(?!\d{4}-\d{2}-\d{2}(?!\d))\+?\d(?:[\s().\-/]{0,2}\d){8,}(?![A-Z\d])/gi;

/**
 * A scan's wording without the people it names: the driver's phone, who
 * took the parcel, the proof-of-delivery link and the support footer go.
 * The centre names in 【】 stay for the stage rules to read past.
 */
export function imileWording(raw: string): string {
  return clean(raw
    .replace(PROOF, ' ')
    .replace(SUPPORT, '')
    .replace(CONTACT, '')
    .replace(RECEIVER, '')
    .replace(PHONE, '')
    .replace(/\s+([,，;；.。])/g, '$1'))
    .replace(/^[\s,，;；]+|[\s,，;；]+$/g, '');
}

/**
 * A scan's clock: a wall clock to the second with no zone. The page says it
 * is the recipient country's time, which places it once that country is known.
 */
function scanClock(row: Record<string, unknown>): string {
  const stamp = text(row, 'time', 32);
  const local = stamp.replace(' ', 'T');
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  // Luxon rolls 24:00:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!WALL_CLOCK.test(stamp) || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'iMile returned an invalid scan time');
  }
  return local;
}

/** A scan's `trackStage`, a number or none; anything else is a changed reply. */
function stageCode(row: Record<string, unknown>): string {
  const value = row.trackStage;
  if (value === null || value === undefined) return '';
  const code = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value)
    : typeof value === 'string' && CODE.test(value.trim()) ? value.trim() : null;
  if (code === null) throw new SchemaError(PROVIDER, 'iMile returned an invalid scan stage');
  return code;
}

function projectRow(row: Record<string, unknown>): { key: string; event: CarrierEvent } | null {
  const code = stageCode(row);
  const written = imileWording(text(row, 'content', 2_000)) || text(row, 'trackStageTx', 120);
  if (!written) throw new SchemaError(PROVIDER, 'iMile returned a scan without wording');
  const local = scanClock(row);
  const location = text(row, 'operateStationName', 120);
  const staged = imileStage(code, written);
  const description = imileDisplayWording(written, location);
  // A row that only books a flight is still to come: no scan.
  if (!description) return null;
  const event: CarrierEvent = {
    local_time: local,
    ...(location ? { location } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([local, code, description, location]), event };
}

/**
 * The reply of the tracking page's `/saastms/mobileWeb/track/query` for one
 * number. It answers HTTP 200 with `status` and `resultObject`; the page
 * reports a `success` without a `resultObject` as no data, which is not
 * found. A shipment must name the number asked.
 */
export function parseImile(payload: unknown, raw: string): CarrierResult {
  const number = normalizeImileNumber(raw);
  if (!isRecord(payload) || typeof payload.status !== 'string') throw new SchemaError(PROVIDER, 'iMile returned an invalid envelope');
  if (payload.status !== 'success') {
    if (THROTTLED.test(clean(payload.message, 300))) throw new RateLimitedError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'iMile did not complete the lookup');
  }
  const shipment = payload.resultObject;
  if (shipment === null || shipment === undefined) throw new NotFoundError(PROVIDER);
  if (!isRecord(shipment) || typeof shipment.waybillNo !== 'string') throw new SchemaError(PROVIDER, 'iMile returned a shipment without its number');
  if (clean(shipment.waybillNo, 64).toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'iMile answered for another shipment');
  const rows = shipment.trackInfos ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'iMile returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'iMile returned an oversized history');

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'iMile returned an invalid scan');
    const scan = projectRow(row);
    if (!scan || seen.has(scan.key)) continue;
    seen.add(scan.key);
    events.push(scan.event);
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the page lists them; an oldest-first reply is turned round.
  const newestFirst = (events[0]!.local_time as string) < (events.at(-1)!.local_time as string) ? events.reverse() : events;

  const code = text(shipment, 'country', 8).toUpperCase();
  const country = Object.hasOwn(COUNTRIES, code) ? COUNTRIES[code] : undefined;
  // Every scan shows the recipient country's clock: a country of one zone
  // places them all, and one of several leaves them local.
  const zone = country ? countryClock(country) : null;
  const placed = zone ? newestFirst.map(({ local_time, ...event }): CarrierEvent => {
    const time = isoTime(local_time, zone)?.iso;
    return time ? { time, ...event } : { local_time, ...event };
  }) : newestFirst;
  return {
    ...imileSummary(placed),
    expected_delivery: null,
    ...(country ? { destination_country: country } : {}),
    events: placed.slice(0, MAX_EVENTS),
    ...(newestFirst.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}

/** The status a history newest first gives: its newest staged scan's stage, and its newest scan's wording and clock. */
export function imileSummary(events: readonly CarrierEvent[]): CarrierResult {
  const newest = events[0]!;
  // A pending scan or a notice, which keeps the stage before it as Cainiao's do, moves nothing.
  const current = events.find((event) => event.stage && event.stage !== 'pending' && event.stage_source !== 'none');
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.time ? {} : { last_update_local: newest.local_time }),
  };
}
