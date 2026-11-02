import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, countryCode } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { equickScanStage } from './status.js';

export const PROVIDER = 'Equick';
// A long history is a few kilobytes; the tracker answers up to fifty numbers a request.
export const EQUICK_MAX_BYTES = 512 * 1024;
// EQK, two letters, ten digits and YQ, as the current tracker's numbers read, or the nine
// digits of the older tracker's.
const NUMBER = /^(?:EQK[A-Z]{2}\d{10}YQ|\d{9})$/;
// The delivering carrier's number.
const PARTNER_NUMBER = /^(?=.*\d)[A-Z0-9]{4,40}$/;
// "2029-12-14 18:35:22", the scan's wall clock.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/;
// A run of nine or more digits, with spaces, brackets, dots or hyphens between them, as phone
// numbers are written; a date stays.
const PHONE = /(?<![A-Z\d])(?!\d{4}-\d{2}-\d{2}(?!\d))\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
// Who took a delivered parcel, after the delivery's own words.
const RECEIVER = /\s*[,;:.\-–]?\s*\b(?:signed(?: for)? by|signatory|received by)\b[\s\S]*$/i;
const MAX_NUMBERS = 50;
const MAX_ROWS = 500;

/** An Equick number, in capitals; anything else is not one Equick issues. */
export function normalizeEquickNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Equick numbers are EQK, two letters, ten digits and YQ, or nine digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Equick returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A scan's wording without who signed for it or phone numbers. */
export function equickWording(value: string): string {
  return clean(value.replace(RECEIVER, '').replace(PHONE, '').replace(/\s+([,;:.])/g, '$1'))
    .replace(/^[\s,;:\-–]+|[\s,;:\-–]+$/g, '');
}

/** A scan's clock as an ISO wall time, to the second; the day and time must exist. */
function wallClock(value: string): string {
  const match = CLOCK.exec(value);
  const date = match ? calendarDay(Number(match[1]), Number(match[2]), Number(match[3])) : null;
  const [hour, minute, second] = [Number(match?.[4]), Number(match?.[5]), Number(match?.[6] ?? 0)];
  if (!date || hour > 23 || minute > 59 || second > 59) throw new SchemaError(PROVIDER, 'Equick returned an invalid scan time');
  return `${date}T${match![4]!}:${match![5]!}:${match![6] ?? '00'}`;
}

/** The scans under the number's key, deduplicated, with the delivering carrier's numbers they carry. */
function scans(rows: unknown[], number: string): { events: CarrierEvent[]; country: string; partners: Set<string> } {
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  const partners = new Set<string>();
  let country = '';
  for (const row of rows) {
    if (!isRecord(row) || typeof row.traceLabelNo !== 'string') throw new SchemaError(PROVIDER, 'Equick returned an invalid scan');
    // Every scan names the shipment it belongs to.
    if (normalizeTrackingNumber(row.traceLabelNo) !== number) throw new IndeterminateError(PROVIDER, 'Equick answered for another shipment');
    const said = text(row, 'traceContent', 2000);
    if (!said) throw new SchemaError(PROVIDER, 'Equick returned a scan without its wording');
    const local = wallClock(text(row, 'traceDateTime', 40));
    const description = equickWording(said);
    country ||= text(row, 'traceCountry', 80);
    const partner = text(row, 'destinationWBNo', 200);
    if (partner && normalizeTrackingNumber(partner) !== number) partners.add(normalizeTrackingNumber(partner));
    if (!description) continue;
    const location = text(row, 'traceLocation', 120);
    const key = JSON.stringify([local, description, location]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = equickScanStage(description);
    events.push({
      local_time: local,
      description,
      ...(location ? { location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    });
  }
  return { events, country, partners };
}

/**
 * The reply of the tracker's `POST /api/traceQuery` for one number:
 * `{"code":1,"msg":"success","data":{…}}`, where `data` keys each number asked,
 * as it was sent, to its scans. A number the tracker does not know has no key,
 * so one asked alone gets `{}`, which the page reports as no result. A `code`
 * other than 1 is a lookup the service did not complete. Every scan must name
 * the whole number asked.
 */
export function parseEquick(payload: unknown, raw: string): CarrierResult {
  const number = normalizeEquickNumber(raw);
  if (!isRecord(payload) || typeof payload.code !== 'number') throw new SchemaError(PROVIDER, 'Equick returned an invalid envelope');
  if (payload.code !== 1) throw new IndeterminateError(PROVIDER, 'Equick did not complete the lookup');
  const data = payload.data;
  // The service's answer to a request without a number.
  if (data === null) throw new IndeterminateError(PROVIDER, 'Equick returned an empty result');
  if (!isRecord(data)) throw new SchemaError(PROVIDER, 'Equick returned an invalid result');
  const keys = Object.keys(data);
  if (keys.length > MAX_NUMBERS) throw new SchemaError(PROVIDER, 'Equick returned too many results');
  if (!keys.length) throw new NotFoundError(PROVIDER);
  const mine = keys.filter((key) => normalizeTrackingNumber(key) === number);
  if (!mine.length) throw new IndeterminateError(PROVIDER, 'Equick answered for another number');
  if (mine.length > 1) throw new IndeterminateError(PROVIDER, 'Equick returned several results for the number');
  const rows = data[mine[0]!];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Equick returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Equick returned an oversized history');

  const { events, country, partners } = scans(rows, number);
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the tracker lists them by wall clock; an oldest-first reply is turned round.
  // The clocks can be several places', so the order otherwise stands.
  const newestFirst = (events[0]!.local_time as string) < (events.at(-1)!.local_time as string) ? events.reverse() : events;
  const newest = newestFirst[0]!;
  const scanned = newestFirst.find((event) => event.stage);
  const stage = scanned?.stage as Stage | undefined;
  const destination = country ? countryCode(country) : null;
  const [partner] = partners;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: scanned!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    ...(destination ? { destination_country: destination } : country ? { destination_country_name: country } : {}),
    // The delivering carrier's number, when the scans carry one; the reply does not name the carrier.
    ...(partners.size === 1 && PARTNER_NUMBER.test(partner!) ? { delivery_tracking_number: partner! } : {}),
    events: newestFirst,
  };
}
