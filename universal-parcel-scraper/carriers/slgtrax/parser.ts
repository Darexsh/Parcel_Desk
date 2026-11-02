import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { slgtraxStage } from './status.js';

export const PROVIDER = 'SLGTrax';
// A reply with a long history is a few kilobytes.
export const SLGTRAX_MAX_BYTES = 256 * 1024;

// Every number seen on Trax's trackers is fourteen digits.
const NUMBER = /^\d{14}$/;
const ZONE = 'Asia/Karachi';
// The day, month and year, then a twelve-hour clock, as "12/03/2026 04:40 PM".
const CLOCK = /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2} [AP]M$/;
const CLOCK_FORMAT = 'dd/LL/yyyy hh:mm a';
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|_cf_chl_opt|cf-turnstile|g-recaptcha|hcaptcha|_Incapsula_Resource|AwsWafIntegration|awswaf\.com/i;
// A run of ten or more digits with spaces or hyphens, as phone numbers are written.
const PHONE = /(?<![A-Z\d])\+?\d(?:[\s-]?\d){9,}(?![A-Z\d])/gi;
// An amount to collect in rupees.
const AMOUNT = /\b(?:Rs\.?|PKR)\s*\d[\d,]*(?:\.\d+)?/gi;
const MAX_ROWS = 300;
const MAX_EVENTS = 100;

/** A Trax tracking number: fourteen digits. */
export function normalizeSlgtraxNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Trax tracking numbers are fourteen digits');
  return number;
}

/** The reply's JSON; a page in its place is a block or a changed route. */
export function slgtraxJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'SLGTrax answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'SLGTrax returned a reply that is not JSON', { cause });
  }
}

/** A failed attempt's reason without phone numbers or an amount to collect. */
export function slgtraxReason(text: string): string {
  return clean(text.replace(PHONE, '').replace(AMOUNT, ''), 200)
    .replace(/\s+([,.;:])/g, '$1').replace(/^[\s,;:.-]+|[\s,;:-]+$/g, '');
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength: number): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `SLGTrax returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * A scan's instant. `date_time` is the Karachi wall clock the page shows, to
 * the minute: Trax's network is in Pakistan, which keeps one offset without
 * daylight saving. `timestamp` is the same instant in Unix seconds, and adds
 * its seconds when it falls in that minute.
 */
function instantOf(row: Record<string, unknown>): { time: string; at: number } {
  const shown = text(row, 'date_time', 40);
  // UTC only checks the calendar fields.
  const checked = CLOCK.test(shown) ? DateTime.fromFormat(shown, CLOCK_FORMAT, { zone: 'UTC', locale: 'en-US' }) : null;
  if (!checked?.isValid || checked.toFormat(CLOCK_FORMAT, { locale: 'en-US' }) !== shown) {
    throw new SchemaError(PROVIDER, 'SLGTrax returned an invalid scan time');
  }
  const wall = firstOccurrence(DateTime.fromISO(checked.toFormat("yyyy-MM-dd'T'HH:mm"), { zone: ZONE }));
  const seconds = row.timestamp;
  const exact = typeof seconds === 'number' && Number.isSafeInteger(seconds) && seconds > 0
    ? DateTime.fromSeconds(seconds, { zone: ZONE }) : null;
  const instant = exact?.isValid && exact.startOf('minute').toMillis() === wall.toMillis() ? exact : wall;
  return { time: instant.toISO({ suppressMilliseconds: true })!, at: instant.toMillis() };
}

interface Scan { event: CarrierEvent; at: number }

function projectRow(row: Record<string, unknown>): Scan {
  const status = text(row, 'status', 120);
  if (!status) throw new SchemaError(PROVIDER, 'SLGTrax returned a scan without a status');
  const reason = slgtraxReason(text(row, 'status_reason', 300));
  const { time, at } = instantOf(row);
  const staged = slgtraxStage(status);
  const event: CarrierEvent = {
    time,
    description: reason ? `${status}: ${reason}` : status,
    provider_code: status,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { event, at };
}

/** The one shipment of a reply that is for the number asked. */
function shipmentFor(details: Record<string, unknown>, number: string): Record<string, unknown> {
  const values = Object.values(details);
  const shipments = values.filter(isRecord);
  if (!shipments.length || shipments.length !== values.length) throw new SchemaError(PROVIDER, 'SLGTrax returned invalid shipment details');
  const matching = shipments.filter((shipment) => cleanScalar(shipment.tracking_number, 64) === number);
  if (matching.length > 1) throw new IndeterminateError(PROVIDER, 'SLGTrax answered with more than one shipment for the number');
  if (!matching.length) {
    if (shipments.some((shipment) => !cleanScalar(shipment.tracking_number, 64))) {
      throw new SchemaError(PROVIDER, 'SLGTrax returned a shipment without its number');
    }
    throw new IndeterminateError(PROVIDER, 'SLGTrax answered for another shipment');
  }
  return matching[0]!;
}

/**
 * The reply of `/api/shipment/track/consignee/public`, the lookup slgtrax.com's
 * tracking box makes: `status` 1 with the shipment under `details`, keyed by
 * Trax's own id, or `status` 0 with the number listed under `errors` when Trax
 * has no shipment under it. A shipment names its tracking number, the shipper,
 * pickup city, consignee, order and its scans newest first. Only the number
 * and the scans are read: the shipper, the consignee's name, phones, address
 * and city, the order's contents, weight and amount to collect are not kept.
 */
export function parseSlgtrax(payload: unknown, raw: string): CarrierResult {
  const number = normalizeSlgtraxNumber(raw);
  if (!isRecord(payload) || (payload.status !== 0 && payload.status !== 1)) throw new SchemaError(PROVIDER, 'SLGTrax returned an invalid envelope');
  if (payload.status === 0) {
    // The tracker lists the numbers it has no shipment under; another error is a refused lookup.
    const listed = isRecord(payload.errors) ? payload.errors.tracking_number : undefined;
    if (Array.isArray(listed) && listed.some((entry) => cleanScalar(entry, 64) === number)) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'SLGTrax refused the lookup');
  }
  if (!isRecord(payload.details)) throw new SchemaError(PROVIDER, 'SLGTrax returned a reply without shipment details');
  const shipment = shipmentFor(payload.details, number);
  const rows = shipment.tracking_history ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'SLGTrax returned an invalid history');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'SLGTrax returned an oversized history');

  const seen = new Set<string>();
  const scans: Scan[] = [];
  rows.forEach((row) => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'SLGTrax returned an invalid scan');
    const scan = projectRow(row);
    const identity = JSON.stringify([scan.at, scan.event.description]);
    if (seen.has(identity)) return;
    seen.add(identity);
    scans.push(scan);
  });
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first; scans of the same second keep the reply's order, which is newest first.
  if (listsNewestFirst(scans.map(({ event }) => event)) === false) scans.reverse();
  const events = scans.sort((left, right) => right.at - left.at).map(({ event }) => event);

  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: null,
    ...(stage === 'delivered' ? { delivered_at: current!.time } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
