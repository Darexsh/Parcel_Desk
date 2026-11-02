import { DateTime } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { egyptPostStage } from './status.js';

export const PROVIDER = 'Egypt Post';
// A reply holds five short rows, under 2 kB.
export const EGYPT_POST_MAX_BYTES = 64_000;

// Egypt Post's domestic layout: three letters, eight digits and EG.
const DOMESTIC = /^[A-Z]{3}\d{8}EG$/;
// The tracker's five steps: registration, shipping, transport and processing, delivery, completion.
const STEPS = 5;
const DATE = /^\d{1,2} [A-Za-z]+ \d{4}$/;
const CLOCK = /^(?:0?[1-9]|1[0-2]):[0-5]\d [AP]M$/i;

/**
 * Egypt Post's tracker looks up its own S10 item codes and those of other
 * posts while the item is in Egypt, and its three-letter domestic codes. An
 * S10 code needs a valid check digit.
 */
export function normalizeEgyptPostNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (DOMESTIC.test(number) || isValidS10TrackingNumber(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Egypt Post tracks S10 item codes and three letters, eight digits and EG');
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 160): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Egypt Post returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * A step's clock, "05 March 2026" and "02:41 PM": the wall clock of the
 * office that scanned the item, which can be abroad, with no zone.
 */
function stepClock(date: string, time: string): string {
  const parsed = DATE.test(date) && CLOCK.test(time)
    ? DateTime.fromFormat(`${date} ${time.toUpperCase()}`, 'd MMMM yyyy h:mm a', { zone: 'UTC', locale: 'en-US' }) : null;
  if (!parsed?.isValid) throw new SchemaError(PROVIDER, 'Egypt Post returned an invalid scan time');
  return parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

/** The office, its town and its country, each once: a scan abroad can name its country alone. */
function place(step: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const part of [text(step, 'location'), text(step, 'city', 80), text(step, 'country', 80)]) {
    if (part && !parts.some((kept) => kept.toLowerCase() === part.toLowerCase())) parts.push(part);
  }
  return parts.join(', ');
}

interface Scan { event: CarrierEvent; step: number }

function projectStep(step: unknown, index: number): Scan | null {
  if (!isRecord(step) || step.status !== index + 1) throw new SchemaError(PROVIDER, 'Egypt Post returned an invalid tracking step');
  const date = text(step, 'date', 40);
  const time = text(step, 'time', 16);
  const wording = text(step, 'itemStatus', 200);
  const summary = text(step, 'mainStatus', 80);
  // A step the item has not reached is empty.
  if (!date && !time && !wording && !summary) return null;
  if (!wording && !summary) throw new SchemaError(PROVIDER, 'Egypt Post returned a scan without wording');
  const local = stepClock(date, time);
  const description = wording || summary;
  const location = place(step);
  const staged = egyptPostStage(wording, summary);
  const event: CarrierEvent = {
    local_time: local,
    ...(location ? { location } : {}),
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { event, step: index + 1 };
}

/**
 * The reply of the tracker's `GetShipmentDetails` for one code. `case` 1 holds
 * the item's five steps, each with the newest scan the item had in it, or
 * nothing; 2 is the tracker's "no tracking data" and 3 its "incorrect number".
 * The reply must name the whole requested code.
 */
export function parseEgyptPost(payload: unknown, raw: string): CarrierResult {
  const number = normalizeEgyptPostNumber(raw);
  if (!isRecord(payload) || typeof payload.success !== 'boolean') throw new SchemaError(PROVIDER, 'Egypt Post returned an invalid reply');
  if (!payload.success) throw new IndeterminateError(PROVIDER, 'Egypt Post did not complete the lookup');
  const data = payload.data;
  if (!isRecord(data) || typeof data.barcode !== 'string') throw new SchemaError(PROVIDER, 'Egypt Post returned an item without its code');
  if (normalizeTrackingNumber(clean(data.barcode, 64)).toUpperCase() !== number) {
    throw new SchemaError(PROVIDER, 'Egypt Post answered for a different item');
  }
  if (data.case === 2) throw new NotFoundError(PROVIDER);
  if (data.case === 3) throw new InvalidInputError(PROVIDER, 'Egypt Post says the number is incorrect', { reason: 'wrong_number' });
  if (data.case !== 1 || !Array.isArray(data.data) || data.data.length !== STEPS) {
    throw new SchemaError(PROVIDER, 'Egypt Post returned invalid tracking steps');
  }

  const scans = data.data.map(projectStep).filter((scan): scan is Scan => scan !== null);
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first by wall clock; at the same minute the later step comes first.
  scans.sort((left, right) => String(right.event.local_time).localeCompare(String(left.event.local_time)) || right.step - left.step);
  const events = scans.map(({ event }) => event);

  const newest = events[0]!;
  const stage = newest.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: newest.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    events,
    // Each step keeps only its newest scan, so the item's other scans are missing.
    history_truncated: true,
  };
}
