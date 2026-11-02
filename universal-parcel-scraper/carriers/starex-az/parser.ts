import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { isRecord } from '../../core/types.js';
import { starexStage } from './status.js';

export const PROVIDER = 'Starex';
// A reply is a few kilobytes.
export const STAREX_MAX_BYTES = 256 * 1024;

// STRAZ and twelve digits on the parcels the tracker shows; STR and nine
// digits on the former parcel page.
const NUMBER = /^(?:STRAZ\d{12}|STR\d{9})$/;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const CLOCK = /^(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2})$/;
const MAX_SCANS = 200;
const MAX_TEXT = 500;

/** A Starex parcel number; anything else is not one Starex issues. */
export function normalizeStarexNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Starex parcel numbers are STRAZ and twelve digits, or STR and nine');
  return number;
}

/** A scan's `DD-MM-YYYY HH:mm` clock, without a zone. */
function wallClock(value: unknown): string {
  const match = typeof value === 'string' ? CLOCK.exec(value) : null;
  if (!match) throw new SchemaError(PROVIDER, 'Starex returned an invalid scan time');
  const [, day, month, year, hour, minute] = match;
  const local = `${year}-${month}-${day}T${hour}:${minute}:00`;
  // Parsing in UTC checks the calendar digits only; the clock keeps no offset.
  if (DateTime.fromISO(local, { zone: 'UTC' }).toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'Starex returned an invalid scan time');
  }
  return local;
}

/** An optional text; anything but a string or null is a changed reply. */
function text(scan: Record<string, unknown>, key: string): string {
  const value = scan[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' || value.length > MAX_TEXT) throw new SchemaError(PROVIDER, `Starex returned an invalid scan ${key}`);
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * The reply of `/api/v1/starex/packages/{number}/history`: the parcel's
 * scans, each with a status code, the tracking page's title and sentence for
 * it, and a wall clock. The reply does not repeat the number; the lookup is
 * bound to it by its path. The recipient's details, chosen branch and the
 * shop's order number that come with it are not read.
 */
export function parseStarex(payload: unknown, raw: string): CarrierResult {
  normalizeStarexNumber(raw);
  if (!isRecord(payload) || !Array.isArray(payload.data)) throw new SchemaError(PROVIDER, 'Starex returned an invalid envelope');
  const scans = payload.data;
  if (scans.length > MAX_SCANS) throw new SchemaError(PROVIDER, 'Starex returned an oversized history');

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const scan of scans) {
    if (!isRecord(scan) || typeof scan.status !== 'string' || !CODE.test(scan.status)) throw new SchemaError(PROVIDER, 'Starex returned an invalid scan');
    const code = scan.status;
    const local = wallClock(scan.date);
    const title = text(scan, 'name');
    const sentence = text(scan, 'description');
    if (!title && !sentence) throw new SchemaError(PROVIDER, 'Starex returned a scan without wording');
    const description = !title ? sentence : !sentence || sentence === title ? title : `${title}: ${sentence}`;
    const key = JSON.stringify([local, code, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = starexStage(code, description);
    events.push({ local_time: local, description, provider_code: code,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) });
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);

  // Newest first, as the tracking page sorts them; scans on one clock keep the reply's order.
  if (listsNewestFirst(events) === false) events.reverse();
  events.sort((a, b) => String(b.local_time).localeCompare(String(a.local_time)));
  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    events,
  };
}
