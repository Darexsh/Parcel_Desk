import { DateTime } from 'luxon';
import { carrierIdFromPartner, carrierIdFromPartnerLinks } from '../../core/catalog/hints.js';
import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { ESTIMATE, NOTICE, sfcStage, sfcSummaryStage } from './status.js';

export const PROVIDER = 'SFC';
// A long history is a few kilobytes.
export const SFC_MAX_BYTES = 512 * 1024;
// SFC, a digit and SFC's order code: two letters and thirteen or fourteen digits.
const LABEL_NUMBER = /^SFC\d([A-Z]{2}\d{13,14})$/;
// The number SFC gives an AliExpress order: SFC, two letters, ten digits and YQ.
const AE_NUMBER = /^SFC[A-Z]{2}\d{10}YQ$/;
// The number of the courier SFC hands the parcel to, when it is digits alone.
const PARTNER_NUMBER = /^\d{10,30}$/;
const ISO_CLOCK = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
// Older replies wrote the month first.
const US_CLOCK = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** An SFC number, the number SFC gives an AliExpress order, or a partner's number of digits. */
export function normalizeSfcNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!LABEL_NUMBER.test(number) && !AE_NUMBER.test(number) && !PARTNER_NUMBER.test(number)) {
    throw new InvalidInputError(PROVIDER, 'SFC numbers are SFC, a digit, two letters and thirteen or fourteen digits, or its partner\'s number of digits');
  }
  return number;
}

/** An optional text field; an object or array is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 500): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' && typeof value !== 'number') throw new SchemaError(PROVIDER, `SFC returned an invalid ${key}`);
  return cleanScalar(value, maxLength);
}

// A run of nine or more digits, with spaces, brackets, dots, slashes or
// hyphens between them, as phone numbers are written; a date stays.
const PHONE = /(?<![A-Z\d])(?!\d{4}-\d{2}-\d{2}(?!\d))\+?\d(?:[\s()./-]{0,2}\d){8,}(?![A-Z\d])/gi;
// SFC's wording, then the partner's own text in brackets: "Delivered(…)".
const RELAYED = /^([^(（]*?)\s*[(（][\s\S]*[)）]\s*$/;
// The scan that names the courier SFC hands the parcel to, then its number,
// its phone numbers and its website.
const HANDOVER = /^Last mile courier\s*=>\s*(.+?)\.?\s+Tracking No\.?\s*:\s*([A-Z\d-]{4,40})(?![A-Z\d-])/i;
const WEBSITE = /\bTracking website\s*:\s*(https?:\/\/[^\s<>"'()]+)/i;

interface Handover { name: string; number: string; website: string }

function withoutPhones(value: string): string {
  return clean(value.replace(PHONE, '').replace(/\s+([,;:.])/g, '$1')).replace(/[\s,;:\-–]+$/, '');
}

/**
 * A scan's wording: SFC's own, without the partner's text it puts in
 * brackets after it, which can name the recipient and the courier and
 * carries phone numbers. The hand-over scan keeps the courier, its number
 * and its website, not its phone numbers.
 */
export function sfcWording(statu: string): { description: string; handover?: Handover } {
  const line = clean(statu, 1000);
  const handover = HANDOVER.exec(line);
  if (handover) {
    const name = withoutPhones(handover[1]!).slice(0, 80);
    const number = handover[2]!.replace(/-/g, '').toUpperCase();
    const website = WEBSITE.exec(line)?.[1]?.slice(0, 200) ?? '';
    return {
      description: `Last mile courier=>${name}. Tracking No.: ${number}${website ? ` Tracking website: ${website}` : ''}`,
      handover: { name, number, website },
    };
  }
  const own = RELAYED.exec(line)?.[1] || line;
  return { description: withoutPhones(own.replace(/\bTel\s*:[\s\S]*?(?=\bTracking website\b|$)/i, '')).slice(0, 300) };
}

/** A scan's wall clock. The reply names no zone, and the partner's scans are on the destination's clock. */
function scanClock(row: Record<string, unknown>): string {
  const stamp = text(row, 'date', 32);
  const iso = ISO_CLOCK.exec(stamp);
  const us = iso ? null : US_CLOCK.exec(stamp);
  const local = iso ? `${iso[1]}-${iso[2]}-${iso[3]}T${iso[4]}:${iso[5]}:${iso[6]}`
    : us ? `${us[3]}-${us[1]}-${us[2]}T${us[4]}:${us[5]}:${us[6]}` : '';
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  // Luxon rolls 24:00:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!local || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'SFC returned an invalid scan time');
  }
  return local;
}

function projectRow(row: unknown): { key: string; event: CarrierEvent; handover?: Handover } | null {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'SFC returned an invalid scan');
  const { description, handover } = sfcWording(text(row, 'statu', 2000));
  if (!description) throw new SchemaError(PROVIDER, 'SFC returned a scan without wording');
  // The departure or arrival SFC expects for the flight is written before it and is no scan.
  if (ESTIMATE.test(description)) return null;
  const local = scanClock(row);
  const location = text(row, 'location', 120);
  const staged = sfcStage(description);
  const event: CarrierEvent = {
    local_time: local,
    ...(location ? { location } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([local, description, location]), event, ...(handover ? { handover } : {}) };
}

