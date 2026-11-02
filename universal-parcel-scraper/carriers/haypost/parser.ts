import { DateTime } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { haypostStage } from './status.js';

export const PROVIDER = 'HayPost';
// A long history is a few kilobytes.
export const HAYPOST_MAX_BYTES = 512 * 1024;

const ZONE = 'Asia/Yerevan';
const MAX_SCANS = 500;
// The scanning office's wall clock, without a zone: "2026-10-02T10:34:54".
const CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
// The tracker's answer for an item it does not know, whatever the code's shape.
const UNKNOWN_ITEM = 'Not Valid Tracking Number Format';
// An inward scan, in the country the item was sent to.
const INWARD = /\(inb\)\s*$/i;
// A run of four or more digits, as an office's postcode is written.
const DIGITS = /(?:^|\s)\d{4,}(?=\s|$)/g;
// The reason IPS gives for an item not delivered, and what happens next:
// "Reason : Addressee not availableMeasure : Scheduled for further action/processing today".
const REASON = /^Reason\s*:\s*(.+?)\s*(?:Measure\s*:\s*(.+))?$/i;

/**
 * HayPost's tracker looks up UPU S10 item codes: its own, ending AM, and those
 * of the posts that send mail to Armenia. The code needs a valid check digit.
 */
export function normalizeHaypostNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (isValidS10TrackingNumber(number)) return number;
  throw new InvalidInputError(PROVIDER, 'HayPost tracks S10 item codes');
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength: number): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `HayPost returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A calendar-checked wall clock to the second; parsing in UTC assigns no offset. */
function wallClock(value: string): string {
  const parsed = CLOCK.test(value) ? DateTime.fromISO(value, { zone: 'UTC' }) : null;
  if (!parsed?.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== value || parsed.year < 2000) {
    throw new SchemaError(PROVIDER, 'HayPost returned an invalid scan time');
  }
  return value;
}

/** The reason an item was not delivered, and what happens next; any other detail is dropped. */
function reasonOf(detail: string): string {
  const match = REASON.exec(detail);
  return match ? [match[1], match[2]].filter(Boolean).map(part => clean(part, 120)).join('; ') : '';
}

interface Scan { event: CarrierEvent; wording: string; country: string | null }

/**
 * One row. Its `eventDate`, the same clock as its `local_Date`, is the wall
 * clock of the office that scanned the item: HayPost's offices read on Yerevan
 * time, and an office abroad, or in a country the row does not settle, keeps
 * its wall clock. IPS names countries in ISO's style, "Netherlands (the)".
 */
function scanOf(row: unknown): Scan {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'HayPost returned an invalid scan');
  const wording = text(row, 'event', 200);
  if (!wording) throw new SchemaError(PROVIDER, 'HayPost returned a scan without wording');
  const local = wallClock(text(row, 'eventDate', 40));
  const countryName = text(row, 'country', 80).replace(/\s*\(the\)$/i, '');
  const country = countryName ? countryCode(countryName) : null;
  const office = text(row, 'location', 120).replace(DIGITS, ' ').replace(/\s+/g, ' ').trim();
  // The office, then its country, which a scan abroad can name alone.
  const location = office.toLowerCase() === countryName.toLowerCase() ? countryName : [office, countryName].filter(Boolean).join(', ');
  const reason = reasonOf(text(row, 'extraInformation', 300));
  const description = reason ? `${wording}: ${reason}` : wording;
  const time = country === 'AM' ? firstOccurrence(DateTime.fromISO(local, { zone: ZONE })).toISO({ suppressMilliseconds: true })! : null;
  const staged = haypostStage(description);
  const event: CarrierEvent = {
    ...(time ? { time } : { local_time: local }),
    ...(location ? { location } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { event, wording, country };
}

/**
 * The reply of the tracking page's `GET /trackingNumber/` for one code:
 * `error`, a `message`, and the item's scans oldest first in `data.result`.
 * It does not echo the code, so its scans are those of the code asked for. A
 * code the tracker does not know comes back as the error "Not Valid Tracking
 * Number Format" with no scans; any other error is no answer.
 */
export function parseHaypost(payload: unknown, rawNumber: string): CarrierResult {
  normalizeHaypostNumber(rawNumber);
  if (!isRecord(payload) || typeof payload.error !== 'boolean') throw new SchemaError(PROVIDER, 'HayPost returned an invalid reply');
  const data = isRecord(payload.data) ? payload.data : null;
  if (payload.error) {
    if (payload.message === UNKNOWN_ITEM && Array.isArray(data?.result) && !data.result.length) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'HayPost did not complete the lookup');
  }
  const rows = data?.result;
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'HayPost returned an item with invalid scans');
  if (rows.length > MAX_SCANS) throw new SchemaError(PROVIDER, 'HayPost returned an oversized history');

  const seen = new Set<string>();
  const scans: Scan[] = [];
  for (const row of rows) {
    const scan = scanOf(row);
    // A row the reply lists twice is kept once.
    const identity = JSON.stringify(scan.event);
    if (seen.has(identity)) continue;
    seen.add(identity);
    scans.push(scan);
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the page lists the reply's rows.
  scans.reverse();
  const events = scans.map(({ event }) => event);

  const latest = events[0]!;
  const current = events.find(event => event.stage);
  const stage = current?.stage as Stage | undefined;
  const delivered = stage === 'delivered' ? current!.time ?? null : null;
  // An inward scan is recorded in the country the item was sent to.
  const destination = scans.find(scan => scan.country && INWARD.test(scan.wording))?.country;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    ...(latest.time ? {} : { last_update_local: latest.local_time }),
    expected_delivery: null,
    ...(delivered ? { delivered_at: delivered } : {}),
    ...(destination ? { destination_country: destination } : {}),
    events,
  };
}
