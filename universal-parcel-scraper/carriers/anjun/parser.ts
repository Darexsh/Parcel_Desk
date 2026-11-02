import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean, cleanScalar, textFromHtml } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { anjunStage } from './status.js';

export const PROVIDER = 'Anjun';
// A long history is under thirty kilobytes.
export const ANJUN_MAX_BYTES = 512 * 1024;
// Anjun's own numbers: AJ and fifteen digits.
const NUMBER = /^AJ\d{15}$/;
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
// The tracker's message for a number it does not know: "tracking number not found".
const NOT_FOUND = '未找到单号';
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
// A run of nine or more digits, with spaces, brackets, dots or hyphens
// between them, as phone numbers are written; a date stays.
const PHONE = /(?<![A-Z\d])(?!\d{4}-\d{2}-\d{2}(?!\d))\+?\(?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** An Anjun number, in capitals as the tracker echoes it; anything else is not one Anjun issues. */
export function normalizeAnjunNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Anjun numbers are AJ and fifteen digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Anjun returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** Free text without phone numbers or e-mail addresses. */
function scrubbed(value: string): string {
  return clean(value.replace(EMAIL, '').replace(PHONE, '').replace(/\s+([,;:.])/g, '$1')).replace(/^[\s,;:.\-–]+|[\s,;:\-–]+$/g, '');
}

/** A note without the sentences that give a phone number or an e-mail address, which are contacts, not news of the parcel. */
function withoutContacts(value: string): string {
  return scrubbed(value.split(/(?<=[.!?。])\s+/).filter((sentence) => sentence.search(EMAIL) < 0 && sentence.search(PHONE) < 0).join(' '));
}

/**
 * A scan's wording: its line, the reason a delivery failed and the detail the
 * page shows beside the line when the reply gives them, then the note the page
 * shows under it, without its contact sentences. A delivery's note is left
 * out, since it could name who took the parcel.
 */
export function anjunWording(status: string, details: readonly string[], remark: string, delivered: boolean): string {
  const line = scrubbed(status);
  const why = [...new Set(details.map(scrubbed).filter(Boolean))].join(', ');
  const note = delivered ? '' : withoutContacts(textFromHtml(remark, 1000));
  const head = line && why ? `${line}: ${why}` : line || why;
  if (!note) return head;
  if (!head) return note;
  return /[.!?。]$/.test(head) ? `${head} ${note}` : `${head}. ${note}`;
}

/**
 * A scan's clock: the scanning site's wall clock, to the second. The reply
 * names no zone, and one history goes from China's clocks to the destination's,
 * so the clock stays local.
 */
function scanClock(row: Record<string, unknown>): string {
  const wall = text(row, 'date', 32);
  const local = wall.replace(' ', 'T');
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  // Luxon rolls 24:00:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!WALL_CLOCK.test(wall) || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'Anjun returned an invalid scan time');
  }
  return local;
}

function projectRow(row: Record<string, unknown>): { key: string; event: CarrierEvent } {
  const code = cleanScalar(row.stateCode, 80);
  const extra = row.extraData;
  if (extra !== null && extra !== undefined && !isRecord(extra)) throw new SchemaError(PROVIDER, 'Anjun returned invalid scan details');
  // The reason a delivery failed, and a detail the page shows beside the line.
  // The recipient's street, number and district beside them are never read.
  const details = extra ? [text(extra, 'problemType', 120), text(extra, 'statusDetail', 200)] : [];
  const status = text(row, 'status', 500);
  const delivered = anjunStage(code, status)?.stage === 'delivered';
  const description = anjunWording(status, details, text(row, 'remark', 1000), delivered);
  if (!description) throw new SchemaError(PROVIDER, 'Anjun returned a scan without wording');
  const local = scanClock(row);
  const location = text(row, 'address', 120);
  const staged = anjunStage(code, description);
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
 * The reply of `GET /open/website/track` for one number. A number the tracker
 * does not know is `code` 500 with its not-found message; another failure
 * says nothing about the parcel. A history must echo the number asked in
 * `extra.trackNo`. Coordinates, the recipient's and facilities' addresses,
 * couriers and delivery files in the rows are never read.
 */
export function parseAnjun(payload: unknown, raw: string): CarrierResult {
  const number = normalizeAnjunNumber(raw);
  if (!isRecord(payload) || typeof payload.code !== 'number') throw new SchemaError(PROVIDER, 'Anjun returned an invalid envelope');
  if (payload.code !== 200) {
    if (payload.code === 500 && clean(payload.msg, 80) === NOT_FOUND) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Anjun did not complete the lookup');
  }
  const extra = payload.extra;
  if (!isRecord(extra) || typeof extra.trackNo !== 'string') throw new SchemaError(PROVIDER, 'Anjun returned a history without its number');
  if (normalizeTrackingNumber(clean(extra.trackNo, 64)).toUpperCase() !== number) {
    throw new IndeterminateError(PROVIDER, 'Anjun answered for another shipment');
  }
  // The page shows the destination's country code beside the number when the reply has one.
  const country = typeof extra.countryCode === 'string' ? clean(extra.countryCode, 8).toUpperCase() : '';
  const rows = payload.data;
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Anjun returned a history with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Anjun returned an oversized history');

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Anjun returned an invalid scan');
    const scan = projectRow(row);
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    events.push(scan.event);
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the page lists them; an oldest-first reply is turned round.
  const newestFirst = (events[0]!.local_time as string) < (events.at(-1)!.local_time as string) ? events.reverse() : events;

  const newest = newestFirst[0]!;
  const scanned = newestFirst.find((event) => event.stage);
  const stage = scanned?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: scanned?.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    ...(/^[A-Z]{2}$/.test(country) ? { destination_country: country } : {}),
    events: newestFirst.slice(0, MAX_EVENTS),
    ...(newestFirst.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
