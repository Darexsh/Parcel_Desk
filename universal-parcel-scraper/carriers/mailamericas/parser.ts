import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { mailamericasInstants } from './clock.js';
import { mailamericasStage } from './status.js';

export const PROVIDER = 'MailAmericas';
// A long history is under ten kilobytes.
export const MAILAMERICAS_MAX_BYTES = 512 * 1024;
// The tracking page's own check: letters and digits, eight or more, at least one digit.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,40}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^\d{2}:\d{2}$/;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A number for MailAmericas' tracker, in upper case as the page sends it; anything else is not one it issues. */
export function normalizeMailamericasNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'MailAmericas numbers are eight or more letters and digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `MailAmericas returned an invalid ${key}`);
  return clean(value, maxLength);
}

// A run of nine or more digits, with spaces, brackets, dots or hyphens
// between them, as phone numbers are written; a date stays.
const PHONE = /(?<![A-Z\d])(?!\d{4}-\d{2}-\d{2}(?!\d))\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
// Who took the parcel, after a delivery or delivery-office scan's wording
// ("Recibido por …"). The organisations other legs name ("Received by Last
// Mile Provider") are on codes this does not read.
const RECEIVER = /\s*[,;:.\-–]?\s*\b(?:by|por|pelo|pela)\b[\s\S]*$/i;
// Delivered (PF) and delivery-office (LM) scans.
const HANDOVER = /^(?:PF|LM)-/i;

/**
 * A scan's wording: the leg the page heads it with, then its own line, as
 * "Destination customs: Released". A delivery or delivery-office scan loses
 * a clause naming who took the parcel, and every scan loses phone numbers.
 */
export function mailamericasWording(group: string, detail: string, code = ''): string {
  const own = (HANDOVER.test(code) ? detail.replace(RECEIVER, '') : detail).replace(PHONE, '');
  const line = clean(own.replace(/\s+([,;:.])/g, '$1')).replace(/^[\s,;:.\-–]+|[\s,;:\-–]+$/g, '');
  const leg = clean(group.replace(PHONE, ''));
  if (!line) return leg;
  if (!leg || line.toLowerCase().startsWith(leg.toLowerCase())) return line;
  return `${leg}: ${line}`;
}

/**
 * A scan's wall clock: `date` and `time`, to the minute, without a zone. The
 * leg places it (see clock.ts).
 */
function scanClock(row: Record<string, unknown>): string {
  const date = text(row, 'date', 16);
  const time = text(row, 'time', 16);
  const local = `${date}T${time}:00`;
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!DATE.test(date) || !CLOCK.test(time) || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'MailAmericas returned an invalid scan time');
  }
  return local;
}

function projectRow(row: Record<string, unknown>): { key: string; wall: string; code: string; event: CarrierEvent } {
  const code = cleanScalar(row.code, 16).toUpperCase();
  const description = mailamericasWording(text(row, 'status'), text(row, 'description'), code);
  if (!description) throw new SchemaError(PROVIDER, 'MailAmericas returned a scan without wording');
  const local = scanClock(row);
  const location = text(row, 'location', 120);
  const staged = mailamericasStage(code, description);
  const event: CarrierEvent = {
    ...(location ? { location } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([local, code, description, location]), wall: local, code, event };
}

/**
 * The summary's own word for a parcel whose journey ended or stopped, which
 * the page shows over the scans: a claim is a lost or damaged parcel.
 */
function summaryStage(data: Record<string, unknown>): Stage | undefined {
  if (data.isRetainedAtOrigin === true || data.isCustomsIntervention === true) return 'exception';
  const status = text(data, 'status', 40).toLowerCase();
  if (status === 'delivered') return 'delivered';
  if (status === 'returned') return 'returned';
  if (status === 'claim' || status === 'cancelled') return 'exception';
  return undefined;
}

/** The delivery estimate, a calendar day; the reply puts 1970 dates where it has none. */
function estimate(data: Record<string, unknown>): string | null {
  const value = text(data, 'estimatedDelivery', 32);
  if (!DATE.test(value) || value < '2000-01-01') return null;
  return DateTime.fromISO(value, { zone: 'UTC' }).isValid ? value : null;
}

/** A label the page shows, without the reply's placeholders for a missing one. */
function label(data: Record<string, unknown>, key: string): string {
  const value = text(data, key, 80);
  return /^(?:n\/a|no data|-+)$/i.test(value) ? '' : value;
}

/**
 * The reply of the tracking page's `/api/tracking` for one number. It answers
 * HTTP 200 with `{"data":null}` for a number it does not know, which the page
 * reports as not found. A shipment must name the number asked. A scan dated
 * after `readAt` keeps its wall clock.
 */
export function parseMailamericas(payload: unknown, raw: string, readAt = new Date()): CarrierResult {
  const number = normalizeMailamericasNumber(raw);
  if (!isRecord(payload) || !Object.hasOwn(payload, 'data')) throw new SchemaError(PROVIDER, 'MailAmericas returned an invalid envelope');
  const data = payload.data;
  if (data === null) {
    if (payload.error !== undefined && payload.error !== null) throw new IndeterminateError(PROVIDER, 'MailAmericas did not complete the lookup');
    throw new NotFoundError(PROVIDER);
  }
  if (!isRecord(data) || typeof data.trackingNumber !== 'string') throw new SchemaError(PROVIDER, 'MailAmericas returned a shipment without its number');
  if (clean(data.trackingNumber, 64).toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'MailAmericas answered for another shipment');
  const rows = data.events ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'MailAmericas returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'MailAmericas returned an oversized history');

  const seen = new Set<string>();
  const scans: ReturnType<typeof projectRow>[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'MailAmericas returned an invalid scan');
    const scan = projectRow(row);
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    scans.push(scan);
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the page lists them by wall clock; an oldest-first reply is turned round.
  if (scans[0]!.wall < scans.at(-1)!.wall) scans.reverse();

  const destination = label(data, 'destination');
  const country = destination ? countryCode(destination) : null;
  const instants = mailamericasInstants(scans, { origin: countryCode(label(data, 'origin')), destination: country,
    region: label(data, 'state') }, readAt.getTime());
  const newestFirst = scans.map(({ wall, event }, index): CarrierEvent =>
    ({ ...(instants[index] ? { time: instants[index].iso } : { local_time: wall }), ...event }));
  const newest = newestFirst[0]!;
  const scanned = newestFirst.find((event) => event.stage);
  const summary = summaryStage(data);
  const stage = (summary ?? scanned?.stage) as Stage | undefined;
  const source = summary && summary !== scanned?.stage ? 'carrier_map' : scanned?.stage_source;
  const service = label(data, 'service');
  const expected = stage === 'delivered' || stage === 'returned' ? null : estimate(data);
  const deliveredAt = stage === 'delivered' ? newestFirst.find((event) => event.stage === 'delivered')?.time : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.time ? {} : { last_update_local: newest.local_time }),
    expected_delivery: expected,
    ...(deliveredAt ? { delivered_at: deliveredAt } : {}),
    ...(service ? { service_name: service } : {}),
    ...(country ? { destination_country: country } : destination ? { destination_country_name: destination } : {}),
    events: newestFirst.slice(0, MAX_EVENTS),
    ...(newestFirst.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
