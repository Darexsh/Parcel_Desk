import { DateTime } from 'luxon';
import { CARRIER_DEFINITIONS } from '../../core/catalog/definitions.js';
import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { USPS_ROUTING_BARCODE, uspsPackageIdentifier } from '../../core/detection/usps.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { canadaProvinceTimeZone, countryCode, isoTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { jsExpressChinaClock } from './clock.js';
import { jsExpressEnglish, jsExpressStage } from './status.js';

export const PROVIDER = 'JS Express';
// A reply is a few kilobytes; five hundred rows stay under 256 kB.
export const JS_EXPRESS_MAX_BYTES = 256 * 1024;

// JSE, two letters, ten digits and YQ.
const NUMBER = /^JSE[A-Z]{2}\d{10}YQ$/;
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
// The lookup's answer for a number it does not know.
const NOT_FOUND = '未获取到任何数据';
// The answer the lookup prints, before its own, to a request that does not come from the tracking page.
const REFUSED = '非法请求';
const REFUSAL = /^\s*\{\s*"code"\s*:\s*1\s*,\s*"message"\s*:\s*"非法请求"\s*\}(?=\s*\{)/;
// The image captcha the Chinese page's lookup asks for, should this one ask it too.
const CAPTCHA = /验证码/;
// A firewall or bot check's page, which can come back with HTTP 200.
const BLOCKED = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access denied)|g-recaptcha|geetest/i;
// A run of nine or more digits, with the separators phone numbers are written with; a date stays.
const PHONE = /(?<![A-Z\d])(?!\d{4}-\d{2}-\d{2}(?!\d))\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
// The label a phone number followed, left at the end without it: "，当地电话：" (local phone), or "Local phone number:/".
const PHONE_LABEL = /[\s,，;；]*(?:(?:当地|联系)?电话|(?:local\s+)?(?:tel(?:ephone)?|phone(?:\s+number)?))\s*[:：]\s*\/?\s*$/i;
// Who took a delivered parcel, as a courier's delivery line can name them.
const RECEIVER = /\s*[,;:.\-–]?\s*\b(?:(?:signed|received|collected|accepted)(?:\s+for)?\s+by|signed|signatory|signature)\b.*$/i;
// The place a destination courier's wording ends with, as "Delivered (Sample Town, ON)".
const PLACE = /\s*\(([^()]{1,120})\)$/;
// Straightship, the Canadian courier, names itself in its station rows and its delivery attempts.
const STRAIGHTSHIP = /straightship/i;
// Straightship's record of the parcel's data, its first row on its own page, in the same words and without a place.
const STRAIGHTSHIP_RECORD = /^package information is created in the system$/i;
// A town and the code of its province or state, as a courier's wording ends with them.
const PROVINCE = /,\s*([A-Z]{2})$/;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A JS Express waybill number; anything else is not one it issues. */
export function normalizeJsExpressNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'JS Express waybills are JSE, two letters, ten digits and YQ');
  return number;
}

/**
 * A row's wording and place. The place is the page's 【…】 label, which a
 * destination courier's wording repeats with its province, "(Sample Town,
 * ON)": the wording then loses it and the place takes it. A label without a
 * letter, such as "1", names no place. A delivery loses a clause naming who
 * took it, and every row loses phone numbers and the label left before them.
 */
export function jsExpressScan(status: string, address: string): { description: string; location: string } {
  let description = clean(status, 300);
  let location = clean(address, 120);
  const place = PLACE.exec(description);
  if (place && location && clean(place[1]).toLowerCase().startsWith(location.toLowerCase())) {
    description = description.slice(0, place.index);
    location = clean(place[1], 120);
  }
  if (/^delivered\b/i.test(description)) description = description.replace(RECEIVER, '');
  const site = clean(location.replace(PHONE, ''));
  return { description: clean(description.replace(PHONE, '')).replace(PHONE_LABEL, '').replace(/[\s,，;；:：-]+$/, ''),
    location: /\p{L}/u.test(site) ? site : '' };
}

/** A row's clock: the scanning site's wall clock to the second, with no zone. */
function wallClock(stamp: string): string {
  const match = CLOCK.exec(stamp);
  const local = match ? `${match[1]}T${match[2]}` : '';
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  // Luxon rolls 24:00:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!match || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'JS Express returned an invalid scan time');
  }
  return local;
}

/** Whether the courier's wording gave the row its place, a town and a Canadian province. */
function canadianTown(location: string, label: string): boolean {
  return location.toLowerCase() !== label.toLowerCase() && Boolean(canadaProvinceTimeZone(PROVINCE.exec(location)?.[1]));
}

/**
 * The zone a row's wall clock keeps, where the row settles it. A row at a
 * place in mainland China is on Beijing time, JS Express's and its line's
 * warehouse, sorting and export rows alike; a flight's departure filed there
 * keeps its wall clock. In a history that names Straightship, its rows are on
 * UTC, as its own page writes them: those that name it, those whose wording
 * ended with a town and a Canadian province, and its record of the parcel's
 * data. Null otherwise: airports' codes, other rows without a place and other
 * couriers' rows.
 */
function scanZone(description: string, location: string, label: string, straightship: boolean): string | null {
  if (straightship && (STRAIGHTSHIP.test(description) || canadianTown(location, label)
    || (!location && STRAIGHTSHIP_RECORD.test(description)))) return 'UTC';
  return jsExpressChinaClock(description, location) ?? null;
}