// SFC can write its delivery notice again a second from the first, as the
// parcel leaves its warehouse. A notice within a minute after another at the
// same place counts once, at the earlier clock.
const NOTICE_REPEAT_MS = 60_000;

function withoutRepeatedNotices(events: CarrierEvent[]): CarrierEvent[] {
  const at = (event: CarrierEvent) => Date.parse(`${event.local_time as string}Z`);
  const notice = (event: CarrierEvent) => normalizeStatusWording(event.description ?? '') === NOTICE;
  return events.filter((event) => !notice(event) || !events.some((other) => notice(other)
    && (other.location ?? '') === (event.location ?? '') && at(other) < at(event) && at(event) - at(other) <= NOTICE_REPEAT_MS));
}

/** The scans: a list, or an object keyed by position that may also carry `track_status`, as the page reads them. */
function rowsOf(list: unknown): unknown[] {
  if (list === null || list === undefined) return [];
  if (Array.isArray(list)) return list;
  if (!isRecord(list)) throw new SchemaError(PROVIDER, 'SFC returned an order with invalid scans');
  return Object.keys(list).filter((key) => /^\d+$/.test(key)).sort((a, b) => Number(a) - Number(b)).map((key) => list[key]);
}

/**
 * The courier the newest hand-over scan names, and its number, when the
 * order's own partner number agrees. The courier counts when the scan's
 * website or name points to one catalog carrier whose rules take the number.
 */
function handoff(handover: Handover | undefined, info: Record<string, unknown>, number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  if (!handover || handover.number === number || !/^[A-Z0-9]{4,40}$/.test(handover.number)) return {};
  const listed = normalizeTrackingNumber(text(info, 'tracking_number', 64)).toUpperCase();
  if (listed && listed !== handover.number) return {};
  const partner = carrierIdFromPartnerLinks([handover.website], 'sfc') ?? carrierIdFromPartner(handover.name, handover.website);
  const takes = partner && partner !== 'sfc' && (detectCarrierMatch(handover.number).candidates as string[]).includes(partner);
  return { ...(takes ? { delivery_carrier: partner } : {}), delivery_tracking_number: handover.number };
}

/**
 * The reply of the tracking page's `get-track-for-web` lookup for one number.
 * `count` 0 is the page's unknown-number answer. The lookup also finds an
 * order by its partner's number or the shop's reference and reads the
 * number's digit after SFC loosely, so an order counts only when its own
 * order code, its AliExpress number or, for digits alone, the partner number
 * it lists is the number asked.
 */
export function parseSfc(payload: unknown, raw: string): CarrierResult {
  const number = normalizeSfcNumber(raw);
  if (!isRecord(payload) || typeof payload.count !== 'number' || !Number.isInteger(payload.count) || payload.count < 0) {
    throw new SchemaError(PROVIDER, 'SFC returned an invalid envelope');
  }
  // The reply repeats the number asked; another one is someone else's answer.
  const asked = normalizeTrackingNumber(text(payload, 'order_code', 64)).toUpperCase();
  if (!asked) throw new SchemaError(PROVIDER, 'SFC returned a reply without the number asked');
  if (asked !== number) throw new IndeterminateError(PROVIDER, 'SFC answered for another number');
  if (payload.count === 0) throw new NotFoundError(PROVIDER);
  // The page shows nothing when a reference matches several orders.
  if (payload.count > 1) throw new IndeterminateError(PROVIDER, 'SFC found several orders for the number');
  const info = payload.orderInfo;
  if (!isRecord(info)) throw new SchemaError(PROVIDER, 'SFC returned an order without its details');
  const order = LABEL_NUMBER.exec(number)?.[1];
  const listed = PARTNER_NUMBER.test(number) ? 'tracking_number' : 'order_code_ae';
  const own = order ? text(info, 'order_code', 64).toUpperCase() === order : text(info, listed, 64).toUpperCase() === number;
  if (!own) throw new IndeterminateError(PROVIDER, 'SFC answered for another shipment');
  const rows = rowsOf(payload.trackingList);
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'SFC returned an oversized history');

  const seen = new Set<string>();
  const scans: CarrierEvent[] = [];
  const handovers: Handover[] = [];
  for (const row of rows) {
    const scan = projectRow(row);
    if (!scan || seen.has(scan.key)) continue;
    seen.add(scan.key);
    scans.push(scan.event);
    if (scan.handover) handovers.push(scan.handover);
  }
  const events = withoutRepeatedNotices(scans);
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the page lists them; an oldest-first reply is turned round.
  const oldestFirst = (events[0]!.local_time as string) < (events.at(-1)!.local_time as string);
  const newestFirst = oldestFirst ? events.reverse() : events;
  const handover = oldestFirst ? handovers.at(-1) : handovers[0];

  const newest = newestFirst[0]!;
  const scanned = newestFirst.find((event) => event.stage);
  const summary = sfcSummaryStage(payload.track_status);
  const stage = (summary ?? scanned?.stage) as Stage | undefined;
  const source = summary && summary !== scanned?.stage ? 'carrier_map' : scanned?.stage_source;
  const destination = isRecord(info.country) ? text(info.country, 'en_name', 80) : '';
  const country = destination ? countryCode(destination) : null;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    ...handoff(handover, info, number),
    ...(country ? { destination_country: country } : destination ? { destination_country_name: destination } : {}),
    events: newestFirst.slice(0, MAX_EVENTS),
    ...(newestFirst.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