/** An optional text field; anything but a string is a changed reply. */
function text(record: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = record[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `JS Express returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * The lookup's body as JSON. Without the tracking page as its referrer, the
 * lookup prints a refusal before its answer, which is dropped; a block page
 * in place of JSON is a challenge.
 */
export function jsExpressReply(body: string): unknown {
  if (!body.trim()) throw new IndeterminateError(PROVIDER, 'JS Express returned an empty reply');
  try {
    return JSON.parse(body.replace(REFUSAL, ''));
  } catch (cause) {
    if (BLOCKED.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'JS Express answered with a block page', { cause });
    throw new SchemaError(PROVIDER, 'JS Express returned a reply that is not JSON', { cause });
  }
}

/**
 * The destination courier's number, `trackNo`, and that courier when the
 * catalog settles the number for one carrier at high confidence and that
 * carrier works in the country the parcel goes to. The reply names no
 * courier. A USPS routing barcode gives its package identifier.
 */
function handoff(waybill: Record<string, unknown>, number: string, country: string | null): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const compact = normalizeTrackingNumber(text(waybill, 'trackNo', 64)).toUpperCase();
  const reference = USPS_ROUTING_BARCODE.test(compact) ? uspsPackageIdentifier(compact) ?? '' : compact;
  if (!/^[A-Z0-9]{4,40}$/.test(reference) || reference === number) return {};
  const detected = detectCarrierMatch(reference);
  const partner = detected.confidence === 'high' && detected.carrier !== 'js-express' && country
    && CARRIER_DEFINITIONS[detected.carrier]?.countries?.includes(country) ? detected.carrier : undefined;
  return { ...(partner ? { delivery_carrier: partner } : {}), delivery_tracking_number: reference };
}

/**
 * The reply of the English tracking page's lookup `index.php?c=trace` for one
 * number: `code` 0 and the waybill, with the country it goes to, the
 * destination courier's number once it has one, and the scans newest first by
 * wall clock, each a date, a place and a wording. An unknown number gets
 * `code` 1 and "未获取到任何数据,请提供有效单号!". The rows' offsets, the
 * shop's order number, the delivery photos and the estimate are not read.
 */
export function parseJsExpress(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeJsExpressNumber(rawNumber);
  if (!isRecord(payload) || typeof payload.code !== 'number') throw new SchemaError(PROVIDER, 'JS Express returned an invalid reply');
  if (payload.code !== 0) {
    const message = text(payload, 'message', 200);
    if (payload.code === 1 && message.startsWith(NOT_FOUND)) throw new NotFoundError(PROVIDER);
    if (message === REFUSED) throw new ChallengeError(PROVIDER, 'JS Express refused the lookup');
    if (CAPTCHA.test(message)) throw new ChallengeError(PROVIDER, 'JS Express asked for its captcha');
    throw new SchemaError(PROVIDER, 'JS Express returned an unexpected answer');
  }
  if (!Array.isArray(payload.data)) throw new SchemaError(PROVIDER, 'JS Express returned an invalid reply');
  const waybills = payload.data.map((waybill: unknown) => {
    if (!isRecord(waybill) || typeof waybill.jsWaybillNo !== 'string') throw new SchemaError(PROVIDER, 'JS Express returned a waybill without its number');
    return waybill;
  }).filter((waybill) => normalizeTrackingNumber(clean(waybill.jsWaybillNo, 64)) === number);
  if (waybills.length !== 1) throw new SchemaError(PROVIDER, 'JS Express answered for another waybill');
  const waybill = waybills[0]!;
  const rows = waybill.tracking;
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'JS Express returned a waybill with invalid scans');
  // The page's script says "暂无轨迹数据" for a waybill without scans.
  if (!rows.length) throw new NoHistoryError(PROVIDER);
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'JS Express returned an oversized history');

  const seen = new Set<string>();
  const scans: { local: string; label: string; description: string; location: string }[] = [];
  for (const row of rows) {
    if (!isRecord(row) || typeof row.date !== 'string' || typeof row.status !== 'string') throw new SchemaError(PROVIDER, 'JS Express history changed');
    const label = text(row, 'address', 200);
    const local = wallClock(clean(row.date, 32));
    const { description, location } = jsExpressScan(row.status, label);
    if (!description) throw new SchemaError(PROVIDER, 'JS Express returned a scan without wording');
    const key = JSON.stringify([local, location, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    scans.push({ local, label: clean(label, 120), description, location });
  }

  const straightship = scans.some((scan) => STRAIGHTSHIP.test(scan.description));
  const events = scans.map(({ local, label, description, location }): CarrierEvent => {
    const zone = scanZone(description, location, label, straightship);
    const time = zone ? isoTime(local, zone)?.iso : undefined;
    const staged = jsExpressStage(description);
    return {
      ...(time ? { time } : { local_time: local }),
      ...(location ? { location } : {}),
      description: jsExpressEnglish(description) ?? description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    };
  });

  // The reply's order stands: a history mixes the clocks of several countries.
  // The newest row's instant, when it has one, is the last update, and a dated
  // delivery's is the delivery time.
  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const destination = text(waybill, 'country', 60);
  const country = countryCode(destination);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.time ? {} : { last_update_local: newest.local_time! }),
    ...(stage === 'delivered' && current!.time ? { delivered_at: current!.time } : {}),
    expected_delivery: null,
    ...(country ? { destination_country: country } : destination ? { destination_country_name: destination } : {}),
    ...handoff(waybill, number, country),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
